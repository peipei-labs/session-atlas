import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ContinuationItem, RecoveryRecord, UpsertHandoffInput } from "../shared/types";
import { ContinuationInbox, InboxRow } from "./ContinuationInbox";

Object.assign(globalThis, { React });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const now = Date.parse("2026-09-17T04:00:00.000Z");
const HOUR = 3_600_000;

function makeItem(id: string, overrides: Partial<ContinuationItem> = {}): ContinuationItem {
  return { id, title: `事项 ${id}`, kind: "later", nextAction: `继续 ${id}`, status: "pending", ...overrides };
}

function timed(id: string, dueAt: number): ContinuationItem {
  return makeItem(id, {
    kind: "time", dueAt: new Date(dueAt).toISOString(),
    anchorLabel: `锚点 ${id}`, anchorAt: new Date(dueAt - 2 * HOUR).toISOString(),
  });
}

function makeRecord(sessionId: string, items: ContinuationItem[], overrides: Partial<RecoveryRecord> = {}): RecoveryRecord {
  return {
    sessionId, cwd: `/Users/demo/Code/${sessionId}`, title: `线程 ${sessionId}`, projectName: `项目-${sessionId}`,
    status: "closed", firstSeenAt: "2026-09-10T02:00:00.000Z", lastSeenAt: "2026-09-16T02:00:00.000Z",
    closedAt: "2026-09-16T03:00:00.000Z", resumeCommand: `codex resume ${sessionId}`,
    handoff: { summary: `摘要 ${sessionId}`, items, updatedAt: "2026-09-16T03:00:00.000Z", source: "user", version: `v-${sessionId}` },
    ...overrides,
  };
}

function renderInbox(records: RecoveryRecord[], extra = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  return renderToStaticMarkup(<ContinuationInbox records={records} sessions={[]} canUseIterm busyId={null}
    onSave={async () => true} onResume={async () => "restored"} onOpenCard={() => {}} {...extra} />);
}

type TestElement = React.ReactElement<{ children?: React.ReactNode; type?: string; className?: string; disabled?: boolean;
  "data-inbox-group"?: string; "data-item-id"?: string; entry?: { item: { id: string } };
  onClick?: () => void; onComplete?: () => void; onToggle?: () => void }>;
const elements = (node: React.ReactNode): TestElement[] => React.Children.toArray(node).flatMap((child) =>
  React.isValidElement(child) ? [child as TestElement, ...elements((child as TestElement).props.children)] : []);
function hookRenderer(slots: unknown[] = []) {
  return <T,>(render: () => T): T => {
    let index = 0;
    const internals = (React as unknown as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown } }).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    const previous = internals.H;
    internals.H = {
      useState: (initial: unknown) => {
        const slot = index++;
        if (!(slot in slots)) slots[slot] = typeof initial === "function" ? initial() : initial;
        return [slots[slot], (next: unknown) => { slots[slot] = typeof next === "function" ? next(slots[slot]) : next; }];
      },
      useRef: (initial: unknown) => slots[index++] ??= { current: initial }, useEffect: () => {},
      useCallback: (callback: unknown) => callback,
      useMemo: (factory: () => unknown) => factory(), useDeferredValue: (value: unknown) => value,
    };
    try { return render(); } finally { internals.H = previous; }
  };
}

const rows = (tree: React.ReactNode) => elements(tree).filter((node) => node.type === InboxRow) as unknown as
  React.ReactElement<React.ComponentProps<typeof InboxRow>>[];

const demoRecords = () => [
  makeRecord("a", [timed("a-due", now - HOUR)]),
  makeRecord("b", [timed("b-upcoming", now + 2 * HOUR)]),
  makeRecord("c", [makeItem("c-later"), makeItem("c-input", { kind: "input" })]),
];

