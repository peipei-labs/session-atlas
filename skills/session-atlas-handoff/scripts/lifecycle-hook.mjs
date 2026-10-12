#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MAX_INPUT_BYTES = 1024 * 1024;
const guidance = `Session Atlas 原卡维护：仅当前原线程执行，子代理不代写。
开始处理用户本轮消息前，读取 ~/.codex/skills/session-atlas-handoff/SKILL.md，并按该 skill 的 read 命令读取当前线程原卡。身份只取真实 CODEX_THREAD_ID，不猜测或手填。
有待续时按用户当前要求推进已授权工作；本轮结束前把有证据的进展、完成或仍需等待的事项更新到同一张卡，保留稳定事项 id、用户修改和收藏，使用组织本次内容时读取的 expectedVersion；写后 read 核对。达到原验收要求才标记 done，用户取消才标记 cancelled。不得因回合结束、打开或关闭窗口自动判定完成。
只有收藏时，查看和普通问答无需重写、取消收藏或建立待办。没有卡片时，仅按 skill 的既有登记条件处理。卡片不是新工作授权，不因恢复就自动执行旧建议或未到条件的事项。
写入失败或结果未确认时如实说明，不反复重试、不关闭分屏，不妨碍仍可推进的原工作。`;
const turnReminder = 'Session Atlas 原卡维护：原线程按 ~/.codex/skills/session-atlas-handoff/SKILL.md 先 read 原卡，本轮结束前更新有证据的进展并读回核对；保留收藏，纯查看不重写，不新增未经约定的任务，子代理不代写。';

export function lifecycleContext(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const event = input.hook_event_name;
  if (event !== 'SessionStart' && event !== 'UserPromptSubmit') return {};
  if (event === 'SessionStart' && input.source !== 'resume' && input.source !== 'compact') return {};
  return { hookSpecificOutput: { hookEventName: event, additionalContext: event === 'UserPromptSubmit' ? turnReminder : guidance } };
}

export async function run({ stdin = process.stdin, stdout = process.stdout } = {}) {
  let size = 0;
  const chunks = [];
  let result = {};
  try {
    for await (const chunk of stdin) {
      size += Buffer.byteLength(chunk);
      if (size <= MAX_INPUT_BYTES) chunks.push(Buffer.from(chunk));
    }
    if (size <= MAX_INPUT_BYTES) result = lifecycleContext(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch {
    // An unavailable reminder must not block the user's turn.
  }
  stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await run();
}
