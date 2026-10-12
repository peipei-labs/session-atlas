import { describe, expect, it } from "vitest";

import type { ContinuationItem, RecoveryRecord } from "../shared/types";
import {
  CONTINUATION_INBOX_GROUPS,
  completeContinuationInput,
  continuationInboxEntries,
  countPendingContinuationItems,
  groupContinuationInbox,
} from "./continuation-model";

const NOW = Date.parse("2026-09-17T04:00:00.000Z");
const HOUR = 3_600_000;

function makeItem(id: string, overrides: Partial<ContinuationItem> = {}): ContinuationItem {
  return {
    id,
    title: `事项 ${id}`,
    kind: "later",
    nextAction: `继续 ${id}`,
    status: "pending",
    ...overrides,
  };
}

function makeRecord(
  sessionId: string,
  items: ContinuationItem[],
  overrides: Partial<RecoveryRecord> = {},
): RecoveryRecord {
  return {
    sessionId,
    cwd: `/Users/demo/Code/${sessionId}`,
    title: `线程 ${sessionId}`,
    projectName: `项目-${sessionId}`,
    status: "closed",
    firstSeenAt: "2026-09-10T02:00:00.000Z",
    lastSeenAt: "2026-09-16T02:00:00.000Z",
    closedAt: "2026-09-16T03:00:00.000Z",
    resumeCommand: `codex resume ${sessionId}`,
    handoff: {
      summary: `摘要 ${sessionId}`,
      items,
      updatedAt: "2026-09-16T03:00:00.000Z",
      source: "user",
      version: `v-${sessionId}`,
    },
    ...overrides,
  };
}

function timed(id: string, dueAt: number): ContinuationItem {
  return makeItem(id, { kind: "time", dueAt: new Date(dueAt).toISOString() });
}

describe("continuationInboxEntries", () => {
  it("flattens pending items across records and assigns groups", () => {
    const records = [
      makeRecord("a", [timed("a-due", NOW - HOUR)]),
      makeRecord("b", [timed("b-upcoming", NOW + 2 * HOUR)]),
      makeRecord("c", [makeItem("c-later"), makeItem("c-done", { status: "done" })]),
    ];
    const entries = continuationInboxEntries(records, NOW);
    expect(entries.map((entry) => entry.item.id)).toEqual(["a-due", "b-upcoming", "c-later"]);
    expect(entries.map((entry) => entry.group)).toEqual(["due", "upcoming", "later"]);
  });

  it("sorts due and upcoming by dueAt ascending, later by handoff updatedAt descending", () => {
    const records = [
      makeRecord("a", [timed("a-due-late", NOW - HOUR), timed("a-due-early", NOW - 3 * HOUR)]),
      makeRecord("b", [timed("b-up-late", NOW + 3 * HOUR), timed("b-up-early", NOW + HOUR)]),
      makeRecord("c", [makeItem("c-later-old")]),
      makeRecord("d", [makeItem("d-later-new")], {
        handoff: {
          summary: "摘要 d", items: [makeItem("d-later-new")],
          updatedAt: "2026-09-17T01:00:00.000Z", source: "user",
        },
      }),
    ];
    const entries = continuationInboxEntries(records, NOW);
    expect(entries.map((entry) => entry.item.id)).toEqual([
      "a-due-early", "a-due-late", "b-up-early", "b-up-late", "d-later-new", "c-later-old",
    ]);
  });

  it("treats unanchored time items as later", () => {
    const records = [makeRecord("a", [makeItem("a-time-unanchored", { kind: "time" })])];
    const entries = continuationInboxEntries(records, NOW);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ group: "later", dueAt: undefined });
  });

  it("matches the query against record and item fields, case-insensitively", () => {
    const records = [
      makeRecord("a", [makeItem("a-1", { title: "修复蜂巢渲染" })]),
      makeRecord("b", [makeItem("b-1", { condition: "等 CI 通过", kind: "condition" })]),
      makeRecord("c", [makeItem("c-1")], { projectName: "Session-Atlas" }),
    ];
    expect(continuationInboxEntries(records, NOW, "蜂巢").map((entry) => entry.item.id)).toEqual(["a-1"]);
    expect(continuationInboxEntries(records, NOW, "ci").map((entry) => entry.item.id)).toEqual(["b-1"]);
    expect(continuationInboxEntries(records, NOW, "session-atlas").map((entry) => entry.item.id)).toEqual(["c-1"]);
    expect(continuationInboxEntries(records, NOW, "摘要 b").map((entry) => entry.item.id)).toEqual(["b-1"]);
    expect(continuationInboxEntries(records, NOW, "不存在")).toEqual([]);
  });

  it("filters records by selected tags with AND semantics", () => {
    const records = [
      makeRecord("a", [makeItem("a-1")], { tags: ["前端", "蜂巢"] }),
      makeRecord("b", [makeItem("b-1")], { tags: ["前端"] }),
      makeRecord("c", [makeItem("c-1")]),
    ];
    expect(continuationInboxEntries(records, NOW, "", ["前端"]).map((entry) => entry.item.id)).toEqual(["a-1", "b-1"]);
    expect(continuationInboxEntries(records, NOW, "", ["前端", "蜂巢"]).map((entry) => entry.item.id)).toEqual(["a-1"]);
    expect(continuationInboxEntries(records, NOW, "", ["后端"])).toEqual([]);
  });

  it("skips records without a handoff or without pending items", () => {
    const records = [
      { ...makeRecord("a", []), handoff: undefined },
      makeRecord("b", [makeItem("b-done", { status: "done" }), makeItem("b-cancelled", { status: "cancelled" })]),
    ];
    expect(continuationInboxEntries(records, NOW)).toEqual([]);
  });
});

