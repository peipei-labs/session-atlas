#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const TIMEOUT_MS = 5_000;
const MAX_TAGS = 12;
const MAX_TAG_LENGTH = 40;
const SERVICE_ERRORS = new Map([
  ['SESSION_CWD_MISMATCH', '登记目录与原线程记录不一致；本次交接未保存。请检查 Session Atlas 服务是否已更新。'],
  ['SESSION_RECORD_UNAVAILABLE', '暂时无法取得唯一且可核验的原线程记录；本次交接未保存。请检查原线程记录是否可读取。'],
  ['SESSION_RECORD_INVALID', '原线程身份记录格式无效或无法解析；本次交接未保存。请检查原线程记录。'],
  ['SESSION_IDENTITY_MISMATCH', '原线程身份不匹配，或当前是子代理；本次交接未保存。请回到原线程执行，不要手填线程身份。'],
  ['HANDOFF_BUSY', '这个线程的卡片或恢复操作尚未结束；本次交接未保存。等待操作结束后，先读取卡片再合并本次变化。'],
  ['HANDOFF_CONFLICT', '卡片已被更新或移除；本次操作未保存。请重新读取卡片，合并本次意图，不要盲目重试。'],
  ['HANDOFF_VERSION_REQUIRED', '缺少有效的 expectedVersion；本次交接未保存。请先读取卡片并提交对应版本，没有卡片时提交 null。'],
  ['INVALID_HANDOFF', '交接内容未通过服务校验；本次交接未保存。请检查字段和时间依据。'],
  ['INVALID_PROJECT_PATH', '原线程工作目录不存在或不是有效目录；本次交接未保存。请检查原线程目录。'],
  ['PROJECT_PATH_FORBIDDEN', '原线程工作目录不在服务允许范围内，或被列为只读；本次交接未保存。请检查服务的目录配置。'],
]);
const TAG_SERVICE_ERRORS = new Map([
  ['SESSION_RECORD_UNAVAILABLE', '暂时无法取得可核验的原线程记录；本次标签修改未保存。请检查原线程记录是否可读取。'],
  ['SESSION_RECORD_INVALID', '原线程记录格式无效或无法解析；本次标签修改未保存。'],
  ['SESSION_IDENTITY_MISMATCH', '当前身份不是可核验的原线程；本次标签修改未保存。请回到原线程执行。'],
  ['VALIDATION_ERROR', '标签未通过服务校验；本次标签修改未保存。请检查数量、长度和增删内容。'],
  ['INVALID_SESSION_ID', '线程身份格式无效；本次标签修改未保存。请从当前原线程执行。'],
]);

class HandoffError extends Error {}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(value, keys) {
  if (!record(value) || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new HandoffError('交接 JSON 含不支持的字段；请只提交交接内容，身份由运行环境提供。');
  }
}

function textField(value, maxLength, optional = false) {
  if (value === undefined && optional) return;
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > maxLength) {
    throw new HandoffError('交接文字为空、类型错误或超过长度限制。');
  }
}

function normalizedTags(value) {
  if (!Array.isArray(value)) throw new HandoffError('标签必须为文字数组。');
  if (value.length > MAX_TAGS) throw new HandoffError('每个线程最多 12 个标签；请先读取已有标签。');
  const tags = [];
  const keys = new Set();
  for (const raw of value) {
    if (typeof raw !== 'string' || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(raw)) {
      throw new HandoffError('标签必须为文字，不能包含控制字符或不可见格式字符。');
    }
    const tag = raw.normalize('NFKC').trim();
    if (!tag || [...tag].length > MAX_TAG_LENGTH) {
      throw new HandoffError('每个标签必须为 1 至 40 个字符。');
    }
    const key = tag.toLowerCase();
    if (keys.has(key)) continue;
    keys.add(key);
    tags.push(tag);
  }
  return tags;
}

