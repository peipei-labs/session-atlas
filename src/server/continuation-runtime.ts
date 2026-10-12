import { execFile } from "node:child_process";
import { open, opendir, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { AppError } from "./errors.js";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 2 * 1024 * 1024;
const CWD_SCAN_BYTES = 16 * 1024 * 1024;
const CWD_CHUNK_BYTES = 64 * 1024;

export interface ContinuationRuntime {
  path: string;
  cwd: string;
  state: "idle" | "running" | "unknown";
  turnId?: string;
  turnStartedAt?: string;
  closeProof: { rolloutPath: string; size: number; mtimeNs: string };
}

export function validateConversationId(id: string): void {
  if (!SESSION_ID.test(id)) {
    throw new AppError(400, "INVALID_SESSION_ID", "需要精确的 Codex session ID。");
  }
}

async function findRollout(root: string, id: string): Promise<string[]> {
  const found: string[] = [];
  const pending = [root];
  while (pending.length && found.length < 2) {
    const directory = pending.pop()!;
    let entries;
    try {
      entries = await opendir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for await (const entry of entries) {
      if (entry.isDirectory()) pending.push(join(directory, entry.name));
      else if (entry.isFile() && entry.name.endsWith(`${id}.jsonl`)) {
        found.push(join(directory, entry.name));
      }
    }
  }
  return found;
}

async function readLatestCwd(handle: FileHandle, fileSize: number): Promise<string | undefined> {
  let position = fileSize;
  const stop = Math.max(0, fileSize - CWD_SCAN_BYTES);
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let skip = true; // Discard the unfinished EOF fragment before reading complete records.
  while (position > stop) {
    const length = Math.min(CWD_CHUNK_BYTES, position - stop);
    position -= length;
    const chunk = Buffer.alloc(length);
    const { bytesRead } = await handle.read(chunk, 0, length, position);
    if (bytesRead !== length) {
      throw new AppError(409, "SESSION_RECORD_UNAVAILABLE", "原会话文件正在变化，暂时无法核对工作目录。");
    }
    let end = length;
    for (let index = length - 1; index >= 0; index -= 1) {
      if (chunk[index] !== 0x0a) continue;
      const part = chunk.subarray(index + 1, end);
      if (!skip && part.length + pendingBytes <= CWD_SCAN_BYTES) {
        try {
          const record = JSON.parse(Buffer.concat([part, ...pending.reverse()]).toString("utf8"));
          if (record.type === "turn_context" && typeof record.payload?.cwd === "string") return record.payload.cwd;
        } catch { /* Other incomplete or malformed records provide no cwd evidence. */ }
      }
      pending = [];
      pendingBytes = 0;
      skip = false;
      end = index;
    }
    const leading = chunk.subarray(0, end);
    if (!skip && leading.length + pendingBytes <= CWD_SCAN_BYTES) {
      pending.push(leading);
      pendingBytes += leading.length;
    } else {
      pending = [];
      pendingBytes = 0;
      skip = true;
    }
  }
  if (position > 0) {
    throw new AppError(409, "SESSION_RECORD_UNAVAILABLE", "限定读取范围内无法核对最新工作目录，未执行关闭或恢复。");
  }
  return undefined;
}

export async function readContinuationRuntime(
  codexHome: string,
  sessionId: string,
): Promise<ContinuationRuntime> {
  validateConversationId(sessionId);
  let paths = await findRollout(join(codexHome, "sessions"), sessionId);
  if (!paths.length) paths = await findRollout(join(codexHome, "archived_sessions"), sessionId);
  if (paths.length !== 1) {
    throw new AppError(409, "SESSION_RECORD_UNAVAILABLE", "未找到唯一的原 Codex 会话文件，未执行关闭或恢复。");
  }
  const handle = await open(paths[0]!, "r");
  try {
    const metadata = await handle.stat({ bigint: true });
    const fileSize = Number(metadata.size);
    const head = Buffer.alloc(Math.min(fileSize, HEAD_BYTES));
    await handle.read(head, 0, head.length, 0);
    const newline = head.indexOf(0x0a);
    let first;
    try {
      first = JSON.parse(head.subarray(0, newline >= 0 ? newline : head.length).toString("utf8"));
    } catch {
      throw new AppError(409, "SESSION_RECORD_INVALID", "原会话身份记录暂时无法读取。");
    }
    if (
      first.type !== "session_meta" || first.payload?.id !== sessionId ||
      typeof first.payload.cwd !== "string" || first.payload.source?.subagent
    ) {
      throw new AppError(409, "SESSION_IDENTITY_MISMATCH", "只能登记原始 Codex 线程，不能代替另一个线程或子代理登记。");
    }
    const result: ContinuationRuntime = {
      path: paths[0]!, cwd: first.payload.cwd, state: "unknown",
      closeProof: { rolloutPath: paths[0]!, size: fileSize, mtimeNs: metadata.mtimeNs.toString() },
    };
    const length = Math.min(fileSize, TAIL_BYTES);
    const tail = Buffer.alloc(length);
    await handle.read(tail, 0, length, fileSize - length);
    const lines = tail.toString("utf8").split("\n");
    if (fileSize > length) lines.shift();
    // The final fragment can be a concurrent append; only complete records count.
    const unfinished = lines.pop();
    let hasTurnCwd = false;
    for (const line of lines) {
      let record;
      try { record = JSON.parse(line); } catch { if (line.trim()) result.state = "unknown"; continue; }
      if (record.type === "turn_context" && typeof record.payload?.cwd === "string") {
        result.cwd = record.payload.cwd;
        hasTurnCwd = true;
      }
      if (record.type !== "event_msg") continue;
      const event = record.payload?.type;
      if (event === "task_started") {
        result.state = "running";
        result.turnId = record.payload.turn_id;
        result.turnStartedAt = typeof record.timestamp === "string" ? record.timestamp : undefined;
      } else if (event === "task_complete" || event === "turn_aborted") {
        result.state = "idle";
        result.turnId = record.payload.turn_id ?? result.turnId;
      }
    }
    if (!hasTurnCwd && fileSize > length) result.cwd = await readLatestCwd(handle, fileSize) ?? result.cwd;
    if (unfinished?.trim()) result.state = "unknown";
    const after = await handle.stat({ bigint: true });
    if (after.size !== metadata.size || after.mtimeNs !== metadata.mtimeNs) result.state = "unknown";
    return result;
  } finally {
    await handle.close();
  }
}

export async function rolloutHasWriter(path: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    execFile("/usr/sbin/lsof", ["-Fpa", "--", path], { timeout: 5_000, maxBuffer: 256 * 1024 }, (error, stdout) => {
      if (error && (error as { code?: unknown }).code !== 1) {
        reject(new AppError(503, "WRITER_CHECK_FAILED", "暂时无法核对会话是否仍被其他进程打开。"));
        return;
      }
      resolve(stdout.split("\n").some((line) => line === "aw" || line === "au"));
    });
  });
}