describe("groupContinuationInbox", () => {
  it("buckets entries in canonical order and drops empty groups", () => {
    const records = [
      makeRecord("a", [makeItem("a-later")]),
      makeRecord("b", [timed("b-due", NOW - HOUR)]),
    ];
    const groups = groupContinuationInbox(continuationInboxEntries(records, NOW));
    expect(groups.map((group) => group.id)).toEqual(["due", "later"]);
    expect(groups[0]?.entries.map((entry) => entry.item.id)).toEqual(["b-due"]);
    expect(groups[1]?.entries.map((entry) => entry.item.id)).toEqual(["a-later"]);
  });

  it("returns an empty list when nothing is pending", () => {
    expect(groupContinuationInbox([])).toEqual([]);
    expect(CONTINUATION_INBOX_GROUPS.map((group) => group.title)).toEqual(["该核验了", "即将到期", "稍后"]);
  });
});

describe("completeContinuationInput", () => {
  it("marks only the target item done and preserves the rest of the handoff", () => {
    const record = makeRecord("a", [
      timed("a-due", NOW - HOUR),
      makeItem("a-later"),
    ], {
      handoff: {
        summary: "摘要 a",
        items: [timed("a-due", NOW - HOUR), makeItem("a-later")],
        reference: { title: "参考", reason: "可能有用" },
        updatedAt: "2026-09-16T03:00:00.000Z",
        source: "thread",
        version: "v-a",
        requiresRunningProcess: true,
      },
    });
    const input = completeContinuationInput(record, "a-due");
    expect(input).toMatchObject({
      expectedVersion: "v-a",
      cwd: record.cwd,
      summary: "摘要 a",
      source: "user",
      requiresRunningProcess: true,
    });
    expect(input.items.map((item) => [item.id, item.status])).toEqual([["a-due", "done"], ["a-later", "pending"]]);
    // 完成单项不动收藏：reference 不传（undefined 表示保持现状）。
    expect(input.reference).toBeUndefined();
  });
});

describe("countPendingContinuationItems", () => {
  it("counts pending items, not records", () => {
    const records = [
      makeRecord("a", [makeItem("a-1"), makeItem("a-2"), makeItem("a-done", { status: "done" })]),
      makeRecord("b", [makeItem("b-1")]),
      { ...makeRecord("c", []), handoff: undefined },
    ];
    expect(countPendingContinuationItems(records)).toBe(3);
    expect(countPendingContinuationItems([])).toBe(0);
  });
});
