import type { ContinuationItem, RecoveryRecord, SessionSummary, UpsertHandoffInput } from "../shared/types";
import { matchesThreadTags } from "./thread-tags-model";

export type SavedThreadView = "continuation" | "reference";
export type SavedThreadLocationGroup = "closed" | "open" | "unknown";

export function savedThreadLocationGroup(record: RecoveryRecord, locations: readonly SessionSummary[]): SavedThreadLocationGroup {
  return locations.length ? "open" : record.status === "active" ? "unknown" : "closed";
}

export const CONTINUATION_KINDS: Record<ContinuationItem["kind"], string> = {
  time: "等时间",
  condition: "等条件",
  input: "待补充要求",
  later: "稍后继续",
};

const shanghaiFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
});

export function formatContinuationTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? shanghaiFormatter.format(date) : "时间待确认";
}

export function toShanghaiInput(value?: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "";
  return new Date(Date.parse(value) + 8 * 60 * 60_000).toISOString().slice(0, 16);
}

export function fromShanghaiInput(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(`${value}:00+08:00`);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

export function continuationDueAt(item: ContinuationItem): number | undefined {
  if (item.kind !== "time" || item.status !== "pending") return undefined;
  const due = item.dueAt ? Date.parse(item.dueAt) : NaN;
  return Number.isFinite(due) ? due : undefined;
}

export function continuationTimeLabel(item: ContinuationItem, now: number): string {
  const due = continuationDueAt(item);
  if (due === undefined) return "时间待确认";
  if (due <= now) return "该核验了";
  const minutes = Math.ceil((due - now) / 60_000);
  if (minutes < 60) return `${minutes} 分钟后核验`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return `${hours} 小时${remaining ? ` ${remaining} 分钟` : ""}后核验`;
}

export function pendingContinuations(records: RecoveryRecord[], now: number, query = ""): RecoveryRecord[] {
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const dueTime = (record: RecoveryRecord) => Math.min(...(record.handoff?.items ?? [])
    .map((item) => continuationDueAt(item))
    .filter((due): due is number => due !== undefined && due <= now));
  return records.filter((record) => {
    const handoff = record.handoff;
    return handoff?.items.some((item) => item.status === "pending") &&
      (!normalizedQuery || [record.projectName, record.cwd, record.sessionId, handoff.summary,
        ...(record.tags ?? []),
        ...handoff.items.flatMap((item) => [item.title, item.nextAction, item.condition ?? ""]),
      ].some((value) => value.toLocaleLowerCase("zh-CN").includes(normalizedQuery)));
  }).sort((left, right) => {
    const leftDue = dueTime(left);
    const rightDue = dueTime(right);
    if (leftDue !== rightDue) return leftDue - rightDue;
    return Date.parse(right.handoff!.updatedAt) - Date.parse(left.handoff!.updatedAt);
  });
}

export function savedReferences(records: RecoveryRecord[], query = ""): RecoveryRecord[] {
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  return records.filter((record) => {
    const reference = record.handoff?.reference;
    return reference && (!normalizedQuery || [reference.title, reference.reason, record.projectName,
      record.cwd, record.sessionId, ...(record.tags ?? [])].some((value) => value.toLocaleLowerCase("zh-CN").includes(normalizedQuery)));
  }).sort((left, right) => Date.parse(right.handoff!.updatedAt) - Date.parse(left.handoff!.updatedAt));
}

export const handoffVersion = (record?: RecoveryRecord): string | null => record?.handoff?.version ?? record?.handoff?.updatedAt ?? null;

export function referenceInput(
  cwd: string, title: string, reason: string, record?: RecoveryRecord,
): UpsertHandoffInput | null {
  if (!cwd.trim().startsWith("/") || !title.trim() || !reason.trim()) return null;
  return {
    expectedVersion: handoffVersion(record),
    cwd: cwd.trim(), summary: record?.handoff?.items.length ? record.handoff.summary : title.trim(),
    items: record?.handoff?.items ?? [], reference: { title: title.trim(), reason: reason.trim() },
    source: "user", requiresRunningProcess: record?.handoff?.requiresRunningProcess,
  };
}

export function endContinuationsInput(record: RecoveryRecord): UpsertHandoffInput {
  return {
    expectedVersion: handoffVersion(record),
    cwd: record.cwd, summary: record.handoff!.summary, source: "user",
    items: record.handoff!.items.map((item) => item.status === "pending" ? { ...item, status: "cancelled" } : item),
    requiresRunningProcess: record.handoff?.requiresRunningProcess,
  };
}

export function removeReferenceInput(record: RecoveryRecord): UpsertHandoffInput {
  return {
    expectedVersion: handoffVersion(record),
    cwd: record.cwd, summary: record.handoff!.summary, source: "user", reference: null,
    items: record.handoff!.items, requiresRunningProcess: record.handoff?.requiresRunningProcess,
  };
}

export function findContinuationSession(sessions: SessionSummary[], sessionId: string): SessionSummary | undefined {
  const matching = sessions.filter((session) => session.conversationId === sessionId && !session.stale);
  return matching.length === 1 ? matching[0] : undefined;
}

export function resolveContinuationTarget(target: string, sessions: SessionSummary[]): string | undefined {
  if (!target.startsWith("iterm:")) return target;
  const terminalId = target.slice("iterm:".length);
  const current = sessions.filter((session) => session.terminalSessionId === terminalId && !session.stale);
  return current.length === 1 ? current[0]?.conversationId : undefined;
}

// Global continuation inbox: every pending item across every saved thread,
// flattened so the rail can answer "what needs me next" without opening cards.
export type ContinuationInboxGroup = "due" | "upcoming" | "later";

export interface ContinuationInboxEntry {
  record: RecoveryRecord;
  item: ContinuationItem;
  dueAt?: number;
  group: ContinuationInboxGroup;
}

export const CONTINUATION_INBOX_GROUPS: readonly { id: ContinuationInboxGroup; title: string }[] = [
  { id: "due", title: "该核验了" },
  { id: "upcoming", title: "即将到期" },
  { id: "later", title: "稍后" },
];

const INBOX_GROUP_RANK: Record<ContinuationInboxGroup, number> = { due: 0, upcoming: 1, later: 2 };

export function continuationInboxEntries(
  records: readonly RecoveryRecord[],
  now: number,
  query = "",
  selectedTags: readonly string[] = [],
): ContinuationInboxEntry[] {
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const entries: ContinuationInboxEntry[] = [];
  for (const record of records) {
    const handoff = record.handoff;
    if (!handoff || !matchesThreadTags(record.tags, selectedTags)) continue;
    for (const item of handoff.items) {
      if (item.status !== "pending") continue;
      if (normalizedQuery && ![
        record.projectName, record.title, record.cwd, record.sessionId, handoff.summary,
        ...(record.tags ?? []), item.title, item.nextAction, item.condition ?? "",
      ].some((value) => value.toLocaleLowerCase("zh-CN").includes(normalizedQuery))) continue;
      const dueAt = continuationDueAt(item);
      entries.push({ record, item, dueAt, group: dueAt === undefined ? "later" : dueAt <= now ? "due" : "upcoming" });
    }
  }
  return entries.sort((left, right) => {
    if (left.group !== right.group) return INBOX_GROUP_RANK[left.group] - INBOX_GROUP_RANK[right.group];
    if (left.group === "later") {
      return Date.parse(right.record.handoff!.updatedAt) - Date.parse(left.record.handoff!.updatedAt);
    }
    return (left.dueAt ?? Number.MAX_SAFE_INTEGER) - (right.dueAt ?? Number.MAX_SAFE_INTEGER);
  });
}

export function groupContinuationInbox(
  entries: readonly ContinuationInboxEntry[],
): { id: ContinuationInboxGroup; title: string; entries: ContinuationInboxEntry[] }[] {
  return CONTINUATION_INBOX_GROUPS
    .map((group) => ({ ...group, entries: entries.filter((entry) => entry.group === group.id) }))
    .filter((group) => group.entries.length > 0);
}

export function completeContinuationInput(record: RecoveryRecord, itemId: string): UpsertHandoffInput {
  return {
    expectedVersion: handoffVersion(record),
    cwd: record.cwd,
    summary: record.handoff!.summary,
    items: record.handoff!.items.map((entry) => entry.id === itemId ? { ...entry, status: "done" } : entry),
    source: "user",
    requiresRunningProcess: record.handoff?.requiresRunningProcess,
  };
}

export function countPendingContinuationItems(records: readonly RecoveryRecord[]): number {
  return records.reduce((count, record) =>
    count + (record.handoff?.items.filter((item) => item.status === "pending").length ?? 0), 0);
}
