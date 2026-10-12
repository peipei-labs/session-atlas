import type { RecoveryRecord, SessionSummary } from "../shared/types";
import { threadTagKey } from "../shared/thread-tags";
import { getSavedThreadId } from "./SavedThreadStatus";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export const isThreadTagId = (value: string | undefined): value is string => Boolean(value && UUID.test(value));
export const tagKey = threadTagKey;

export function distinctThreadTags(tags: readonly string[] = []): string[] {
  const result = new Map<string, string>();
  for (const raw of tags) {
    const tag = raw.normalize("NFKC").trim();
    const key = tagKey(tag);
    if (key && !result.has(key)) result.set(key, tag);
  }
  return [...result.values()];
}

export function matchesThreadTags(tags: readonly string[] = [], selected: readonly string[] = []): boolean {
  const available = new Set(tags.map(tagKey));
  return selected.every((tag) => available.has(tagKey(tag)));
}

export function collectThreadTags(sessions: readonly SessionSummary[], records: readonly RecoveryRecord[]) {
  const threads = new Map<string, Map<string, string>>();
  const add = (id: string | undefined, tags: readonly string[] = []) => {
    if (!isThreadTagId(id)) return;
    const key = id.toLocaleLowerCase("en-US");
    const threadTags = threads.get(key) ?? new Map<string, string>();
    for (const tag of distinctThreadTags(tags)) {
      if (!threadTags.has(tagKey(tag))) threadTags.set(tagKey(tag), tag);
    }
    threads.set(key, threadTags);
  };
  for (const record of records) add(record.sessionId, record.tags);
  for (const session of sessions) add(getSavedThreadId(session), session.tags);
  const counts = new Map<string, { tag: string; count: number }>();
  for (const tags of threads.values()) {
    for (const [key, tag] of tags) {
      const item = counts.get(key);
      if (item) item.count += 1;
      else counts.set(key, { tag, count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, "zh-CN"));
}