function validateTagInput(value) {
  if (!record(value) || Object.keys(value).some((key) => !['add', 'remove'].includes(key))) {
    throw new HandoffError('标签 JSON 只接受 add、remove；身份由 CODEX_THREAD_ID 提供，不接受 sessionId、cwd、source 或 expectedVersion。');
  }
  const patch = {};
  if (value.add !== undefined) patch.add = normalizedTags(value.add);
  if (value.remove !== undefined) patch.remove = normalizedTags(value.remove);
  if (!patch.add?.length && !patch.remove?.length) throw new HandoffError('请至少新增或移除一个标签。');
  const removals = new Set(patch.remove?.map((tag) => tag.toLowerCase()));
  if (patch.add?.some((tag) => removals.has(tag.toLowerCase()))) {
    throw new HandoffError('同一个标签不能同时新增和移除。');
  }
  return patch;
}

function validateTagResponse(value, sessionId) {
  try {
    if (!record(value) || value.sessionId !== sessionId) throw new Error();
    const tags = normalizedTags(value.tags);
    if (tags.length !== value.tags.length || tags.some((tag, index) => tag !== value.tags[index])) throw new Error();
    return { sessionId, tags };
  } catch {
    throw new HandoffError('本机服务返回的标签身份或内容不匹配；本次标签保存结果未确认。');
  }
}

function validateInput(value, command) {
  onlyKeys(value, command === 'remove' ? ['expectedVersion'] : ['expectedVersion', 'summary', 'items', 'sourceTurnId', 'requiresRunningProcess', 'reference']);
  if (value.expectedVersion !== null && (typeof value.expectedVersion !== 'string'
    || !value.expectedVersion || value.expectedVersion.trim() !== value.expectedVersion
    || value.expectedVersion.includes('\0') || value.expectedVersion.length > 200)) {
    throw new HandoffError('expectedVersion 必须是本次读取返回的版本字符串或 null；请先读取卡片并合并本次变化。');
  }
  if (command === 'remove') return value;
  textField(value.summary, 1_000);
  textField(value.sourceTurnId, 200, true);
  if (value.reference !== undefined && value.reference !== null) {
    onlyKeys(value.reference, ['title', 'reason']);
    textField(value.reference.title, 200);
    textField(value.reference.reason, 1_000);
  }
  if (value.requiresRunningProcess !== undefined && typeof value.requiresRunningProcess !== 'boolean') {
    throw new HandoffError('requiresRunningProcess 必须为布尔值。');
  }
  if (!Array.isArray(value.items) || value.items.length > 20) {
    throw new HandoffError('每张交接卡最多 20 项；完成事项请更新状态。');
  }
  const ids = new Set();
  for (const item of value.items) {
    onlyKeys(item, ['id', 'title', 'kind', 'nextAction', 'status', 'condition', 'anchorLabel', 'anchorAt', 'delayHours', 'dueAt']);
    textField(item.id, 100);
    if (ids.has(item.id)) throw new HandoffError('事项 id 不能重复。');
    ids.add(item.id);
    textField(item.title, 200);
    textField(item.nextAction, 1_000);
    textField(item.condition, 1_000, true);
    textField(item.anchorLabel, 200, true);
    if (!['time', 'condition', 'input', 'later'].includes(item.kind)
      || !['pending', 'done', 'cancelled'].includes(item.status)) {
      throw new HandoffError('事项分类或状态无效。');
    }
    for (const field of ['anchorAt', 'dueAt']) {
      if (item[field] !== undefined && (typeof item[field] !== 'string'
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(item[field])
        || !Number.isFinite(Date.parse(item[field])))) {
        throw new HandoffError('绝对时间必须是带明确时区的有效 ISO 时间。');
      }
    }
    if (item.delayHours !== undefined && (typeof item.delayHours !== 'number'
      || !Number.isFinite(item.delayHours) || item.delayHours < 0)) {
      throw new HandoffError('等待时长必须为非负的小时数。');
    }
  }
  return value;
}