describe("ContinuationInbox", () => {
  it("renders every group with counts, kind chips, parent threads, and due labels", () => {
    const markup = renderInbox(demoRecords());

    expect(markup).toContain('data-testid="continuation-inbox"');
    expect(markup).toContain('data-inbox-group="due"');
    expect(markup).toContain('data-inbox-group="upcoming"');
    expect(markup).toContain('data-inbox-group="later"');
    expect(markup).toContain("该核验了");
    expect(markup).toContain("即将到期");
    expect(markup).toContain("事项 a-due");
    expect(markup).toContain("项目-a · 线程 a");
    expect(markup).toContain("2 小时后核验");
    expect(markup).toContain('class="inbox-due is-due"');
    expect(markup).toContain("等时间");
    expect(markup).toContain("稍后继续");
    expect(markup).toContain("待补充要求");
    // 行默认收起：详情区的「下一步」与锚点信息不出现。
    expect(markup).not.toContain("下一步");
    expect(markup).not.toContain("起算：");
  });

  it("shows the right empty state with and without filters", () => {
    expect(renderInbox([])).toContain("当前没有待续事项");
    expect(renderInbox([])).toContain("$session-atlas-handoff");
    expect(renderInbox(demoRecords(), { query: "不存在" })).toContain("没有匹配的待续事项");
    expect(renderInbox(demoRecords(), { selectedTags: ["后端"] })).toContain("没有匹配的待续事项");
    expect(renderInbox(demoRecords(), { query: "不存在" })).not.toContain("$session-atlas-handoff");
  });

  it("disables completion while busy", () => {
    const markup = renderInbox(demoRecords(), { busyId: "save" });
    expect(markup).toMatch(/disabled="" class="continuation-complete"/);
  });

  it("completes an item through onSave and announces it", async () => {
    const render = hookRenderer(), onSave = vi.fn(async (_sessionId: string, _input: UpsertHandoffInput) => true);
    const record = makeRecord("a", [timed("a-due", now - HOUR), makeItem("a-later")]);
    const draw = () => render(() => ContinuationInbox({ records: [record], sessions: [], canUseIterm: true, busyId: null,
      onSave, onResume: async () => "restored", onOpenCard: () => {} }));

    rows(draw()).find((row) => row.props.entry.item.id === "a-due")!.props.onComplete();
    await Promise.resolve();

    expect(onSave).toHaveBeenCalledTimes(1);
    const [sessionId, input] = onSave.mock.calls[0]!;
    expect(sessionId).toBe("a");
    expect(input.expectedVersion).toBe("v-a");
    expect(input.items.map((item: ContinuationItem) => [item.id, item.status])).toEqual([["a-due", "done"], ["a-later", "pending"]]);
    expect(renderToStaticMarkup(draw())).toContain("已完成：事项 a-due");
  });

  it("expands a row to show the full detail and opens the thread card", async () => {
    const render = hookRenderer(), onOpenCard = vi.fn();
    const record = makeRecord("a", [timed("a-due", now - HOUR)]);
    const draw = () => render(() => ContinuationInbox({ records: [record], sessions: [], canUseIterm: true, busyId: null,
      onSave: async () => true, onResume: async () => "restored", onOpenCard }));

    rows(draw())[0]!.props.onToggle();
    const expanded = rows(draw())[0]!;
    expect(expanded.props.expanded).toBe(true);

    const markup = renderToStaticMarkup(draw());
    expect(markup).toContain("下一步");
    expect(markup).toContain("继续 a-due");
    expect(markup).toContain("起算：锚点 a-due");
    expect(markup).toContain("上海时间");
    expect(markup).toContain("打开线程卡片");

    const detail = elements(InboxRow(expanded.props));
    detail.find((node) => node.props.children === "打开线程卡片")!.props.onClick!();
    expect(onOpenCard).toHaveBeenCalledWith(record);
  });

  it("collapses the expanded row when toggled again", () => {
    const render = hookRenderer();
    const record = makeRecord("a", [makeItem("a-later")]);
    const draw = () => render(() => ContinuationInbox({ records: [record], sessions: [], canUseIterm: true, busyId: null,
      onSave: async () => true, onResume: async () => "restored", onOpenCard: () => {} }));

    rows(draw())[0]!.props.onToggle();
    expect(rows(draw())[0]!.props.expanded).toBe(true);
    rows(draw())[0]!.props.onToggle();
    expect(rows(draw())[0]!.props.expanded).toBe(false);
  });

  it("keeps equal item IDs in different threads independently keyed and expandable", () => {
    const render = hookRenderer(), records = ["a", "b"].map((id) => makeRecord(id, [makeItem("shared")]));
    const draw = () => rows(render(() => ContinuationInbox({ records, sessions: [], canUseIterm: true, busyId: null,
      onSave: async () => true, onResume: async () => "restored", onOpenCard: () => {} })));
    const initial = draw();
    expect(new Set(initial.map((row) => row.key)).size).toBe(2);
    initial[0]!.props.onToggle();
    expect(draw().map((row) => row.props.expanded)).toEqual([true, false]);
    draw()[1]!.props.onToggle();
    expect(draw().map((row) => row.props.expanded)).toEqual([false, true]);
    draw()[1]!.props.onToggle();
    expect(draw().map((row) => row.props.expanded)).toEqual([false, false]);
  });
});
