import type { UpdateThreadTagsInput } from "./types.js";

export const THREAD_TAG_LIMIT = 12;
export const THREAD_TAG_MAX_LENGTH = 40;

export class ThreadTagsValidationError extends Error {}

export function normalizeThreadTag(value: unknown): string {
  if (typeof value !== "string" || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value)) {
    throw new ThreadTagsValidationError("标签必须是文本，且不能含控制字符。");
  }
  const tag = value.normalize("NFKC").trim();
  if (!tag || [...tag].length > THREAD_TAG_MAX_LENGTH) {
    throw new ThreadTagsValidationError(`每个标签需包含 1 到 ${THREAD_TAG_MAX_LENGTH} 个字符。`);
  }
  return tag;
}

export function threadTagKey(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

export function parseThreadTagUpdate(value: unknown): UpdateThreadTagsInput {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => key !== "add" && key !== "remove")) {
    throw new ThreadTagsValidationError("标签修改只接受 add 和 remove 两个数组。");
  }
  const input = value as Record<string, unknown>;
  const parseList = (field: "add" | "remove") => {
    if (!(field in input)) return [];
    const list = input[field];
    if (!Array.isArray(list) || list.length > THREAD_TAG_LIMIT) {
      throw new ThreadTagsValidationError(`每次 ${field} 最多接受 ${THREAD_TAG_LIMIT} 个标签。`);
    }
    const tags = new Map<string, string>();
    for (const value of list) {
      const tag = normalizeThreadTag(value);
      if (!tags.has(threadTagKey(tag))) tags.set(threadTagKey(tag), tag);
    }
    return [...tags.values()];
  };
  const add = parseList("add");
  const remove = parseList("remove");
  if (add.length === 0 && remove.length === 0) {
    throw new ThreadTagsValidationError("请至少添加或删除一个标签。");
  }
  const removed = new Set(remove.map(threadTagKey));
  if (add.some((tag) => removed.has(threadTagKey(tag)))) {
    throw new ThreadTagsValidationError("同一个标签不能同时添加和删除。");
  }
  return { ...(add.length ? { add } : {}), ...(remove.length ? { remove } : {}) };
}

export function applyThreadTagUpdate(current: readonly string[], input: UpdateThreadTagsInput): string[] {
  const patch = parseThreadTagUpdate(input);
  const removed = new Set(patch.remove?.map(threadTagKey));
  const tags = new Map<string, string>();
  for (const tag of [...current, ...(patch.add ?? [])]) {
    const key = threadTagKey(tag);
    if (!removed.has(key) && !tags.has(key)) tags.set(key, tag);
  }
  if (tags.size > THREAD_TAG_LIMIT) {
    throw new ThreadTagsValidationError(`每个线程最多保留 ${THREAD_TAG_LIMIT} 个标签。`);
  }
  return [...tags.values()];
}
