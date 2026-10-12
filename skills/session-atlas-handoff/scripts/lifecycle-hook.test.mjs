import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { lifecycleContext, run } from './lifecycle-hook.mjs';

for (const input of [
  { hook_event_name: 'SessionStart', source: 'resume' },
  { hook_event_name: 'SessionStart', source: 'compact' },
  { hook_event_name: 'UserPromptSubmit' },
]) {
  test(`${input.hook_event_name} ${input.source ?? ''} supplies context without requesting another turn`, () => {
    const result = lifecycleContext(input);
    assert.deepEqual(Object.keys(result), ['hookSpecificOutput']);
    assert.deepEqual(Object.keys(result.hookSpecificOutput), ['hookEventName', 'additionalContext']);
    assert.equal(result.hookSpecificOutput.hookEventName, input.hook_event_name);
    assert.ok(result.hookSpecificOutput.additionalContext.length > 0);
  });
}

test('only subscribed lifecycle events get a reminder', () => {
  for (const input of [null, [], {}, { hook_event_name: 'Stop' }, { hook_event_name: 'SessionEnd' },
    { hook_event_name: 'SessionStart', source: 'startup' }, { hook_event_name: 'SessionStart' }]) {
    assert.deepEqual(lifecycleContext(input), {});
  }
});

test('CLI output never contains hook prompts, transcripts, paths, or user-controlled context', () => {
  const secret = 'private-prompt-sentinel-987';
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./lifecycle-hook.mjs', import.meta.url))], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: secret, cwd: secret, transcript_path: secret }),
    encoding: 'utf8',
  });
  assert.equal(child.status, 0);
  assert.equal(child.stderr, '');
  assert.equal(child.stdout.includes(secret), false);
  assert.deepEqual(JSON.parse(child.stdout), lifecycleContext({ hook_event_name: 'UserPromptSubmit' }));
});

test('malformed and oversized payloads do not block the user or leak input', async () => {
  for (const input of ['broken-json-private', JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'x'.repeat(1024 * 1024) })]) {
    let output = '';
    const status = await run({ stdin: Readable.from([input]), stdout: new Writable({ write(chunk, _, callback) { output += chunk; callback(); } }) });
    assert.equal(status, 0);
    assert.deepEqual(JSON.parse(output), {});
  }
});
