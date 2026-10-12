import { createReadStream } from "node:fs";
import { open, opendir, stat } from "node:fs/promises";
import { join } from "node:path";

import type { RecoveryPreview } from "../shared/types.js";

const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const ROLLOUT_SESSION_ID_PATTERN =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu;
const MAX_PREVIEW_LENGTH = 280;
const TAIL_CHUNK_BYTES = 64 * 1024;
const MAX_ROLLOUT_RECORD_BYTES = 2 * 1024 * 1024;
const MAX_PREVIEW_SCAN_BYTES = 16 * 1024 * 1024;
const PREVIEW_READ_CONCURRENCY = 4;
const MAX_CACHE_ENTRIES = 512;

interface PreviewCacheEntry {
  size: number;
  mtimeMs: number;
  preview: Omit<RecoveryPreview, "sessionId">;
}

const previewCache = new Map<string, PreviewCacheEntry>();

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Recovery preview request was aborted");
  error.name = "AbortError";
  throw error;
}

function textContent(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const content = value as Record<string, unknown>;
  if (
    (content.type === "input_text" || content.type === "text") &&
    typeof content.text === "string"
  ) {
    return content.text;
  }
  return undefined;
}

function userMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.type !== "response_item") return undefined;
  const payload = record.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const message = payload as Record<string, unknown>;
  if (message.type !== "message" || message.role !== "user" || !Array.isArray(message.content)) {
    return undefined;
  }
  const text = message.content
    .map(textContent)
    .filter((item): item is string => Boolean(item))
    .join("\n")
    .trim();
  return text || undefined;
}

function isInjectedContext(text: string): boolean {
  const normalized = text.trimStart();
  return (
    normalized.startsWith("# AGENTS.md instructions") ||
    normalized.startsWith("<environment_context>") ||
    normalized.startsWith("<skills_instructions>") ||
    normalized.startsWith("<permissions instructions>") ||
    normalized.startsWith("<collaboration_mode>")
  );
}

