import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

const helper = fileURLToPath(new URL('./handoff.mjs', import.meta.url));
const threadId = '11111111-1111-7111-8111-111111111111';
const input = {
  expectedVersion: null,
  summary: '等待已约定的观察期结束。',
  items: [{ id: 'verify', title: '核验结果', kind: 'time', nextAction: '查看观察结果。', status: 'pending', anchorLabel: '观察开始', anchorAt: '2026-09-09T18:00:00+08:00', delayHours: 24 }],
};

async function fixture(t, handler) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'session-atlas-handoff-test-')));
  const linkedSkillDirectory = join(directory, 'installed handoff skill');
  await symlink(dirname(dirname(helper)), linkedSkillDirectory, 'dir');
  const linkedHelper = join(linkedSkillDirectory, 'scripts', 'handoff.mjs');
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const received = { method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString('utf8') };
    requests.push(received);
    if (handler) handler(received, response);
    else {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ sessionId: threadId, handoff: input }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const processStats = { active: 0, peak: 0, started: 0 };
  async function stop() {
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
  async function start() {
    if (!server.listening) await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  }
  t.after(async () => {
    await stop();
    await rm(directory, { recursive: true, force: true });
  });
  function execute(command, { body, env = {}, holdStdin = false, extraArgs = [], entryPath = helper, cwd = directory } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [entryPath, command, ...extraArgs], {
        cwd,
        env: { ...process.env, CODEX_THREAD_ID: threadId, SESSION_ATLAS_PORT: String(port), ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      processStats.active += 1;
      processStats.started += 1;
      processStats.peak = Math.max(processStats.peak, processStats.active);
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
      child.stdin.on('error', () => {});
      child.on('error', reject);
      child.on('close', (code) => {
        processStats.active -= 1;
        resolve({ code, stdout, stderr });
      });
      if (!holdStdin) child.stdin.end(body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body));
    });
  }
  return { directory, requests, execute, linkedHelper, stop, start, processStats };
}

function storedCardsHandler(cards, beforeResponse) {
  return (request, response) => {
    const sessionId = request.url.split('/').at(-1);
    if (request.method === 'PUT') {
      const { cwd, expectedVersion, reference, ...handoff } = JSON.parse(request.body);
      const savedReference = reference === undefined ? cards.get(sessionId)?.handoff?.reference : reference;
      cards.set(sessionId, { sessionId, cwd, handoff: { ...handoff, ...(savedReference ? { reference: savedReference } : {}) } });
    }
    const card = cards.get(sessionId);
    if (!card) {
      response.writeHead(404);
      response.end();
    } else if (request.method === 'DELETE') {
      delete card.handoff;
      response.writeHead(204);
      response.end();
    } else if (!beforeResponse?.(request, response, card)) {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(card));
    }
  };
}

function storedInput({ expectedVersion, ...handoff }) {
  return { ...handoff, source: 'thread' };
}

function boundedUnicode(length) {
  const text = '中文😀e\u0301\n"\\';
  return text.repeat(Math.floor(length / text.length)) + '文'.repeat(length % text.length);
}

function longUnicodeCard() {
  return {
    expectedVersion: null,
    summary: boundedUnicode(1_000),
    items: Array.from({ length: 20 }, (_, index) => ({
      id: `follow-up-${index}`,
      title: boundedUnicode(200),
      kind: 'condition',
      nextAction: boundedUnicode(1_000),
      status: 'pending',
      condition: boundedUnicode(1_000),
      anchorLabel: boundedUnicode(200),
    })),
  };
}