async function readInput(stream, command) {
  const subject = command === 'tag' ? '标签' : '交接';
  const chunks = [];
  let size = 0;
  const timer = setTimeout(() => stream.destroy(new HandoffError(`读取${subject} JSON 超时；尚未保存。`)), TIMEOUT_MS);
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_INPUT_BYTES) throw new HandoffError(`${subject} JSON 超过 256 KiB；请缩短内容。`);
      chunks.push(bytes);
    }
    let value;
    try {
      value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new HandoffError(`标准输入不是有效的${subject} JSON。`);
    }
    return command === 'tag' ? validateTagInput(value) : validateInput(value, command);
  } finally {
    clearTimeout(timer);
  }
}

async function readResponse(response, subject = '交接') {
  if (!response.body) throw new HandoffError(`本机服务未返回有效的${subject}记录；此次操作未确认成功。`);
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new HandoffError(`本机服务的${subject}响应超过读取限制；此次操作未确认成功。`);
      }
      chunks.push(Buffer.from(value));
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new HandoffError(`本机服务未返回有效的${subject}记录；此次操作未确认成功。`);
    }
  } finally {
    reader.releaseLock();
  }
}

function httpError(statusCode, errorCode, isTags = false) {
  if (isTags) {
    const explanation = TAG_SERVICE_ERRORS.get(errorCode);
    if (explanation) return `[${errorCode}] ${explanation}`;
    if (statusCode === 400) return '标签未通过服务校验；本次标签修改未保存。请检查数量、长度和增删内容。';
    if (statusCode === 403) return '本机服务拒绝了此次标签请求。';
    if (statusCode === 404) return '服务未找到当前线程或标签入口；请确认 Session Atlas 已更新且能识别该线程。';
    if (statusCode === 409) return '当前线程状态不允许修改标签；本次标签修改未保存。请先读取已有标签。';
    return `本机服务返回 HTTP ${statusCode}；本次标签保存结果未确认。`;
  }
  const explanation = SERVICE_ERRORS.get(errorCode);
  if (explanation) return `[${errorCode}] ${explanation}`;
  if (statusCode === 400) return '交接内容未通过服务校验；请检查字段和时间依据。';
  if (statusCode === 403) return '本机服务拒绝了此次交接请求。';
  if (statusCode === 404) return '服务未找到当前线程；请确认本机 Session Atlas 已更新且能识别该线程。';
  if (statusCode === 409) return '当前线程身份或状态不允许保存；请在 Session Atlas 检查关联情况。';
  return `本机服务返回 HTTP ${statusCode}；此次操作未确认成功。`;
}