function excerpt(text: string): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (normalized.length <= MAX_PREVIEW_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_PREVIEW_LENGTH - 1).trimEnd()}…`;
}

async function findRolloutFiles(
  root: string,
  requestedIds: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const directories = [root];
  while (directories.length > 0 && result.size < requestedIds.size) {
    throwIfAborted(signal);
    const directory = directories.pop();
    if (!directory) break;
    let entries;
    try {
      entries = await opendir(directory);
    } catch {
      continue;
    }
    for await (const entry of entries) {
      throwIfAborted(signal);
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const sessionId = ROLLOUT_SESSION_ID_PATTERN.exec(entry.name)?.[1];
      if (sessionId && requestedIds.has(sessionId) && !result.has(sessionId)) {
        result.set(sessionId, path);
      }
    }
  }
  return result;
}

function previewFromLine(line: string): string | undefined {
  let message: string | undefined;
  try {
    message = userMessage(JSON.parse(line));
  } catch {
    return undefined;
  }
  if (!message || isInjectedContext(message)) return undefined;
  return excerpt(message) || undefined;
}

async function readFirstRequest(path: string, signal?: AbortSignal): Promise<string | undefined> {
  const input = createReadStream(path, { start: 0, end: MAX_PREVIEW_SCAN_BYTES - 1 });
  let pendingLineChunks: Buffer[] = [];
  let pendingLineBytes = 0;
  let oversizedLine = false;
  try {
    for await (const chunk of input) {
      throwIfAborted(signal);
      const contents = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let lineStart = 0;
      for (let index = 0; index < contents.length; index += 1) {
        if (contents[index] !== 0x0a) continue;
        const currentPart = contents.subarray(lineStart, index);
        if (!oversizedLine && pendingLineBytes + currentPart.length <= MAX_ROLLOUT_RECORD_BYTES) {
          const line = pendingLineChunks.length > 0
            ? Buffer.concat([...pendingLineChunks, currentPart])
            : currentPart;
          const preview = previewFromLine(line.toString("utf8"));
          if (preview) return preview;
        }
        pendingLineChunks = [];
        pendingLineBytes = 0;
        oversizedLine = false;
        lineStart = index + 1;
      }
      const trailing = contents.subarray(lineStart);
      if (!oversizedLine && trailing.length > 0) {
        if (pendingLineBytes + trailing.length > MAX_ROLLOUT_RECORD_BYTES) {
          pendingLineChunks = [];
          pendingLineBytes = 0;
          oversizedLine = true;
        } else {
          pendingLineChunks.push(trailing);
          pendingLineBytes += trailing.length;
        }
      }
    }
    if (!oversizedLine && pendingLineChunks.length > 0) {
      return previewFromLine(Buffer.concat(pendingLineChunks).toString("utf8"));
    }
    return undefined;
  } finally {
    input.destroy();
  }
}

async function readLatestRequest(
  path: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const handle = await open(path, "r");
  let pendingLineChunks: Buffer[] = [];
  let pendingLineBytes = 0;
  let oversizedLine = false;
  try {
    const openedMetadata = await handle.stat();
    let position = openedMetadata.size;
    let scannedBytes = 0;
    while (position > 0 && scannedBytes < MAX_PREVIEW_SCAN_BYTES) {
      throwIfAborted(signal);
      const length = Math.min(
        TAIL_CHUNK_BYTES,
        position,
        MAX_PREVIEW_SCAN_BYTES - scannedBytes,
      );
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      scannedBytes += length;
      if (bytesRead === 0) break;
      const contents = chunk.subarray(0, bytesRead);
      let lineEnd = contents.length;
      for (let index = contents.length - 1; index >= 0; index -= 1) {
        if (contents[index] !== 0x0a) continue;
        const currentPart = contents.subarray(index + 1, lineEnd);
        if (!oversizedLine && pendingLineBytes + currentPart.length <= MAX_ROLLOUT_RECORD_BYTES) {
          const line = pendingLineChunks.length > 0
            ? Buffer.concat([currentPart, ...pendingLineChunks])
            : currentPart;
          const preview = previewFromLine(line.toString("utf8"));
          if (preview) return preview;
        }
        pendingLineChunks = [];
        pendingLineBytes = 0;
        oversizedLine = false;
        lineEnd = index;
      }
      const leading = contents.subarray(0, lineEnd);
      if (!oversizedLine && leading.length > 0) {
        if (pendingLineBytes + leading.length > MAX_ROLLOUT_RECORD_BYTES) {
          pendingLineChunks = [];
          pendingLineBytes = 0;
          oversizedLine = true;
        } else {
          pendingLineChunks.unshift(leading);
          pendingLineBytes += leading.length;
        }
      }
    }
    if (!oversizedLine && pendingLineChunks.length > 0) {
      return previewFromLine(Buffer.concat(pendingLineChunks).toString("utf8"));
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

function cachePreview(path: string, entry: PreviewCacheEntry): void {
  if (!previewCache.has(path) && previewCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = previewCache.keys().next().value as string | undefined;
    if (oldest) previewCache.delete(oldest);
  }
  previewCache.delete(path);
  previewCache.set(path, entry);
}

async function readPreview(
  sessionId: string,
  path: string | undefined,
  signal?: AbortSignal,
): Promise<RecoveryPreview> {
  if (!path) {
    return { sessionId, status: "missing" };
  }
  try {
    throwIfAborted(signal);
    const metadata = await stat(path);
    const cached = previewCache.get(path);
    if (cached?.size === metadata.size && cached.mtimeMs === metadata.mtimeMs) {
      return { sessionId, ...cached.preview };
    }
    const [firstRequest, latestRequest] = await Promise.all([
      readFirstRequest(path, signal),
      readLatestRequest(path, signal),
    ]);
    const preview: Omit<RecoveryPreview, "sessionId"> =
      firstRequest && latestRequest
        ? { status: "available", firstRequest, latestRequest }
        : { status: "missing" };
    cachePreview(path, { size: metadata.size, mtimeMs: metadata.mtimeMs, preview });
    return { sessionId, ...preview };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { sessionId, status: "missing" };
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await task(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function readRecoveryPreviews(
  codexHome: string,
  sessionIds: readonly string[],
  signal?: AbortSignal,
): Promise<RecoveryPreview[]> {
  throwIfAborted(signal);
  const validIds = sessionIds.filter((sessionId) => SESSION_ID_PATTERN.test(sessionId));
  const requested = new Set(validIds);
  const activeFiles = await findRolloutFiles(join(codexHome, "sessions"), requested, signal);
  const stillMissing = new Set(validIds.filter((sessionId) => !activeFiles.has(sessionId)));
  const archivedFiles = stillMissing.size
    ? await findRolloutFiles(join(codexHome, "archived_sessions"), stillMissing, signal)
    : new Map<string, string>();
  return await mapWithConcurrency(
    sessionIds,
    PREVIEW_READ_CONCURRENCY,
    (sessionId) => readPreview(
      sessionId,
      activeFiles.get(sessionId) ?? archivedFiles.get(sessionId),
      signal,
    ),
  );
}