describe('thread tag helper', { concurrency: 8 }, () => {
  it('reads tags by runtime identity through the installed symlink without accessing handoffs', async (t) => {
    const test = await fixture(t, (_, response) => response.end(JSON.stringify({ sessionId: threadId, tags: ['Python', '账户核对'], private: input })));
    const result = await test.execute('tags', { entryPath: test.linkedHelper });
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), { sessionId: threadId, tags: ['Python', '账户核对'] });
    assert.equal(result.stderr, '');
    assert.deepEqual(test.requests.map(({ method, url, body }) => ({ method, url, body })), [
      { method: 'GET', url: `/api/threads/${threadId}/tags`, body: '' },
    ]);
  });

  it('normalizes a tag delta and reads back additions and removals without replacing concurrent tags', async (t) => {
    let tags = ['用户标签', '旧任务'];
    const test = await fixture(t, (request, response) => {
      if (request.method === 'PATCH') {
        const patch = JSON.parse(request.body);
        const removals = new Set(patch.remove.map((tag) => tag.toLowerCase()));
        tags = [...tags.filter((tag) => !removals.has(tag.toLowerCase())), ...patch.add];
        response.end(JSON.stringify({ sessionId: threadId, tags }));
        tags = [...tags, '手动新增'];
      } else response.end(JSON.stringify({ sessionId: threadId, tags }));
    });
    const result = await test.execute('tag', {
      entryPath: test.linkedHelper,
      body: { add: [' Ｐｙｔｈｏｎ ', 'python', '账户核对', 'e\u0301'], remove: [' 旧任务 '] },
    });
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /已保存线程标签.*用户标签、Python、账户核对、é、手动新增.*已读回核对/u);
    assert.equal(test.requests[0].headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(test.requests[0].body), { add: ['Python', '账户核对', 'é'], remove: ['旧任务'] });
    assert.deepEqual(test.requests.map((request) => request.method), ['PATCH', 'GET']);
    assert.ok(test.requests.every((request) => request.url === `/api/threads/${threadId}/tags`));
  });

  it('can remove the last tag without removing or creating a handoff', async (t) => {
    const test = await fixture(t, (_, response) => response.end(JSON.stringify({ sessionId: threadId, tags: [] })));
    const result = await test.execute('tag', { body: { remove: ['Python'] } });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /已保存线程标签.*暂无标签/u);
    assert.deepEqual(test.requests.map((request) => request.method), ['PATCH', 'GET']);
    assert.deepEqual(JSON.parse(test.requests[0].body), { remove: ['Python'] });
  });

  it('rejects supplied identities and versions, invalid tags and contradictory deltas before sending', async (t) => {
    const test = await fixture(t);
    const invalidInputs = [
      {}, [], null, { add: [] }, { remove: [] }, { add: 'Python' }, { add: [false] },
      { add: [''] }, { add: [' '] }, { add: ['\tPython'] }, { add: ['line\nbreak'] },
      { add: ['hidden\u200b'] }, { add: ['hidden\u202e'] }, { add: ['control\u007f'] }, { add: ['line\u2028break'] }, { add: ['paragraph\u2029break'] },
      { add: ['Ａ'.repeat(41)] }, { add: ['😀'.repeat(41)] }, { add: ['ﬃ'.repeat(14)] },
      { add: Array.from({ length: 13 }, () => 'duplicate') },
      { add: ['Python'], remove: [' ｐｙｔｈｏｎ '] },
      ...['sessionId', 'cwd', 'source', 'expectedVersion', 'tags'].map((key) => ({ add: ['Python'], [key]: 'spoofed' })),
    ];
    for (const body of invalidInputs) {
      const result = await test.execute('tag', { body });
      assert.equal(result.code, 1, JSON.stringify(body));
      assert.equal(result.stdout, '');
    }
    assert.equal(test.requests.length, 0);
  });

  it('accepts twelve tags and forty Unicode code points without truncation', async (t) => {
    const tags = ['😀'.repeat(40), ...Array.from({ length: 11 }, (_, index) => `主题${index}`)];
    const test = await fixture(t, (_, response) => response.end(JSON.stringify({ sessionId: threadId, tags })));
    const result = await test.execute('tag', { body: { add: tags } });
    assert.equal(result.code, 0);
    assert.ok(result.stdout.includes(tags[0]));
    assert.deepEqual(JSON.parse(test.requests[0].body), { add: tags });
    assert.deepEqual(test.requests.map((request) => request.method), ['PATCH', 'GET']);
  });

  it('requires a valid environment identity and loopback port for tag commands', async (t) => {
    const test = await fixture(t);
    for (const command of ['tags', 'tag']) {
      for (const env of [{ CODEX_THREAD_ID: '' }, { CODEX_THREAD_ID: 'other-thread' }, { SESSION_ATLAS_PORT: 'https://example.com' }]) {
        assert.equal((await test.execute(command, { env, body: { add: ['Python'] } })).code, 1);
      }
      assert.equal((await test.execute(command, { extraArgs: [threadId], body: { add: ['Python'] } })).code, 1);
    }
    assert.equal(test.requests.length, 0);
  });

  it('does not interpret an unknown tags endpoint as an empty tag list', async (t) => {
    const test = await fixture(t, (_, response) => {
      response.writeHead(404);
      response.end(JSON.stringify({ error: { code: 'RECOVERY_NOT_FOUND', message: 'private response' } }));
    });
    const result = await test.execute('tags');
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /标签入口/u);
    assert.ok(!result.stderr.includes('private response'));
  });

  it('rejects wrong identities, malformed tag arrays and empty successful responses', async (t) => {
    let value;
    const test = await fixture(t, (_, response) => response.end(typeof value === 'string' ? value : JSON.stringify(value)));
    for (value of [
      '', 'private malformed response', { sessionId: threadId },
      { sessionId: '22222222-2222-7222-8222-222222222222', tags: ['Python'] },
      ...[null, {}, ['Python', 'python'], [' Python '], ['x\u001b[2J'], ['x'.repeat(41)], Array(13).fill('tag')].map((tags) => ({ sessionId: threadId, tags })),
    ]) {
      const result = await test.execute('tag', { body: { add: ['Python'] } });
      assert.equal(result.code, 1);
      assert.equal(result.stdout, '');
      assert.ok(!result.stderr.includes('private malformed response'));
    }
    assert.ok(test.requests.every((request) => request.method === 'PATCH'));
  });

  it('reports an unconfirmed result when read-back does not contain the requested addition or still has a removal', async (t) => {
    let tags;
    const test = await fixture(t, (_, response) => response.end(JSON.stringify({ sessionId: threadId, tags })));
    for (const [body, stored] of [[{ add: ['Python'] }, []], [{ remove: ['Python'] }, ['python']]]) {
      tags = stored;
      const result = await test.execute('tag', { body });
      assert.equal(result.code, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /读回.*不一致.*结果未确认/u);
      assert.ok(!result.stderr.includes('未保存'));
    }
    assert.deepEqual(test.requests.map((request) => request.method), ['PATCH', 'GET', 'PATCH', 'GET']);
  });

  it('does not call a completed tag write unsaved when read-back is rejected', async (t) => {
    const test = await fixture(t, (request, response) => {
      if (request.method === 'PATCH') return response.end(JSON.stringify({ sessionId: threadId, tags: ['Python'] }));
      response.writeHead(403);
      response.end(JSON.stringify({ error: { code: 'SESSION_IDENTITY_MISMATCH', message: 'private read failure' } }));
    });
    const result = await test.execute('tag', { body: { add: ['Python'] } });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /读回核对失败.*结果未确认/u);
    assert.ok(!result.stderr.includes('未保存'));
    assert.ok(!result.stderr.includes('private read failure'));
    assert.deepEqual(test.requests.map((request) => request.method), ['PATCH', 'GET']);
  });

  it('reports allowlisted tag errors without exposing response messages or claiming card failure', async (t) => {
    let code;
    const test = await fixture(t, (_, response) => {
      response.writeHead(409);
      response.end(JSON.stringify({ error: { code, message: 'private secret response' }, private: input }));
    });
    for (code of ['SESSION_RECORD_UNAVAILABLE', 'SESSION_RECORD_INVALID', 'SESSION_IDENTITY_MISMATCH', 'VALIDATION_ERROR', 'INVALID_SESSION_ID', 'HANDOFF_CONFLICT', 'private-code-secret']) {
      const result = await test.execute('tag', { body: { add: ['Python'] } });
      assert.equal(result.code, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /标签/u);
      assert.ok(!result.stderr.includes('交接'));
      assert.ok(!result.stderr.includes('卡片'));
      assert.ok(!result.stderr.includes('private'));
    }
    assert.ok(test.requests.every((request) => request.method === 'PATCH'));
  });

  it('keeps a timed-out tag write unconfirmed and allows one explicit read without repeating PATCH', async (t) => {
    let tags = [];
    const test = await fixture(t, (request, response) => {
      if (request.method === 'PATCH') {
        tags = JSON.parse(request.body).add;
        return;
      }
      response.end(JSON.stringify({ sessionId: threadId, tags }));
    });
    const result = await test.execute('tag', { body: { add: ['Python'] } });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /超时.*未确认成功/u);
    assert.ok(!result.stderr.includes('未保存'));
    assert.equal(test.requests.length, 1);
    const read = await test.execute('tags');
    assert.equal(read.code, 0);
    assert.deepEqual(JSON.parse(read.stdout), { sessionId: threadId, tags: ['Python'] });
    assert.deepEqual(test.requests.map((request) => request.method), ['PATCH', 'GET']);
  });

  it('bounds tag request and response bodies and refuses redirects', async (t) => {
    let redirect = false;
    const test = await fixture(t, (_, response) => {
      if (redirect) {
        response.writeHead(302, { Location: 'http://127.0.0.1:1/redirect-target' });
        response.end();
      } else response.end('x'.repeat(512 * 1024 + 1));
    });
    const oversizedInput = await test.execute('tag', { body: 'x'.repeat(256 * 1024 + 1) });
    assert.equal(oversizedInput.code, 1);
    assert.equal(test.requests.length, 0);
    const oversizedResponse = await test.execute('tags');
    assert.equal(oversizedResponse.code, 1);
    assert.match(oversizedResponse.stderr, /标签响应超过读取限制/u);
    redirect = true;
    assert.equal((await test.execute('tags')).code, 1);
    assert.equal(test.requests.length, 2);
  });
});

