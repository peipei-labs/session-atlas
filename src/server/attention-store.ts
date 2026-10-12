import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import type { UpdateAttentionInput, UpdateThreadTagsInput } from "../shared/types.js";
import { applyThreadTagUpdate, normalizeThreadTag, parseThreadTagUpdate, THREAD_TAG_LIMIT, threadTagKey, ThreadTagsValidationError } from "../shared/thread-tags.js";
import { AppError } from "./errors.js";

export interface StoredAttention {
  pinned?: boolean;
  parked?: boolean;
  acknowledgedAt?: string;
  title?: string;
}

interface AttentionStateFile {
  version: 1;
  sessions: Record<string, StoredAttention>;
  threads?: Record<string, { tags: string[] }>;
}

class AttentionStateError extends Error {}

const EMPTY_STATE: AttentionStateFile = {
  version: 1,
  sessions: {},
};

const THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function isStoredThread(value: unknown): value is { tags: string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const tags = (value as { tags?: unknown }).tags;
  if (!Array.isArray(tags) || tags.length > THREAD_TAG_LIMIT) return false;
  try {
    return tags.every((tag) => normalizeThreadTag(tag) === tag)
      && new Set(tags.map(threadTagKey)).size === tags.length;
  } catch { return false; }
}

function isStoredAttention(value: unknown): value is StoredAttention {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    (entry.pinned === undefined || typeof entry.pinned === "boolean") &&
    (entry.parked === undefined || typeof entry.parked === "boolean") &&
    (entry.acknowledgedAt === undefined || typeof entry.acknowledgedAt === "string") &&
    (entry.title === undefined || typeof entry.title === "string")
  );
}

function parseState(contents: string): AttentionStateFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new AttentionStateError("Attention state is not valid JSON.", { cause: error });
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AttentionStateError("Attention state has an invalid shape.");
  }
  const state = parsed as { version?: unknown; sessions?: unknown; threads?: unknown };
  if (
    state.version !== 1 ||
    !state.sessions ||
    typeof state.sessions !== "object" ||
    Array.isArray(state.sessions) ||
    !Object.values(state.sessions).every(isStoredAttention) ||
    (state.threads !== undefined && (!state.threads || typeof state.threads !== "object" || Array.isArray(state.threads)
      || !Object.entries(state.threads).every(([id, thread]) => THREAD_ID_PATTERN.test(id) && isStoredThread(thread))))
  ) {
    throw new AttentionStateError("Attention state has an invalid shape.");
  }

  return {
    version: 1,
    sessions: { ...(state.sessions as Record<string, StoredAttention>) },
    ...(state.threads ? { threads: { ...(state.threads as Record<string, { tags: string[] }>) } } : {}),
  };
}

export class AttentionStore {
  readonly filePath: string;
  #state: AttentionStateFile = { ...EMPTY_STATE, sessions: {} };
  #loaded = false;
  #writeQueue: Promise<void> = Promise.resolve();
  loadWarning: string | undefined;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async load(): Promise<void> {
    if (this.#loaded) {
      return;
    }
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    try {
      this.#state = parseState(await readFile(this.filePath, "utf8"));
      await chmod(this.filePath, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.#state = { ...EMPTY_STATE, sessions: {} };
      } else if (error instanceof AttentionStateError) {
        const quarantinedPath = `${this.filePath}.corrupt-${new Date()
          .toISOString()
          .replaceAll(":", "-")}-${randomUUID()}`;
        await rename(this.filePath, quarantinedPath);
        this.#state = { ...EMPTY_STATE, sessions: {} };
        this.loadWarning = `Invalid attention state was preserved at ${quarantinedPath}`;
      } else {
        throw error;
      }
    }
    this.#loaded = true;
  }

  get(sessionId: string): StoredAttention {
    this.#assertLoaded();
    return { ...this.#state.sessions[sessionId] };
  }

  getThreadTags(sessionId: string): string[] {
    this.#assertLoaded();
    return [...(this.#state.threads?.[sessionId]?.tags ?? [])];
  }

  async updateThreadTags(sessionId: string, input: UpdateThreadTagsInput): Promise<string[]> {
    this.#assertLoaded();
    if (!THREAD_ID_PATTERN.test(sessionId)) throw new AppError(400, "INVALID_SESSION_ID", "标签需要精确的原线程 ID。");
    try {
      const patch = parseThreadTagUpdate(input);
      let tags: string[] = [];
      await this.#enqueue(async () => {
        tags = applyThreadTagUpdate(this.getThreadTags(sessionId), patch);
        const threads = { ...this.#state.threads };
        if (tags.length) threads[sessionId] = { tags };
        else delete threads[sessionId];
        const next: AttentionStateFile = { ...this.#state, threads };
        if (Object.keys(threads).length === 0) delete next.threads;
        await this.#writeAtomic(next);
        this.#state = next;
      });
      return [...tags];
    } catch (error) {
      if (error instanceof ThreadTagsValidationError) throw new AppError(400, "VALIDATION_ERROR", error.message);
      throw error;
    }
  }

  async update(
    sessionId: string,
    input: UpdateAttentionInput,
    now = new Date(),
  ): Promise<StoredAttention> {
    this.#assertLoaded();
    let updated: StoredAttention = {};
    await this.#enqueue(async () => {
      const current = this.#state.sessions[sessionId] ?? {};
      updated = { ...current };
      if (input.pinned !== undefined) {
        updated.pinned = input.pinned;
      }
      if (input.parked !== undefined) {
        updated.parked = input.parked;
      }
      if (input.acknowledge === true) {
        updated.acknowledgedAt = now.toISOString();
      }
      if (input.title !== undefined) {
        const title = input.title.trim();
        if (title) {
          updated.title = title;
        } else {
          delete updated.title;
        }
      }

      const nextSessions = { ...this.#state.sessions };
      if (
        !updated.pinned &&
        !updated.parked &&
        !updated.acknowledgedAt &&
        !updated.title
      ) {
        delete nextSessions[sessionId];
      } else {
        nextSessions[sessionId] = updated;
      }
      const next: AttentionStateFile = { ...this.#state, sessions: nextSessions };
      await this.#writeAtomic(next);
      this.#state = next;
    });
    return { ...updated };
  }

  #assertLoaded(): void {
    if (!this.#loaded) {
      throw new Error("AttentionStore.load() must complete before use.");
    }
  }

  async #enqueue(operation: () => Promise<void>): Promise<void> {
    const pending = this.#writeQueue.then(operation, operation);
    this.#writeQueue = pending.catch(() => undefined);
    return pending;
  }

  async #writeAtomic(next: AttentionStateFile): Promise<void> {
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporaryPath = join(
      directory,
      `.${basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await rename(temporaryPath, this.filePath);
      await chmod(this.filePath, 0o600);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}