export async function run({ args = process.argv.slice(2), env = process.env, cwd = process.cwd(), stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    if (args.length !== 1 || !['read', 'write', 'remove', 'tags', 'tag'].includes(args[0])) {
      throw new HandoffError('用法：handoff.mjs read | write | remove | tags | tag；write、remove 和 tag 从标准输入读取 JSON。');
    }
    const command = args[0];
    const sessionId = env.CODEX_THREAD_ID;
    if (typeof sessionId !== 'string' || !UUID.test(sessionId)) {
      throw new HandoffError('缺少有效的 CODEX_THREAD_ID；请从当前 Codex 原线程运行，不要手填其他线程身份。');
    }
    const portText = env.SESSION_ATLAS_PORT ?? '4317';
    if (!/^\d{1,5}$/u.test(portText) || Number(portText) < 1 || Number(portText) > 65_535) {
      throw new HandoffError('SESSION_ATLAS_PORT 必须是 1 至 65535 的数字端口。');
    }
    const isTags = command === 'tags' || command === 'tag';
    const input = command === 'read' || command === 'tags' ? undefined : await readInput(stdin, command);
    if (isTags) {
      const tagUrl = `http://127.0.0.1:${Number(portText)}/api/threads/${sessionId}/tags`;
      const requestTags = async (patch) => {
        const response = await fetch(tagUrl, {
          method: patch ? 'PATCH' : 'GET',
          headers: patch ? { 'Content-Type': 'application/json' } : undefined,
          body: patch ? JSON.stringify(patch) : undefined,
          redirect: 'error',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!response.ok) {
          const failure = await readResponse(response, '标签').catch(() => undefined);
          throw new HandoffError(httpError(response.status, typeof failure?.error?.code === 'string' ? failure.error.code : undefined, true));
        }
        return validateTagResponse(await readResponse(response, '标签'), sessionId);
      };
      const result = await requestTags(input);
      if (command === 'tags') {
        stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        let verified;
        try {
          verified = await requestTags();
        } catch {
          throw new HandoffError('标签写入已返回，但读回核对失败；本次标签保存结果未确认。请保留现有标签，不要盲目重复写入。');
        }
        const savedKeys = new Set(verified.tags.map((tag) => tag.toLowerCase()));
        if (input.add?.some((tag) => !savedKeys.has(tag.toLowerCase()))
          || input.remove?.some((tag) => savedKeys.has(tag.toLowerCase()))) {
          throw new HandoffError('读回的线程标签与本次增删不一致；本次标签保存结果未确认。请保留现有标签，不要盲目重复写入。');
        }
        stdout.write(`已保存线程标签：${sessionId}；${verified.tags.length ? verified.tags.join('、') : '暂无标签'}（已读回核对）。\n`);
      }
      return 0;
    }
    const response = await fetch(`http://127.0.0.1:${Number(portText)}/api/handoffs/${sessionId}`, {
      method: command === 'read' ? 'GET' : command === 'write' ? 'PUT' : 'DELETE',
      headers: input ? { 'Content-Type': 'application/json' } : undefined,
      body: input ? JSON.stringify(command === 'write' ? { ...input, cwd, source: 'thread' } : input) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      const failure = await readResponse(response).catch(() => undefined);
      const errorCode = typeof failure?.error?.code === 'string' ? failure.error.code : undefined;
      if (command === 'read' && response.status === 404 && (errorCode === undefined || errorCode === 'RECOVERY_NOT_FOUND')) {
        stdout.write(`${JSON.stringify({ sessionId, handoff: null, expectedVersion: null })}\n`);
        return 0;
      }
      throw new HandoffError(httpError(response.status, errorCode));
    }
    if (command === 'remove') {
      await response.body?.cancel();
      stdout.write(`已移除会话卡：${sessionId}\n`);
      return 0;
    }
    const recovery = await readResponse(response);
    if (!record(recovery) || recovery.sessionId !== sessionId
      || (recovery.handoff !== undefined && (!record(recovery.handoff) || !Array.isArray(recovery.handoff.items)))) {
      throw new HandoffError('本机服务返回的交接身份或内容不匹配；此次操作未确认成功。');
    }
    if (command === 'read') {
      stdout.write(`${JSON.stringify({ sessionId, handoff: recovery.handoff ?? null, expectedVersion: recovery.handoff?.version ?? recovery.handoff?.updatedAt ?? null }, null, 2)}\n`);
    } else {
      if (!recovery.handoff) throw new HandoffError('本机服务未返回已保存的交接卡；此次操作未确认成功。');
      const pendingCount = recovery.handoff.items.filter((item) => item.status === 'pending').length;
      const hasReference = Boolean(recovery.handoff.reference);
      stdout.write(`已保存${hasReference ? '会话卡' : '待续卡'}：${sessionId}；事项 ${recovery.handoff.items.length} 项，待续 ${pendingCount} 项${hasReference ? '，收藏 1 项' : ''}。\n`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof HandoffError ? error.message
      : error?.name === 'TimeoutError' || error?.name === 'AbortError'
        ? '连接本机 Session Atlas 超时；此次操作未确认成功。'
        : '无法连接本机 Session Atlas；请确认本机服务已启动，此次操作未确认成功。';
    stderr.write(`${message}\n`);
    return 1;
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.exitCode = await run();
}