describe('handoff helper', { concurrency: 8 }, () => {
  it('writes only stdin content with runtime thread identity, cwd and source', async (t) => {
    const test = await fixture(t);
    const result = await test.execute('write', { body: { ...input, sourceTurnId: 'turn-1', requiresRunningProcess: false } });
    assert.equal(result.code, 0);
    assert.equal(test.requests.length, 1);
    assert.equal(test.requests[0].method, 'PUT');
    assert.equal(test.requests[0].url, `/api/handoffs/${threadId}`);
    assert.equal(test.requests[0].headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(test.requests[0].body), { ...input, sourceTurnId: 'turn-1', requiresRunningProcess: false, cwd: test.directory, source: 'thread' });
    assert.match(result.stdout, /事项 1 项，待续 1 项/u);
    assert.ok(!result.stdout.includes(input.summary));
    assert.equal(result.stderr, '');
  });

  it('returns current handoff to the original thread without unrelated recovery fields', async (t) => {
    const test = await fixture(t, (_, response) => response.end(JSON.stringify({ sessionId: threadId, handoff: input, title: 'unrelated title' })));
    const result = await test.execute('read');
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), { sessionId: threadId, handoff: input, expectedVersion: null });
    assert.equal(test.requests[0].method, 'GET');
    assert.equal(test.requests[0].body, '');
  });

  it('executes read through an installed directory symlink', async (t) => {
    const test = await fixture(t);
    const result = await test.execute('read', { entryPath: test.linkedHelper });
    assert.equal(result.code, 0);
    assert.equal(test.requests.length, 1);
    assert.equal(test.requests[0].method, 'GET');
    assert.deepEqual(JSON.parse(result.stdout), { sessionId: threadId, handoff: input, expectedVersion: null });
    assert.equal(result.stderr, '');
  });

  it('executes write through an installed directory symlink', async (t) => {
    const test = await fixture(t);
    const result = await test.execute('write', { entryPath: test.linkedHelper, body: input });
    assert.equal(result.code, 0);
    assert.equal(test.requests.length, 1);
    assert.equal(test.requests[0].method, 'PUT');
    assert.deepEqual(JSON.parse(test.requests[0].body), { ...input, cwd: test.directory, source: 'thread' });
    assert.match(result.stdout, /已保存待续卡/u);
    assert.equal(result.stderr, '');
  });

  it('propagates read and write failures through an installed directory symlink', async (t) => {
    const test = await fixture(t, (_, response) => { response.writeHead(409); response.end('private response'); });
    for (const command of ['read', 'write']) {
      const result = await test.execute(command, { entryPath: test.linkedHelper, body: input });
      assert.equal(result.code, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /身份或状态/u);
      assert.ok(!result.stderr.includes('private response'));
    }
    assert.deepEqual(test.requests.map((request) => request.method), ['GET', 'PUT']);
  });

  it('does not self-execute when imported as a non-main module through either path', async (t) => {
    const test = await fixture(t);
    const importer = join(test.directory, 'import-only.mjs');
    for (const entryPath of [helper, test.linkedHelper]) {
      await writeFile(importer, `import { run } from ${JSON.stringify(pathToFileURL(entryPath).href)};\nconsole.log(typeof run);\n`);
      const result = await test.execute('read', { entryPath: importer });
      assert.equal(result.code, 0);
      assert.equal(result.stdout, 'function\n');
      assert.equal(result.stderr, '');
    }
    assert.equal(test.requests.length, 0);
  });

  it('represents missing cards as null', async (t) => {
    const test = await fixture(t, (_, response) => { response.writeHead(404); response.end('private error'); });
    const result = await test.execute('read');
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), { sessionId: threadId, handoff: null, expectedVersion: null });
    assert.equal(result.stderr, '');
  });

  it('removes only the current card with DELETE and accepts 204', async (t) => {
    const test = await fixture(t, (_, response) => { response.writeHead(204); response.end(); });
    const result = await test.execute('remove', { body: { expectedVersion: 'read-version' } });
    assert.equal(result.code, 0);
    assert.equal(test.requests[0].method, 'DELETE');
    assert.equal(test.requests[0].url, `/api/handoffs/${threadId}`);
    assert.equal(test.requests[0].headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(test.requests[0].body), { expectedVersion: 'read-version' });
    assert.match(result.stdout, /已移除/u);
  });

  it('reads opaque versions with updatedAt fallback for old cards', async (t) => {
    let handoff;
    const test = await fixture(t, (_, response) => response.end(JSON.stringify({ sessionId: threadId, handoff })));
    for (const [card, expectedVersion] of [
      [{ ...input, version: 'opaque-version', updatedAt: '2026-09-13T12:00:00Z' }, 'opaque-version'],
      [{ ...input, updatedAt: '2026-09-13T12:00:00Z' }, '2026-09-13T12:00:00Z'],
      [undefined, null],
    ]) {
      handoff = card;
      const result = await test.execute('read');
      assert.equal(result.code, 0);
      assert.equal(JSON.parse(result.stdout).expectedVersion, expectedVersion);
    }
  });

  it('rejects missing or invalid expectedVersion before writes or removals reach the service', async (t) => {
    const test = await fixture(t);
    for (const command of ['write', 'remove']) {
      for (const expectedVersion of [undefined, '', ' ', ' version ', 0, {}, [], 'x\0', 'x'.repeat(201)]) {
        const result = await test.execute(command, { body: { ...(command === 'write' ? input : {}), expectedVersion } });
        assert.equal(result.code, 1);
        assert.match(result.stderr, /expectedVersion/u);
      }
    }
    assert.equal((await test.execute('remove', { body: input })).code, 1);
    assert.equal(test.requests.length, 0);
  });

  it('submits the read version unchanged and reports conflicts without fetching or retrying', async (t) => {
    const test = await fixture(t, (request, response) => {
      if (request.method === 'GET') return response.end(JSON.stringify({ sessionId: threadId, handoff: { ...input, version: 'read-version' } }));
      response.writeHead(409);
      response.end(JSON.stringify({ error: { code: 'HANDOFF_CONFLICT', message: 'private updated content' } }));
    });
    const { expectedVersion } = JSON.parse((await test.execute('read')).stdout);
    for (const command of ['write', 'remove']) {
      const result = await test.execute(command, { body: { ...(command === 'write' ? input : {}), expectedVersion } });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /卡片已被更新或移除.*重新读取卡片.*不要盲目重试/u);
      assert.ok(!`${result.stdout}${result.stderr}`.includes('private updated content'));
      assert.equal(JSON.parse(test.requests.at(-1).body).expectedVersion, expectedVersion);
    }
    assert.deepEqual(test.requests.map((request) => request.method), ['GET', 'PUT', 'DELETE']);
  });

  it('rejects missing or invalid CODEX_THREAD_ID before network requests', async (t) => {
    const test = await fixture(t);
    for (const value of ['', 'not-a-thread', '../../other-thread']) {
      const result = await test.execute('read', { env: { CODEX_THREAD_ID: value } });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /CODEX_THREAD_ID/u);
      assert.equal(result.stdout, '');
    }
    assert.equal(test.requests.length, 0);
  });

  it('rejects nonlocal endpoint overrides and command-line content', async (t) => {
    const test = await fixture(t);
    for (const value of ['https://example.com', '4317/path', '65536', '0', '-1']) {
      assert.equal((await test.execute('read', { env: { SESSION_ATLAS_PORT: value } })).code, 1);
    }
    assert.equal((await test.execute('write', { extraArgs: [JSON.stringify(input)] })).code, 1);
    assert.equal(test.requests.length, 0);
  });

  it('rejects caller-supplied identity, unsupported commands and malformed JSON', async (t) => {
    const test = await fixture(t);
    assert.equal((await test.execute('write', { body: { ...input, cwd: '/another-project' } })).code, 1);
    assert.equal((await test.execute('write', { body: { ...input, source: 'manual' } })).code, 1);
    assert.equal((await test.execute('write', { body: 'private invalid JSON' })).code, 1);
    assert.equal((await test.execute('close')).code, 1);
    assert.equal(test.requests.length, 0);
  });

  it('bounds standard input before parsing or contacting the service', async (t) => {
    const test = await fixture(t);
    const result = await test.execute('write', { body: 'x'.repeat(256 * 1024 + 1) });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /256 KiB/u);
    assert.equal(test.requests.length, 0);
  });

  it('rejects duplicate items and timezone-free dates while preserving unknown anchors', async (t) => {
    const test = await fixture(t);
    assert.equal((await test.execute('write', { body: { ...input, items: [input.items[0], input.items[0]] } })).code, 1);
    assert.equal((await test.execute('write', { body: { ...input, items: [{ ...input.items[0], anchorAt: '2026-09-09T18:00:00' }] } })).code, 1);
    const { anchorAt, ...unknownAnchor } = input.items[0];
    const result = await test.execute('write', { body: { ...input, items: [unknownAnchor] } });
    assert.equal(result.code, 0);
    const sent = JSON.parse(test.requests[0].body).items[0];
    assert.equal(sent.anchorAt, undefined);
    assert.equal(sent.dueAt, undefined);
    assert.equal(sent.delayHours, 24);
  });

  it('does not echo response bodies, submitted text or secrets on failure', async (t) => {
    const secret = 'private-server-error-secret';
    const test = await fixture(t, (_, response) => { response.writeHead(409); response.end(JSON.stringify({ error: secret })); });
    const result = await test.execute('write', { body: input });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /身份或状态/u);
    assert.ok(!`${result.stderr}${result.stdout}`.includes(secret));
    assert.ok(!`${result.stderr}${result.stdout}`.includes(input.summary));
  });

  it('explains allowlisted service errors without exposing server messages or retrying', async (t) => {
    let status, code;
    const secret = '\u001b[2Jprivate response with instructions';
    const test = await fixture(t, (_, response) => {
      response.writeHead(status);
      response.end(JSON.stringify({ error: { code, message: secret }, private: input }));
    });
    const cases = [
      [409, 'SESSION_CWD_MISMATCH', /目录.*服务是否已更新/u],
      [409, 'SESSION_RECORD_UNAVAILABLE', /无法取得唯一.*原线程记录/u],
      [409, 'SESSION_RECORD_INVALID', /身份记录格式无效/u],
      [409, 'SESSION_IDENTITY_MISMATCH', /身份不匹配.*回到原线程/u],
      [409, 'HANDOFF_BUSY', /操作尚未结束.*先读取卡片/u],
      [409, 'HANDOFF_CONFLICT', /卡片已被更新或移除.*不要盲目重试/u],
      [400, 'HANDOFF_VERSION_REQUIRED', /expectedVersion.*先读取卡片/u],
      [400, 'INVALID_HANDOFF', /内容未通过服务校验/u],
      [400, 'INVALID_PROJECT_PATH', /工作目录不存在/u],
      [403, 'PROJECT_PATH_FORBIDDEN', /工作目录不在服务允许范围/u],
    ];
    for (const [nextStatus, nextCode, explanation] of cases) {
      status = nextStatus; code = nextCode;
      const result = await test.execute('write', { body: input, entryPath: test.linkedHelper });
      assert.equal(result.code, 1);
      assert.equal(result.stdout, '');
      assert.ok(result.stderr.startsWith(`[${code}] `));
      assert.match(result.stderr, explanation);
      assert.ok(!result.stderr.includes(secret));
      assert.ok(!result.stderr.includes(input.summary));
    }
    assert.equal(test.requests.length, cases.length);
  });

  it('uses safe HTTP fallbacks for unknown, malformed and oversized error bodies', async (t) => {
    let status, responseBody;
    const secret = 'private-unknown-error';
    const test = await fixture(t, (_, response) => { response.writeHead(status); response.end(responseBody); });
    for (const [command, nextStatus, body, expected] of [
      ['read', 404, { error: { code: secret, message: secret } }, /未找到当前线程/u],
      ['write', 409, { error: { code: 'toString', message: secret } }, /身份或状态/u],
      ['write', 409, { error: { code: { injected: secret }, message: secret } }, /身份或状态/u],
      ['write', 500, secret, /HTTP 500/u],
      ['write', 503, secret.padEnd(512 * 1024 + 1, 'x'), /HTTP 503/u],
    ]) {
      status = nextStatus;
      responseBody = typeof body === 'string' ? body : JSON.stringify(body);
      const result = await test.execute(command, { body: input });
      assert.equal(result.code, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, expected);
      assert.ok(!result.stderr.includes(secret));
      assert.ok(!result.stderr.includes('toString'));
    }
    assert.equal(test.requests.length, 5);
  });

  it('treats empty successful write responses as unconfirmed without repeating writes', async (t) => {
    let status = 200;
    const test = await fixture(t, (_, response) => { response.writeHead(status); response.end(); });
    for (status of [200, 204]) {
      const result = await test.execute('write', { body: input });
      assert.equal(result.code, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /未确认成功/u);
      assert.ok(!result.stderr.includes('未保存'));
    }
    assert.deepEqual(test.requests.map((request) => request.method), ['PUT', 'PUT']);
  });

  it('rejects wrong-thread, missing-handoff and malformed success responses', async (t) => {
    let responseBody = { sessionId: '22222222-2222-7222-8222-222222222222', handoff: input };
    const test = await fixture(t, (_, response) => response.end(typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody)));
    assert.equal((await test.execute('write', { body: input })).code, 1);
    responseBody = { sessionId: threadId };
    assert.equal((await test.execute('write', { body: input })).code, 1);
    responseBody = 'private malformed response';
    const result = await test.execute('read');
    assert.equal(result.code, 1);
    assert.ok(!result.stderr.includes(responseBody));
  });

  it('bounds successful response reads', async (t) => {
    const test = await fixture(t, (_, response) => response.end('x'.repeat(512 * 1024 + 1)));
    const result = await test.execute('read');
    assert.equal(result.code, 1);
    assert.match(result.stderr, /超过读取限制/u);
  });

  it('does not follow redirects', async (t) => {
    const test = await fixture(t, (_, response) => { response.writeHead(302, { Location: 'http://127.0.0.1:1/redirect-target' }); response.end(); });
    const result = await test.execute('read');
    assert.equal(result.code, 1);
    assert.equal(test.requests.length, 1);
  });

  it('times out a stalled local service without reporting success', async (t) => {
    const test = await fixture(t, () => {});
    const result = await test.execute('write', { body: input });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /超时/u);
    assert.match(result.stderr, /未确认成功/u);
    assert.ok(!result.stderr.includes('尚未保存'));
    assert.equal(result.stdout, '');
  });

  it('can read back a saved card after a timed-out write without repeating the write', async (t) => {
    let saved;
    const test = await fixture(t, (request, response) => {
      if (request.method === 'PUT') {
        saved = JSON.parse(request.body);
        return;
      }
      response.end(JSON.stringify({ sessionId: threadId, handoff: saved }));
    });
    const writeResult = await test.execute('write', { entryPath: test.linkedHelper, body: input });
    assert.equal(writeResult.code, 1);
    assert.match(writeResult.stderr, /未确认成功/u);
    const readResult = await test.execute('read', { entryPath: test.linkedHelper });
    assert.equal(readResult.code, 0);
    assert.deepEqual(JSON.parse(readResult.stdout).handoff.items, input.items);
    assert.deepEqual(test.requests.map((request) => request.method), ['PUT', 'GET']);
  });

  it('times out incomplete stdin without sending a request', async (t) => {
    const test = await fixture(t);
    const result = await test.execute('write', { holdStdin: true });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /读取交接 JSON 超时/u);
    assert.equal(test.requests.length, 0);
  });

  it('completes a linked CLI lifecycle with repeat registration updating the original card', async (t) => {
    const cards = new Map();
    const test = await fixture(t, storedCardsHandler(cards));
    const options = { entryPath: test.linkedHelper };
    const before = await test.execute('read', options);
    assert.equal(before.code, 0);
    assert.equal(JSON.parse(before.stdout).handoff, null);
    for (let index = 0; index < 3; index += 1) {
      const result = await test.execute('write', { ...options, body: input });
      assert.equal(result.code, 0);
      assert.equal(cards.size, 1);
    }
    const read = await test.execute('read', options);
    assert.equal(read.code, 0);
    assert.deepEqual(JSON.parse(read.stdout).handoff.items, input.items);
    const updated = {
      expectedVersion: null,
      summary: '观察期核验已完成，等待用户补充附件后继续导出。',
      items: [{ ...input.items[0], status: 'done' }, {
        id: 'export', title: '导出附件', kind: 'input', nextAction: '收到附件后继续导出。',
        condition: '等待用户上传附件。', status: 'pending',
      }],
    };
    const write = await test.execute('write', { ...options, body: updated });
    assert.equal(write.code, 0);
    assert.match(write.stdout, /事项 2 项，待续 1 项/u);
    assert.equal(cards.size, 1);
    const readUpdated = await test.execute('read', options);
    assert.equal(readUpdated.code, 0);
    assert.deepEqual(JSON.parse(readUpdated.stdout).handoff, storedInput(updated));
    assert.equal((await test.execute('remove', { ...options, body: { expectedVersion: null } })).code, 0);
    const after = await test.execute('read', options);
    assert.equal(after.code, 0);
    assert.deepEqual(JSON.parse(after.stdout), { sessionId: threadId, handoff: null, expectedVersion: null });
    assert.deepEqual([...cards.keys()], [threadId]);
  });

  it('saves and updates a reference-only card with bounded Unicode text and no follow-up fields', async (t) => {
    const cards = new Map();
    const test = await fixture(t, storedCardsHandler(cards));
    const options = { entryPath: test.linkedHelper };
    const reference = { title: boundedUnicode(200), reason: boundedUnicode(1_000) };
    const payload = { expectedVersion: null, summary: reference.title, items: [], reference };
    const saved = await test.execute('write', { ...options, body: payload });
    assert.equal(saved.code, 0);
    assert.match(saved.stdout, /事项 0 项，待续 0 项，收藏 1 项/u);
    assert.ok(!saved.stdout.includes(reference.title));
    assert.ok(!saved.stdout.includes(reference.reason));
    assert.deepEqual(JSON.parse(test.requests[0].body), { ...payload, cwd: test.directory, source: 'thread' });
    const read = await test.execute('read', options);
    assert.equal(read.code, 0);
    assert.deepEqual(JSON.parse(read.stdout).handoff, storedInput(payload));
    const updated = { ...payload, reference: { title: '接口讨论供以后参考', reason: '用户补充的收藏原因。' } };
    assert.equal((await test.execute('write', { ...options, body: updated })).code, 0);
    assert.equal(cards.size, 1);
    assert.deepEqual(cards.get(threadId).handoff.reference, updated.reference);
    assert.deepEqual(cards.get(threadId).handoff.items, []);
  });

  it('preserves references across old-style item updates and preserves items when cancelling a reference', async (t) => {
    const cards = new Map();
    const test = await fixture(t, storedCardsHandler(cards));
    const options = { entryPath: test.linkedHelper };
    assert.equal((await test.execute('write', { ...options, body: input })).code, 0);
    const existing = JSON.parse((await test.execute('read', options)).stdout).handoff;
    const reference = { title: '观察与核验方法', reason: '用户要求把讨论留作后续项目参考。' };
    assert.equal((await test.execute('write', { ...options, body: { expectedVersion: null, summary: existing.summary, items: existing.items, reference } })).code, 0);
    assert.deepEqual(cards.get(threadId).handoff.items, input.items);
    const completed = { ...input, items: input.items.map((item) => ({ ...item, status: 'done' })) };
    assert.equal((await test.execute('write', { ...options, body: completed })).code, 0);
    assert.ok(!Object.hasOwn(JSON.parse(test.requests.at(-1).body), 'reference'));
    const afterCompletion = JSON.parse((await test.execute('read', options)).stdout).handoff;
    assert.deepEqual(afterCompletion.reference, reference);
    assert.deepEqual(afterCompletion.items, completed.items);
    assert.equal((await test.execute('write', { ...options, body: input })).code, 0);
    const beforeCancel = JSON.parse((await test.execute('read', options)).stdout).handoff;
    assert.equal((await test.execute('write', { ...options, body: { expectedVersion: null, summary: beforeCancel.summary, items: beforeCancel.items, reference: null } })).code, 0);
    assert.equal(JSON.parse(test.requests.at(-1).body).reference, null);
    const afterCancel = JSON.parse((await test.execute('read', options)).stdout).handoff;
    assert.deepEqual(afterCancel.items, input.items);
    assert.equal(afterCancel.reference, undefined);
    assert.ok(test.requests.every((request) => request.method !== 'DELETE'));
  });

  it('rejects malformed or oversized references before changing an existing card', async (t) => {
    const cards = new Map();
    const test = await fixture(t, storedCardsHandler(cards));
    const options = { entryPath: test.linkedHelper };
    const reference = { title: '保留原来的收藏', reason: '用户明确要求保留。' };
    const payload = { ...input, reference };
    assert.equal((await test.execute('write', { ...options, body: payload })).code, 0);
    for (const invalid of [
      '', false, [], {}, { title: '缺少原因' }, { title: ' ', reason: '原因' },
      { title: '标题', reason: '' }, { title: '标题', reason: 123 },
      { title: '题'.repeat(201), reason: '原因' }, { title: '标题', reason: '原'.repeat(1_001) },
      { title: '标题\0', reason: '原因' }, { title: '标题', reason: '原因', id: 'unsupported' },
    ]) {
      const result = await test.execute('write', { ...options, body: { ...payload, reference: invalid } });
      assert.equal(result.code, 1);
      assert.equal(result.stdout, '');
    }
    assert.equal(test.requests.length, 1);
    const read = await test.execute('read', options);
    assert.equal(read.code, 0);
    assert.deepEqual(JSON.parse(read.stdout).handoff, storedInput(payload));
  });

  it('removes both reference and continuation only through an explicit whole-card remove', async (t) => {
    const cards = new Map();
    const test = await fixture(t, storedCardsHandler(cards));
    const options = { entryPath: test.linkedHelper };
    const reference = { title: '同时保留的参考', reason: '用户决定与待续事项一起移除。' };
    assert.equal((await test.execute('write', { ...options, body: { ...input, reference } })).code, 0);
    assert.equal((await test.execute('remove', { ...options, body: { expectedVersion: null } })).code, 0);
    const read = await test.execute('read', options);
    assert.equal(read.code, 0);
    assert.equal(JSON.parse(read.stdout).handoff, null);
    assert.deepEqual(test.requests.map((request) => request.method), ['PUT', 'DELETE', 'GET']);
  });

  it('round-trips twenty maximum-length Unicode items without truncating UTF-8 chunks', async (t) => {
    const cards = new Map();
    const test = await fixture(t, storedCardsHandler(cards, (request, response, card) => {
      if (request.method !== 'GET') return false;
      const bytes = Buffer.from(JSON.stringify(card));
      response.setHeader('Content-Type', 'application/json');
      response.setHeader('Transfer-Encoding', 'chunked');
      for (let offset = 0; offset < bytes.length; offset += 17) response.write(bytes.subarray(offset, offset + 17));
      response.end();
      return true;
    }));
    const payload = longUnicodeCard();
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    assert.ok(bytes > 64 * 1024 && bytes < 256 * 1024);
    const write = await test.execute('write', { entryPath: test.linkedHelper, body: payload });
    assert.equal(write.code, 0);
    assert.match(write.stdout, /事项 20 项，待续 20 项/u);
    assert.ok(!write.stdout.includes(payload.summary));
    const read = await test.execute('read', { entryPath: test.linkedHelper });
    assert.equal(read.code, 0);
    assert.deepEqual(JSON.parse(read.stdout).handoff, storedInput(payload));
    assert.deepEqual(JSON.parse(test.requests[0].body), { ...payload, cwd: test.directory, source: 'thread' });
    t.diagnostic(`Unicode payload ${bytes} bytes; 20 complete items, chunked response preserved.`);
  });

  it('keeps a previously saved card after an over-limit Unicode update or a twenty-first item', async (t) => {
    const cards = new Map();
    const test = await fixture(t, storedCardsHandler(cards));
    const options = { entryPath: test.linkedHelper };
    const payload = longUnicodeCard();
    assert.equal((await test.execute('write', { ...options, body: payload })).code, 0);
    for (const invalid of [
      { ...payload, items: payload.items.map((item, index) => index === 19 ? { ...item, nextAction: `${item.nextAction}界` } : item) },
      { ...payload, items: [...payload.items, { ...payload.items[0], id: 'twenty-first' }] },
    ]) {
      const failed = await test.execute('write', { ...options, body: invalid });
      assert.equal(failed.code, 1);
      assert.equal(failed.stdout, '');
      assert.equal(test.requests.length, 1);
    }
    const read = await test.execute('read', options);
    assert.equal(read.code, 0);
    assert.deepEqual(JSON.parse(read.stdout).handoff, storedInput(payload));
  });

  it('reads a saved card after a dropped connection and loopback service restart without rewriting', async (t) => {
    const cards = new Map();
    const test = await fixture(t, storedCardsHandler(cards, (request, response) => {
      if (request.method !== 'PUT') return false;
      response.destroy();
      return true;
    }));
    const options = { entryPath: test.linkedHelper };
    const write = await test.execute('write', { ...options, body: input });
    assert.equal(write.code, 1);
    assert.equal(write.stdout, '');
    assert.match(write.stderr, /未确认成功/u);
    assert.equal(cards.size, 1);
    await test.stop();
    const offlineRead = await test.execute('read', options);
    assert.equal(offlineRead.code, 1);
    assert.equal(offlineRead.stdout, '');
    await test.start();
    const read = await test.execute('read', options);
    assert.equal(read.code, 0);
    assert.deepEqual(JSON.parse(read.stdout).handoff.items, input.items);
    assert.deepEqual(test.requests.map((request) => request.method), ['PUT', 'GET']);
  });

  it('keeps twenty concurrent thread identities and project paths separate across 120 CLI operations', async (t) => {
    const cards = new Map();
    const test = await fixture(t, storedCardsHandler(cards));
    const projects = await Promise.all(Array.from({ length: 20 }, async (_, index) => {
      const cwd = join(test.directory, `项目 ${index}`);
      await mkdir(cwd);
      return { cwd, sessionId: `22222222-2222-7222-8222-${String(index).padStart(12, '0')}`, index };
    }));
    await Promise.all(projects.map(async ({ cwd, sessionId, index }) => {
      const options = { entryPath: test.linkedHelper, env: { CODEX_THREAD_ID: sessionId }, cwd };
      const payload = { expectedVersion: null, summary: `线程 ${index} 的工作。`, items: [{ ...input.items[0], id: `verify-${index}`, title: `核验线程 ${index}` }] };
      assert.equal((await test.execute('write', { ...options, body: payload })).code, 0);
      const read = await test.execute('read', options);
      assert.equal(read.code, 0);
      assert.deepEqual(JSON.parse(read.stdout), { sessionId, handoff: storedInput(payload), expectedVersion: null });
      const updated = { ...payload, items: [{ ...payload.items[0], status: 'done' }] };
      assert.equal((await test.execute('write', { ...options, body: updated })).code, 0);
      const updatedRead = await test.execute('read', options);
      assert.equal(updatedRead.code, 0);
      assert.deepEqual(JSON.parse(updatedRead.stdout), { sessionId, handoff: storedInput(updated), expectedVersion: null });
      assert.equal(cards.get(sessionId).cwd, cwd);
      assert.equal((await test.execute('remove', { ...options, body: { expectedVersion: null } })).code, 0);
      const removedRead = await test.execute('read', options);
      assert.equal(removedRead.code, 0);
      assert.deepEqual(JSON.parse(removedRead.stdout), { sessionId, handoff: null, expectedVersion: null });
    }));
    assert.equal(cards.size, 20);
    assert.ok([...cards.values()].every((card) => !card.handoff));
    assert.equal(test.requests.length, 120);
    assert.equal(test.processStats.started, 120);
    assert.equal(test.processStats.active, 0);
    assert.equal(test.processStats.peak, 20);
    for (const { sessionId } of projects) {
      assert.deepEqual(test.requests.filter((request) => request.url.endsWith(sessionId)).map((request) => request.method), ['PUT', 'GET', 'PUT', 'GET', 'DELETE', 'GET']);
    }
    t.diagnostic(`Completed ${test.processStats.started} CLI operations with a peak of ${test.processStats.peak} concurrent processes.`);
  });
});
