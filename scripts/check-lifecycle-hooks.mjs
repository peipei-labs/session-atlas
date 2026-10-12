import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const configPath = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('./session-atlas-lifecycle.toml', import.meta.url));
const override = (await readFile(configPath, 'utf8')).trim();
const directory = await mkdtemp(join(tmpdir(), 'session-atlas-hook-contract-'));
const userConfig = `check_for_update_on_startup = false
developer_instructions = "keep-existing-instructions"
[features]
apps = false
remote_plugin = false
[[hooks.SessionStart]]
matcher = "^resume$"
[[hooks.SessionStart.hooks]]
type = "command"
command = "printf unrelated-user-hook"
timeout = 2
`;
let child;
let timeout;
try {
  const configFile = join(directory, 'config.toml');
  await writeFile(configFile, userConfig);
  child = spawn('codex', ['app-server', '--stdio', '-c', override], {
    cwd: directory,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: directory, TMPDIR: tmpdir(), TERM: 'dumb' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let sequence = 0;
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(`${request.method}: ${message.error.message}`));
    else request.resolve(message.result);
  });
  const rejectPending = (error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  child.on('error', rejectPending);
  child.on('exit', (code) => rejectPending(new Error(`Hook contract process exited (${code})`)));
  timeout = setTimeout(() => {
    rejectPending(new Error('Hook contract check timed out'));
    child.kill('SIGTERM');
  }, 10000);
  const request = (method, params) => {
    assert(['initialize', 'hooks/list', 'config/read'].includes(method));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { method, resolve, reject });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  };
  await request('initialize', { clientInfo: { name: 'session-atlas-hook-contract', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  child.stdin.write('{"method":"initialized"}\n');
  const listing = await request('hooks/list', { cwds: [directory] });
  assert.equal(listing.data.length, 1);
  assert.deepEqual(listing.data[0].errors, []);
  const hooks = listing.data[0].hooks;
  const owned = hooks.filter((hook) => hook.source === 'sessionFlags');
  assert.equal(owned.length, 2);
  assert.deepEqual(owned.map((hook) => hook.eventName).sort(), ['sessionStart', 'userPromptSubmit']);
  for (const hook of owned) {
    assert.equal(hook.trustStatus, 'trusted');
    assert.equal(hook.enabled, true);
    assert.equal(hook.isManaged, false);
    assert.equal(hook.command, 'node "$HOME/.codex/skills/session-atlas-handoff/scripts/lifecycle-hook.mjs"');
    assert.equal(hook.timeoutSec, 2);
    assert.match(hook.currentHash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(hook.matcher, hook.eventName === 'sessionStart' ? '^(resume|compact)$' : null);
  }
  const existing = hooks.filter((hook) => hook.source === 'user');
  assert.equal(existing.length, 1);
  assert.equal(existing[0].command, 'printf unrelated-user-hook');
  assert.equal(existing[0].trustStatus, 'untrusted');
  const { config } = await request('config/read', { includeLayers: false, cwd: directory });
  assert.equal(config.developer_instructions, 'keep-existing-instructions');
  assert.equal(await readFile(configFile, 'utf8'), userConfig);
  process.stdout.write('Lifecycle hooks: both session hooks trusted; existing hooks and instructions preserved. No thread or model requests.\n');
} finally {
  clearTimeout(timeout);
  if (child?.pid && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.stdin.end();
    const stop = setTimeout(() => child.kill('SIGTERM'), 1000);
    await exited;
    clearTimeout(stop);
  }
  await rm(directory, { recursive: true, force: true });
}
