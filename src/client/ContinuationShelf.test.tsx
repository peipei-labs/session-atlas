import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ContinuationItem, RecoveryRecord, SessionSummary } from "../shared/types";
import { ContinuationShelf, HandoffEditor, ReferenceEditor, handoffShortcutErrorMessage } from "./ContinuationShelf";
import { ContinuationInbox } from "./ContinuationInbox";
import { InboxRail } from "./InboxRail";
import {
  continuationTimeLabel, findContinuationSession, formatContinuationTime, fromShanghaiInput,
  pendingContinuations, resolveContinuationTarget, toShanghaiInput,
  savedReferences, referenceInput, endContinuationsInput, removeReferenceInput, savedThreadLocationGroup,
} from "./continuation-model";
import { createDemoSnapshot } from "./demo";
import { closeHandoff, deleteHandoff, fetchHandoff, putHandoff, resumeHandoff } from "./api";
import { useSessionAtlas } from "./useSessionAtlas";
import App from "./App";
import { OpenThreadAction, openThreadLocations } from "./OpenThreadAction";

Object.assign(globalThis, { React });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const now = Date.parse("2026-09-09T04:00:00.000Z");
const item: ContinuationItem = {
  id: "verify", title: "核验恢复", kind: "time", nextAction: "检查原线程恢复位置", status: "pending",
  anchorLabel: "完成部署", anchorAt: "2026-09-08T03:00:00.000Z", delayHours: 24, dueAt: "2026-09-09T03:00:00.000Z",
};

function recovery(overrides: Partial<RecoveryRecord> = {}): RecoveryRecord {
  return {
    sessionId: "01234567-89ab-cdef-8123-456789abcdef", cwd: "/tmp/session-atlas", title: "恢复核验",
    projectName: "session-atlas", status: "closed", firstSeenAt: "2026-09-08T03:00:00.000Z",
    lastSeenAt: "2026-09-08T03:00:00.000Z", resumeCommand: "codex resume original-thread",
    handoff: { summary: "已约定的后续核验", source: "thread", updatedAt: "2026-09-08T03:00:00.000Z", items: [{ ...item }] },
    ...overrides,
  };
}

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    ...createDemoSnapshot().sessions[0]!, id: "iterm:terminal-one", conversationId: recovery().sessionId,
    surface: "legacy", terminalSessionId: "terminal-one", activityState: "idle", stale: false,
    ...overrides,
  };
}

function renderShelf(records: RecoveryRecord[], sessions: SessionSummary[] = [], extra = {}) {
  vi.useFakeTimers(); vi.setSystemTime(now);
  return renderToStaticMarkup(<ContinuationShelf records={records} sessions={sessions} canUseIterm busyId={null}
    onSave={async () => true} onRemove={async () => true} onResume={async () => "restored"}
    onCloseSession={async () => true} {...extra} />);
}

type TestElement = React.ReactElement<{ children?: React.ReactNode; type?: string; className?: string; disabled?: boolean; value?: unknown;
  "data-location-group"?: string; "data-session-id"?: string; "data-card-location"?: string;
  onChange?: (event: { currentTarget: { value: string } }) => void; onClick?: () => void; onSubmit?: (event: { preventDefault: () => void }) => void }>;
const elements = (node: React.ReactNode): TestElement[] => React.Children.toArray(node).flatMap((child) =>
  React.isValidElement(child) ? [child as TestElement, ...elements((child as TestElement).props.children)] : []);
const openButtons = (node: React.ReactNode) => elements(node).flatMap((element) => element.type === OpenThreadAction
  ? elements(OpenThreadAction(element.props as unknown as React.ComponentProps<typeof OpenThreadAction>)) : []);
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

describe("saved-card location groups", () => {
  const withReference = (overrides: Partial<RecoveryRecord> = {}) => recovery({
    handoff: { ...recovery().handoff!, reference: { title: "恢复方法参考", reason: "以后检查恢复位置" } }, ...overrides,
  });
  const groupCards = (tree: React.ReactNode) => elements(tree).filter((node) => node.props["data-location-group"])
    .map((node) => [node.props["data-location-group"], elements(tree)
      .filter((card) => card.props["data-card-location"] === node.props["data-location-group"])
      .flatMap((card) => card.props["data-session-id"] ?? [])]);

  it.each(["continuation", "reference"] as const)("keeps due priority across locations only in the %s view", (initialView) => {
    const ids = ["other-unknown", "other-open", "other-closed", "due-unknown", "due-open", "due-closed"];
    const records = ids.map((id) => withReference({
      sessionId: id, status: id.endsWith("closed") ? "closed" : "active",
      handoff: { ...withReference().handoff!, items: [{ ...item,
        dueAt: new Date(now + (id.startsWith("due") ? -1000 : 60_000)).toISOString(),
      }, { ...item, id: "already-done", status: "done" }] },
    }));
    const sessions = ids.filter((id) => id.endsWith("open")).map((id) => session({
      id: `iterm:${id}`, conversationId: id, terminalSessionId: id,
    }));
    const html = renderShelf(records, sessions, { initialView });
    const order = [...html.matchAll(/data-session-id="([^"]+)"/g)].map((match) => match[1]);
    expect(order).toEqual(initialView === "continuation"
      ? ["due-closed", "due-open", "due-unknown", "other-closed", "other-open", "other-unknown"]
      : ["other-closed", "due-closed", "other-open", "due-open", "other-unknown", "due-unknown"]);
    expect(html).toContain("待续 <em>6</em>"); expect(html).toContain("可能有用 <em>6</em>");
    expect(html.match(/class="saved-thread-group-heading"/g)).toHaveLength(initialView === "continuation" ? 6 : 3);
    expect(html.includes("该核验了 ·")).toBe(initialView === "continuation");
  });

  it.each(["continuation", "reference"] as const)("moves a %s card only when its current location is observed and keeps it after close", async (initialView) => {
    const render = hookRenderer(), onSave = vi.fn(async () => true), onRemove = vi.fn(async () => true), onResume = vi.fn(async () => "restored" as const);
    let record = withReference(), sessions: SessionSummary[] = [];
    const draw = () => render(() => ContinuationShelf({ records: [record], sessions, initialView, busyId: null, canUseIterm: true,
      onSave, onRemove, onResume, onCloseSession: async () => true }));
    expect(groupCards(draw())).toEqual([["closed", [record.sessionId]]]);
    openButtons(draw()).find((node) => node.props.className === "continuation-primary")!.props.onClick?.();
    await Promise.resolve();
    expect(onResume).toHaveBeenCalledWith(record.sessionId);
    expect(groupCards(draw())).toEqual([["closed", [record.sessionId]]]);
    expect(renderToStaticMarkup(draw())).toContain("等待恢复确认");
    sessions = [session()];
    expect(groupCards(draw())).toEqual([["open", [record.sessionId]]]);
    record = { ...record, status: "active" }; sessions = [];
    expect(groupCards(draw())).toEqual([["unknown", [record.sessionId]]]);
    record = { ...record, status: "closed" };
    expect(groupCards(draw())).toEqual([["closed", [record.sessionId]]]);
    expect(renderToStaticMarkup(draw())).toContain("可能有用 <em>1</em>");
    expect(renderToStaticMarkup(draw())).toContain("待续 <em>1</em>");
    expect(onSave).not.toHaveBeenCalled(); expect(onRemove).not.toHaveBeenCalled();
  });

  it("uses only current exact thread locations, including duplicate and managed locations", () => {
    const record = withReference({ status: "active" });
    const classify = (sessions: SessionSummary[]) => savedThreadLocationGroup(record, openThreadLocations(sessions, record.sessionId));
    expect(classify([session({ stale: true })])).toBe("unknown");
    expect(classify([session({ conversationId: "another-thread" })])).toBe("unknown");
    expect(classify([session(), session({ id: "iterm:second", terminalSessionId: "second" })])).toBe("open");
    expect(classify([session({ surface: "managed", id: record.sessionId, conversationId: undefined, terminalSessionId: undefined })])).toBe("open");
    expect(savedThreadLocationGroup({ ...record, status: "closed" }, [])).toBe("closed");
  });

  it.each(["continuation", "reference"] as const)("groups filtered %s cards once and preserves total saved counts and exact open choices", (initialView) => {
    const closed = withReference({ sessionId: "closed", tags: ["Python", "排障"] });
    const open = withReference({ sessionId: "open", tags: ["Python", "排障"] });
    const unknown = withReference({ sessionId: "unknown", status: "active", tags: ["Python", "排障"] });
    const filtered = withReference({ sessionId: "filtered", tags: ["Python"] });
    const sessions = [session({ conversationId: "open" }), session({ id: "iterm:second", conversationId: "open", terminalSessionId: "second" })];
    const onResume = vi.fn(async () => "restored" as const), onFocusSession = vi.fn(async () => true);
    const tree = hookRenderer()(() => ContinuationShelf({ records: [unknown, open, filtered, closed], sessions, initialView,
      query: "恢复", selectedTags: ["Python", "排障"], canUseIterm: true, busyId: null, onSave: async () => true,
      onRemove: async () => true, onResume, onFocusSession, onCloseSession: async () => true }));
    expect(groupCards(tree)).toEqual([["closed", ["closed"]], ["open", ["open"]], ["unknown", ["unknown"]]]);
    const markup = renderToStaticMarkup(tree);
    expect(markup).toContain("待续 <em>4</em>"); expect(markup).toContain("可能有用 <em>4</em>");
    expect(markup).toContain('data-location-group="unknown"'); expect(markup).toContain("同一线程在 2 处打开");
    expect(markup).not.toContain("暂存并关闭分屏"); expect(markup).not.toContain("保存并关闭分屏");
    expect(markup.match(/class="saved-thread-group-heading"/g)).toHaveLength(3);
    openButtons(tree).find((node) => node.type === "button" && node.props.className !== "continuation-primary")!.props.onClick?.();
    expect(onFocusSession).toHaveBeenCalledWith("iterm:second"); expect(onResume).not.toHaveBeenCalled();
  });

  it("removes finished work from pending without removing its saved bookmark or open location", async () => {
    const render = hookRenderer(), onRemove = vi.fn(async () => true);
    let record = withReference();
    const onSave = vi.fn(async (_id, input) => { record = { ...record, handoff: { ...record.handoff!, ...input } }; return true; });
    const draw = () => render(() => ContinuationShelf({ records: [record], sessions: [session()], busyId: null, canUseIterm: true,
      onSave, onRemove, onResume: async () => "focused", onCloseSession: async () => true }));
    elements(draw()).find((node) => node.props.className === "continuation-complete")!.props.onClick?.();
    await Promise.resolve();
    expect(onSave).toHaveBeenCalledWith(record.sessionId, expect.objectContaining({ items: [expect.objectContaining({ status: "done" })] }));
    expect(onSave.mock.calls[0]![1]).not.toHaveProperty("reference");
    expect(groupCards(draw())).toEqual([]);
    elements(draw()).find((node) => node.type === "button" && node.props.className === "is-reference")!.props.onClick?.();
    expect(groupCards(draw())).toEqual([["open", [record.sessionId]]]);
    expect(renderToStaticMarkup(draw())).toContain("待续 <em>0</em>");
    expect(renderToStaticMarkup(draw())).toContain("可能有用 <em>1</em>");
    expect(onRemove).not.toHaveBeenCalled();
  });
});

describe("shortcut target lifecycle", () => {
  it.each([
    ["?handoff=thread-one", true],
    ["?handoff=iterm%3Aterminal-one&handoffError=SESSION_NOT_LINKED", true],
    ["", false],
    ["?handoff=", false],
  ])("opens the responsive inbox only for a nonempty shortcut target: %s", (search, opens) => {
    vi.stubGlobal("window", { location: new URL(`http://127.0.0.1:3999/${search}`), localStorage: { getItem: () => null } });
    const renderApp = hookRenderer([createDemoSnapshot()]);
    const tree = () => elements(renderApp(App));
    const inbox = () => tree().find((node) => node.type === "aside" && node.props.className?.startsWith("inbox-rail"));
    expect(inbox()?.props.className).toBe(opens ? "inbox-rail is-open" : "inbox-rail");
    if (opens) {
      tree().find((node) => node.props.className === "rail-scrim")!.props.onClick!();
      expect(inbox()?.props.className).toBe("inbox-rail");
    }
  });

  it("searches technical labels in continuation and reference cards and combines selected labels", () => {
    const tagged = recovery({ tags: ["Python", "排障"] });
    tagged.handoff!.reference = { title: "参考", reason: "保留核验步骤" };
    expect(pendingContinuations([tagged], now, "python")).toEqual([tagged]);
    expect(savedReferences([tagged], "Python")).toEqual([tagged]);
    expect(pendingContinuations([tagged], now, "Rust")).toEqual([]);
    expect(savedReferences([tagged], "Rust")).toEqual([]);
    expect(renderShelf([tagged], [], { selectedTags: ["Python", "Rust"] })).toContain("没有匹配的待续事项");
    expect(renderShelf([tagged], [], { selectedTags: ["Python", "排障"] })).toContain("continuation-card");
    expect(renderShelf([tagged], [], { selectedTags: ["Rust"], initialView: "reference" })).toContain("没有匹配的收藏");
  });
  function fixture(linked = false, reference = false) {
    const location = new URL("http://127.0.0.1:3999/?keep=a%20b&handoff=iterm%3Aterminal-one&handoffError=SESSION_NOT_LINKED#retain");
    const history = { state: { retained: true }, replaceState: vi.fn((_state: unknown, _title: string, path: string) => { location.href = new URL(path, location).href; }) };
    vi.stubGlobal("window", { location, history, localStorage: { getItem: () => null } });
    const record = recovery({ handoff: reference ? { ...recovery().handoff!, items: [], reference: { title: "主题", reason: "原因" } } : recovery().handoff });
    const snapshot = { ...createDemoSnapshot(), sessions: linked ? [session()] : [], recoveries: [record] };
    const slots: unknown[] = [snapshot], renderApp = hookRenderer(slots), renderRail = hookRenderer(), renderEditor = hookRenderer();
    const app = () => renderApp(App);
    const railElement = () => elements(app()).find((node) => node.type === InboxRail) as unknown as React.ReactElement<React.ComponentProps<typeof InboxRail>>;
    const railTree = () => renderRail(() => InboxRail(railElement().props));
    const shelfElement = () => elements(railTree()).find((node) => node.type === ContinuationShelf) as unknown as React.ReactElement<React.ComponentProps<typeof ContinuationShelf>> | undefined;
    const props = () => shelfElement()?.props;
    const shelf = () => renderEditor(() => ContinuationShelf(props()!));
    const railButton = (label: string) => elements(railTree()).find((node) => node.type === "button" &&
      (node.props.children === label || elements(node.props.children).some((child) => child.props.children === label)));
    const expectFinished = () => {
      expect(railElement().props.handoffTarget).toBeUndefined();
      expect(railElement().props.handoffErrorCode).toBeUndefined();
      expect(shelfElement()).toBeUndefined();
      expect(elements(railTree()).some((node) => node.type === ContinuationInbox)).toBe(true);
      expect(location.searchParams.has("handoff")).toBe(false); expect(location.searchParams.has("handoffError")).toBe(false);
      expect(location.searchParams.get("keep")).toBe("a b"); expect(location.hash).toBe("#retain");
      expect(history.replaceState).toHaveBeenCalledWith(history.state, "", "/?keep=a+b#retain");
    };
    return { app, props, shelf, railTree, railButton, expectFinished, history, snapshot, slots, record };
  }

  it.each(["知道了", "返回待续列表"])("finishes %s in the rail and parent, including URL and remount", (label) => {
    const f = fixture();
    if (label === "知道了") {
      elements(f.shelf()).find((node) => node.props.children === label)?.props.onClick?.();
    } else {
      f.railButton("返回待续列表")?.props.onClick?.();
    }
    f.expectFinished();
    // 快捷键目标完成后不会复活：右栏回到全局待续 inbox，不再渲染线程卡片。
    expect(renderToStaticMarkup(<ContinuationInbox records={[f.record]} sessions={[]} canUseIterm busyId={null}
      onSave={async () => true} onResume={async () => "restored"} onOpenCard={() => {}} />)).not.toContain("尚未关联到唯一的 Codex 线程");
  });

  it("keeps the scoped shortcut while browsing other rail sections", () => {
    const f = fixture();
    expect(f.railTree() && f.props()?.target).toBe("iterm:terminal-one");
    // 堆叠布局下折叠/展开「最近关闭」不会打断正在进行的快捷键登记。
    f.railButton("最近关闭")?.props.onClick?.();
    expect(f.history.replaceState).not.toHaveBeenCalled();
    expect(f.props()?.target).toBe("iterm:terminal-one");
    f.railButton("返回待续列表")?.props.onClick?.();
    f.expectFinished();
  });

  it.each([false, true])("finishes a successful registration or reference save: reference=%s", async (reference) => {
    const f = fixture(true, reference), Editor = reference ? ReferenceEditor : HandoffEditor;
    const props = { ...f.props()!, onSave: vi.fn(async () => true) };
    const tree = hookRenderer()(() => ContinuationShelf(props));
    const editor = elements(tree).find((node) => node.type === Editor) as unknown as React.ReactElement<React.ComponentProps<typeof HandoffEditor>>;
    expect(await editor.props.onSave(referenceInput(f.record.cwd, "主题", "原因", f.record)!)).toBe(true);
    f.expectFinished();
  });

  it("keeps an unresolved target live until its next snapshot uniquely links it", () => {
    const f = fixture();
    expect(renderToStaticMarkup(f.shelf())).toContain("尚未关联到唯一的 Codex 线程");
    f.slots[0] = { ...f.snapshot, sessions: [session()] };
    expect(elements(f.shelf()).some((node) => node.type === HandoffEditor)).toBe(true);
    expect(f.props()?.target).toBe("iterm:terminal-one"); expect(f.history.replaceState).not.toHaveBeenCalled();
  });

  it("preserves the shortcut target when saving fails", async () => {
    const f = fixture(true);
    const tree = hookRenderer()(() => ContinuationShelf({ ...f.props()!, onSave: async () => false }));
    const editor = elements(tree).find((node) => node.type === HandoffEditor) as unknown as React.ReactElement<React.ComponentProps<typeof HandoffEditor>>;
    expect(await editor.props.onSave(referenceInput(f.record.cwd, "主题", "原因", f.record)!)).toBe(false);
    expect(f.props()?.target).toBe("iterm:terminal-one"); expect(f.history.replaceState).not.toHaveBeenCalled();
  });

  it("clears manual registration when the parent opens a session or finishes the current target", () => {
    const f = fixture(true);
    f.railButton("返回待续列表")!.props.onClick!();
    for (const openSession of [true, false]) {
      f.railButton("登记 / 收藏")!.props.onClick!();
      expect(f.props()).toBeDefined();
      if (openSession) f.props()!.onOpenSession!(session().id);
      else f.props()!.onFinishTarget!();
      expect(f.props()).toBeUndefined();
    }
  });
});

describe("rail manual registration", () => {
  function fixture(records = [recovery()], selected: string | null = records[0]?.sessionId ?? null, availableSessions = [session()]) {
    const renderRail = hookRenderer(), onSave = vi.fn(async () => false), onFinishTarget = vi.fn();
    let key: React.Key | null | undefined, renderShelf = hookRenderer();
    let registration: { sessionId?: string } | null = null;
    const rail = () => renderRail(() => InboxRail({ records, sessions: availableSessions, closedRecoveries: [],
      restartSessionIds: [], closedWindowLayouts: [], health: createDemoSnapshot().health, busyId: null,
      recoveryBusy: false, openBusy: false, layoutBusyId: null, query: "", selectedTags: [], tagSuggestions: [],
      cardThreadId: selected, onCardThread: (id) => { selected = id; }, onFinishTarget, onSave,
      registration, onRegistration: (next) => { registration = next; },
      onRemove: async () => true, onResume: async () => "restored", onCloseSession: async () => true,
      onOpenRecovery: async () => "restored", onRestoreRecoveries: async () => true, onRestoreLayout: () => {},
      onFocusSession: async () => true, onOpenSession: () => {}, onUpdateTags: async () => true }));
    const shelf = () => {
      const element = elements(rail()).find((node) => node.type === ContinuationShelf) as unknown as
        React.ReactElement<React.ComponentProps<typeof ContinuationShelf>> | undefined;
      if (key !== element?.key) { renderShelf = hookRenderer(); key = element?.key; }
      return element ? renderShelf(() => ContinuationShelf(element.props)) : null;
    };
    const click = (tree: React.ReactNode, label: string) => elements(tree).find((node) => node.type === "button" &&
      (React.Children.toArray(node.props.children).some((child) => typeof child === "string" && child.trim() === label)
        || elements(node.props.children).some((child) => child.props.children === label)))!.props.onClick!();
    const editor = (Editor: typeof HandoffEditor) => elements(shelf()).find((node) => node.type === Editor) as unknown as
      React.ReactElement<React.ComponentProps<typeof HandoffEditor>> | undefined;
    return { rail, shelf, click, editor, onSave, onFinishTarget };
  }

  it.each(["编辑", "加入可能有用", "select"])("keeps scoped %s open through rerender and failed save, and leaves after success", async (action) => {
    const f = fixture(), Editor = action === "加入可能有用" ? ReferenceEditor : HandoffEditor;
    if (action === "select") elements(f.shelf()).find((node) => node.type === "select")!.props.onChange!({ currentTarget: { value: recovery().sessionId } });
    else f.click(f.shelf(), action);
    expect(f.editor(Editor)?.props.sessionId).toBe(recovery().sessionId);
    expect(f.onFinishTarget).not.toHaveBeenCalled();
    const renderEditor = hookRenderer(), draft = () => renderEditor(() => Editor(f.editor(Editor)!.props));
    elements(draft()).find((node) => node.props.onChange)!.props.onChange!({ currentTarget: { value: "保留草稿" } });
    const input = referenceInput(recovery().cwd, "主题", "原因", recovery())!;
    expect(await f.editor(Editor)!.props.onSave(input)).toBe(false);
    expect(elements(draft()).some((node) => node.props.value === "保留草稿")).toBe(true);
    expect(f.onFinishTarget).not.toHaveBeenCalled();
    f.onSave.mockResolvedValue(true);
    expect(await f.editor(Editor)!.props.onSave(input)).toBe(true);
    expect(f.shelf()).toBeNull(); expect(f.onFinishTarget).toHaveBeenCalledOnce();
  });

  it.each([false, true])("offers the first registration without saved cards: reference=%s", async (reference) => {
    const Editor = reference ? ReferenceEditor : HandoffEditor;
    const f = fixture([], null);
    f.click(f.rail(), "登记 / 收藏");
    if (Editor === ReferenceEditor) f.click(f.shelf(), "可能有用");
    elements(f.shelf()).find((node) => node.type === "select")!.props.onChange!({ currentTarget: { value: recovery().sessionId } });
    expect(f.editor(Editor)?.props.sessionId).toBe(recovery().sessionId);
    expect(f.editor(Editor)?.props.record).toBeUndefined();
    f.onSave.mockResolvedValue(true);
    expect(await f.editor(Editor)!.props.onSave(referenceInput(recovery().cwd, "主题", "原因")!)).toBe(true);
    expect(f.onSave).toHaveBeenCalledWith(recovery().sessionId, expect.objectContaining({ expectedVersion: null }));
    expect(f.shelf()).toBeNull();
  });

  it("opens a bookmark's continuation editor directly and preserves its reference", async () => {
    const record = recovery({ handoff: { ...recovery().handoff!, items: [], reference: { title: "主题", reason: "原因" } } });
    const f = fixture([record], null);
    f.click(f.rail(), "可能有用"); f.click(f.shelf(), "登记待续");
    const editor = f.editor(HandoffEditor)!;
    expect(editor.props.sessionId).toBe(record.sessionId); expect(editor.props.record?.handoff?.reference).toEqual(record.handoff!.reference);
    expect(f.editor(ReferenceEditor)).toBeUndefined();
    await editor.props.onSave({ expectedVersion: record.handoff!.updatedAt, cwd: record.cwd, summary: "后续", source: "user", items: [item] });
    expect(f.onSave).toHaveBeenCalledWith(record.sessionId, expect.not.objectContaining({ reference: expect.anything() }));
    expect(record.handoff!.reference).toEqual({ title: "主题", reason: "原因" });
  });

  it("limits card-scoped selection while global registration loads another thread's saved record", () => {
    const first = recovery(), second = recovery({ sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    const sessions = [session(), session({ id: "iterm:second", conversationId: second.sessionId })];
    const scoped = fixture([first, second], first.sessionId, sessions);
    const options = elements(scoped.shelf()).filter((node) => node.type === "option").map((node) => node.props.value);
    expect(options).toContain(first.sessionId); expect(options).not.toContain(second.sessionId);
    const global = fixture([first, second], null, sessions);
    global.click(global.rail(), "登记 / 收藏");
    elements(global.shelf()).find((node) => node.type === "select")!.props.onChange!({ currentTarget: { value: second.sessionId } });
    expect(global.editor(HandoffEditor)!.props.record).toBe(second);
  });
});

describe("saved-thread updates while open", () => {
  it.each([HandoffEditor, ReferenceEditor])("blocks an outdated %s draft until explicitly reloaded", async (Editor) => {
    const render = hookRenderer(), onSave = vi.fn(async () => true);
    let record = recovery({ handoff: { ...recovery().handoff!, reference: { title: "old topic", reason: "old reason" } } });
    const draw = () => render(() => Editor({ sessionId: record.sessionId, record, busy: false, onSave }));
    elements(draw()).find((node) => node.props.onChange)?.props.onChange?.({ currentTarget: { value: "local draft" } });
    record = recovery({ cwd: "/tmp/latest", handoff: { ...record.handoff!, version: "latest-version", summary: "latest summary", requiresRunningProcess: true,
      items: [{ ...item, status: "done" }], reference: { title: "latest topic", reason: "latest reason" } } });
    let tree = draw();
    expect(elements(tree).some((node) => node.props.value === "local draft")).toBe(true);
    expect(elements(tree).find((node) => node.props.type === "submit")?.props.disabled).toBe(true);
    elements(tree).find((node) => node.type === "form")?.props.onSubmit?.({ preventDefault() {} });
    expect(onSave).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(tree)).toContain("当前草稿已保留");
    elements(tree).find((node) => node.props.children === "载入最新记录")?.props.onClick?.();
    tree = draw();
    expect(elements(tree).find((node) => node.props.type === "submit")?.props.disabled).toBe(false);
    elements(tree).find((node) => node.type === "form")?.props.onSubmit?.({ preventDefault() {} });
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: "latest-version", cwd: "/tmp/latest", summary: "latest summary", requiresRunningProcess: true,
      items: [expect.objectContaining({ status: "done" })], ...(Editor === ReferenceEditor ? { reference: record.handoff!.reference } : {}) }));
  });

  it("does not restore a remotely removed reference from an open draft", () => {
    const render = hookRenderer(), onSave = vi.fn(async () => true);
    let record = recovery({ handoff: { ...recovery().handoff!, reference: { title: "old topic", reason: "old reason" } } });
    const draw = () => render(() => ReferenceEditor({ sessionId: record.sessionId, record, busy: false, onSave }));
    draw(); record = recovery();
    let tree = draw();
    elements(tree).find((node) => node.type === "form")?.props.onSubmit?.({ preventDefault() {} });
    expect(onSave).not.toHaveBeenCalled();
    elements(tree).find((node) => node.props.children === "载入最新记录")?.props.onClick?.();
    tree = draw(); expect(elements(tree).some((node) => node.props.value === "old reason")).toBe(false);
  });

  it.each(["continuation", "reference"] as const)("opens a managed %s card in its Workbench while iTerm is offline", (initialView) => {
    const render = hookRenderer(), onOpenSession = vi.fn(), onResume = vi.fn(async () => "focused" as const);
    const record = recovery({ handoff: { ...recovery().handoff!, reference: { title: "topic", reason: "reason" } } });
    const props = { records: [record], sessions: [session({ id: "managed:one", surface: "managed", terminalSessionId: undefined })],
      initialView, canUseIterm: false, busyId: null, onSave: async () => true, onRemove: async () => true, onResume, onCloseSession: async () => true };
    const tree = render(() => ContinuationShelf({ ...props, onOpenSession }));
    const button = openButtons(tree).find((node) => node.props.className === "continuation-primary")!;
    expect(button.props.disabled).toBe(false); button.props.onClick?.();
    expect(onOpenSession).toHaveBeenCalledWith("managed:one"); expect(onResume).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(tree)).toContain("工作台会话仍然打开");
    expect(renderToStaticMarkup(tree)).toContain("打开工作台");
    expect(openButtons(render(() => ContinuationShelf(props))).find((node) => node.props.className === "continuation-primary")?.props.disabled).toBe(true);
  });
});

describe("continuation timing and identity", () => {
  it("keeps normal closures and completed cards out, and sorts actual due work first", () => {
    const normal = recovery({ sessionId: "normal", handoff: undefined });
    const complete = recovery({ sessionId: "complete", handoff: { ...recovery().handoff!, items: [{ ...item, status: "done" }] } });
    const future = recovery({ sessionId: "future", handoff: { ...recovery().handoff!, updatedAt: "2026-09-09T03:30:00.000Z", items: [{ ...item, dueAt: "2026-09-10T03:00:00.000Z" }] } });
    const due = recovery({ sessionId: "due" });
    expect(pendingContinuations([normal, future, complete, due], now).map((entry) => entry.sessionId)).toEqual(["due", "future"]);
    expect(pendingContinuations([future, due], now, "恢复位置")).toHaveLength(2);
  });

  it("does not invent a start time, and displays a countdown only for a recorded due time", () => {
    expect(continuationTimeLabel({ ...item, anchorAt: undefined, dueAt: undefined }, now)).toBe("时间待确认");
    expect(continuationTimeLabel(item, now)).toBe("该核验了");
    expect(continuationTimeLabel({ ...item, dueAt: "2026-09-09T05:30:00.000Z" }, now)).toBe("1 小时 30 分钟后核验");
    expect(continuationTimeLabel({ ...item, dueAt: "invalid" }, now)).toBe("时间待确认");
  });

  it("edits and displays absolute Shanghai dates regardless of browser timezone", () => {
    expect(toShanghaiInput(item.dueAt)).toBe("2026-09-09T11:00");
    expect(fromShanghaiInput("2026-09-09T11:00")).toBe(item.dueAt);
    expect(formatContinuationTime(item.dueAt!)).toContain("11:00");
    expect(fromShanghaiInput("")).toBeUndefined();
  });

  it("requires an unambiguous live thread for a pane target and never borrows a stale match", () => {
    const first = session();
    expect(resolveContinuationTarget("iterm:terminal-one", [first])).toBe(first.conversationId);
    expect(resolveContinuationTarget("iterm:terminal-one", [session({ stale: true })])).toBeUndefined();
    expect(resolveContinuationTarget("iterm:terminal-one", [first, session({ id: "other" })])).toBeUndefined();
    expect(findContinuationSession([first, session({ id: "other" })], first.conversationId!)).toBeUndefined();
  });
});

describe("ContinuationShelf", () => {
  it.each([
    ["HANDOFF_REQUIRED", "尚未登记未完成事项"],
    ["SESSION_NOT_LINKED", "尚无法取得唯一的 Codex 会话记录"],
    ["SESSION_REQUIRES_PROCESS", "线程中的工作仍依赖当前进程"],
    ["SESSION_NOT_IDLE", "线程仍在执行"],
    ["HANDOFF_STALE", "尚未反映线程的最新进展"],
    ["SESSION_TARGET_CHANGED", "当前分屏与登记的线程不再匹配"],
    ["ITERM_OFFLINE", "iTerm2 连接离线"],
    ["BRIDGE_UPDATE_REQUIRED", "连接组件尚不支持暂存关闭"],
    ["PROVIDER_UNAVAILABLE", "会话服务暂时不可用"],
    ["CONTINUATION_CANCELLED", "分屏已保留"],
    ["CLOSE_FAILED", "未能确认暂存关闭成功"],
  ])("explains the shortcut failure %s from a fixed message", (shortcutErrorCode, expected) => {
    const markup = renderShelf([], shortcutErrorCode === "SESSION_NOT_LINKED" ? [] : [session()], { target: "iterm:terminal-one", shortcutErrorCode });
    expect(markup).toContain('data-testid="handoff-shortcut-error"');
    expect(markup).toContain(expected);
    expect(markup).not.toContain(shortcutErrorCode);
  });

  it("never renders an unknown error code or arbitrary URL message", () => {
    const unknown = "<script>private URL text</script>";
    const markup = renderShelf([], [], { shortcutErrorCode: unknown });
    expect(markup).toContain("未能确认暂存关闭成功");
    expect(markup).not.toContain("private URL text");
    expect(handoffShortcutErrorMessage("__proto__")).toBe(handoffShortcutErrorMessage("CLOSE_FAILED"));
    expect(renderShelf([], [])).not.toContain('data-testid="handoff-shortcut-error"');
  });

  it("shows factual due details and preserves every pending item with explicit completion controls", () => {
    const record = recovery({ handoff: { ...recovery().handoff!, items: [item,
      { id: "condition", title: "等实际登录", kind: "condition", nextAction: "登录后核验", condition: "扫码登录完成", status: "pending" },
      { id: "completed", title: "已经做完的事", kind: "later", nextAction: "无", status: "done" },
    ] } });
    const markup = renderShelf([record]);
    expect(markup).toContain("该核验了"); expect(markup).toContain("上海时间");
    expect(markup).toContain("扫码登录完成"); expect(markup).toContain("检查原线程恢复位置");
    expect(markup).toContain('aria-label="完成：核验恢复"');
    expect(markup).not.toContain("已经做完的事"); expect(markup).not.toContain("暂存并关闭分屏");
    expect(markup).not.toContain("最初要求"); expect(markup).not.toContain("进度百分比");
  });

  it.each([
    { sessions: [session({ activityState: "running" })], extra: {}, blocked: true },
    { sessions: [session()], extra: { canUseIterm: false }, blocked: true },
    { sessions: [session()], extra: { busyId: "another-card" }, blocked: true },
    { sessions: [session()], extra: {}, blocked: false },
  ])("gates an explicit close on execution, connection and pending action state: $blocked", ({ sessions, extra, blocked }) => {
    const markup = renderShelf([recovery()], sessions, extra);
    const button = markup.match(/<button[^>]*>暂存并关闭分屏<\/button>/)?.[0];
    expect(button).toBeDefined();
    expect(button!.includes('disabled=""')).toBe(blocked);
  });

  it("blocks closing work that depends on the live process", () => {
    const markup = renderShelf([recovery({ handoff: { ...recovery().handoff!, requiresRunningProcess: true } })], [session()]);
    expect(markup.match(/<button[^>]*>暂存并关闭分屏<\/button>/)?.[0]).toContain('disabled=""');
    expect(markup).toContain("线程中的工作仍依赖当前进程");
  });

  it("opens a manual registration form for a uniquely linked unregistered target", () => {
    const markup = renderShelf([], [session()], { target: "iterm:terminal-one" });
    expect(markup).toContain("这个线程还没有待续卡"); expect(markup).toContain("$session-atlas-handoff");
    expect(markup).toContain("保存待续卡"); expect(markup).toContain(session().conversationId);
    expect(markup).not.toContain("继续原线程");
  });

  it("leaves an unlinked target untouched and explains how to register from the original thread", () => {
    const markup = renderShelf([], [], { target: "iterm:unlinked" });
    expect(markup).toContain("尚未关联到唯一的 Codex 线程");
    expect(markup).toContain("若是尚未开始工作的空白会话，或工作已完成，请使用 iTerm2 普通关闭");
    expect(markup).toContain("有已约定的未完成工作");
    expect(markup).not.toContain("保存待续卡");
  });

  it.each(["SESSION_NOT_LINKED", "HANDOFF_REQUIRED"])("shows one actionable unlinked notice for %s without referring to a missing form", (shortcutErrorCode) => {
    const markup = renderShelf([], [session({ conversationId: undefined })], { target: "iterm:terminal-one", shortcutErrorCode });
    expect(markup.match(/class="continuation-guidance"/g)).toHaveLength(1);
    expect(markup).toContain("尚无法取得唯一的 Codex 会话记录，分屏已保留");
    expect(markup).toContain("若是尚未开始工作的空白会话，或工作已完成，请使用 iTerm2 普通关闭");
    expect(markup).toContain("$session-atlas-handoff");
    expect(markup).not.toContain("填写下方");
    expect(markup).not.toContain("保存待续卡");
    expect(markup).not.toContain("暂存并关闭分屏");
    expect(markup).not.toContain("这个线程还没有待续卡");
  });

  it("keeps an offline error distinguishable within the same unlinked notice", () => {
    const markup = renderShelf([], [], { target: "iterm:terminal-one", shortcutErrorCode: "ITERM_OFFLINE", canUseIterm: false });
    expect(markup.match(/class="continuation-guidance"/g)).toHaveLength(1);
    expect(markup).toContain("iTerm2 连接离线，暂时不能关闭分屏");
    expect(markup).toContain("尚无法取得唯一的 Codex 会话记录");
    expect(markup).not.toContain("填写下方");
  });

  it("keeps registration available when the target is linked but no handoff exists", () => {
    const markup = renderShelf([], [session()], { target: "iterm:terminal-one", shortcutErrorCode: "HANDOFF_REQUIRED" });
    expect(markup).toContain("尚未登记未完成事项");
    expect(markup).toContain("这个线程还没有待续卡");
    expect(markup).toContain("也可以在这里手动登记");
    expect(markup).toContain("保存待续卡");
    expect(markup).not.toContain("尚无法取得唯一");
  });

  it("keeps the item statuses and time basis editable without terminal input controls", () => {
    const markup = renderToStaticMarkup(<HandoffEditor sessionId={recovery().sessionId} record={recovery()}
      busy={false} onSave={async () => true} />);
    expect(markup).toContain("起算时间（上海时间）"); expect(markup).toContain('value="2026-09-08T11:00"');
    expect(markup).toContain("已取消"); expect(markup).toContain("添加后续事项");
    expect(markup).not.toContain("发送消息");
  });
});

describe("handoff API", () => {
  it.each(["PUT", "DELETE"])("keeps newer streamed state after a delayed successful %s response", async (method) => {
    const record = recovery(), original = { ...createDemoSnapshot(), revision: 10, recoveries: [record] };
    const newer = { ...original, revision: 12, recoveries: [recovery({ handoff: { ...record.handoff!, version: "newer", items: [item, { ...item, id: "new" }] } })] };
    const slots: unknown[] = [original], render = hookRenderer(slots);
    const fetchMock = vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method) return method === "DELETE" ? new Response(null, { status: 204 }) : new Response(JSON.stringify(record));
      slots[0] = newer;
      return new Response(JSON.stringify({ ...original, revision: 11, recoveries: [] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const controller = render(useSessionAtlas);
    expect(await (method === "PUT" ? controller.saveHandoff(record.sessionId, referenceInput(record.cwd, "topic", "reason", record)!)
      : controller.removeHandoff(record.sessionId, record.handoff!.updatedAt))).toBe(true);
    expect(render(useSessionAtlas).snapshot).toEqual(newer);
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual([method, undefined]);
  });

  it.each(["PUT", "DELETE"].flatMap((method) => [9, 11].map((revision) => ({ method, revision }))))(
    "refreshes a $method conflict at revision $revision once without retrying or downgrading", async ({ method, revision }) => {
    const record = recovery(), original = { ...createDemoSnapshot(), revision: 10, recoveries: [record] };
    const render = hookRenderer([original]);
    const fetchMock = vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify(init?.method
      ? { error: { code: "HANDOFF_CONFLICT", message: "记录已更新，请载入最新记录。" } }
      : { ...original, revision, recoveries: [] }), { status: init?.method ? 409 : 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = render(useSessionAtlas);
    expect(await (method === "PUT" ? controller.saveHandoff(record.sessionId, referenceInput(record.cwd, "topic", "reason", record)!)
      : controller.removeHandoff(record.sessionId, record.handoff!.updatedAt))).toBe(false);
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual([method, undefined]);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).expectedVersion).toBe(record.handoff!.updatedAt);
    expect(render(useSessionAtlas).snapshot?.recoveries).toEqual(revision > original.revision ? [] : [record]);
    expect(render(useSessionAtlas).error).toContain("载入最新记录");
  });

  it.each([
    ["continuation", true, true, "continuation-complete", "save"], ["continuation", true, true, "continuation-remove", "save"],
    ["reference", true, true, "continuation-remove", "save"], ["continuation", false, true, "continuation-remove", "remove"],
    ["reference", true, false, "continuation-remove", "remove"],
  ] as const)("uses the displayed version for %s %s %s %s", (initialView, reference, items, action, method) => {
    const record = recovery({ handoff: { ...recovery().handoff!, version: "displayed-version", items: items ? [item] : [],
      reference: reference ? { title: "topic", reason: "reason" } : undefined } });
    const onSave = vi.fn(async () => true), onRemove = vi.fn(async () => true);
    const tree = hookRenderer()(() => ContinuationShelf({ records: [record], sessions: [], initialView, busyId: null, canUseIterm: true,
      onSave, onRemove, onResume: async () => null, onCloseSession: async () => true }));
    elements(tree).find((node) => node.props.className === action)?.props.onClick?.();
    if (method === "save") expect(onSave).toHaveBeenCalledWith(record.sessionId, expect.objectContaining({ expectedVersion: "displayed-version" }));
    else expect(onRemove).toHaveBeenCalledWith(record.sessionId, "displayed-version");
  });

  it("uses the exact thread id and pane id for each operation without caching content", async () => {
    const fetchMock = vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "DELETE" ? new Response(null, { status: 204 }) : new Response(JSON.stringify(recovery()), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const id = "thread id";
    await fetchHandoff(id);
    await putHandoff(id, { expectedVersion: null, cwd: recovery().cwd, summary: "约定事项", items: [item], source: "user" });
    await resumeHandoff(id); await closeHandoff(id, "pane id"); await deleteHandoff(id, "saved-version");
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/handoffs/thread%20id", "/api/handoffs/thread%20id", "/api/handoffs/thread%20id/resume",
      "/api/handoffs/thread%20id/close", "/api/handoffs/thread%20id",
    ]);
    expect(fetchMock.mock.calls[0]?.[1]?.cache).toBe("no-store");
    expect(fetchMock.mock.calls[2]?.[1]?.body).toBe("{}");
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toEqual({ terminalSessionId: "pane id" });
    expect(fetchMock.mock.calls[4]?.[1]?.method).toBe("DELETE");
    expect(JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body))).toEqual({ expectedVersion: "saved-version" });
  });
});

describe("saved references", () => {
  const reference = { title: "恢复方法参考", reason: "下次窗口丢失时参考检查方法" };
  const referenced = (items: ContinuationItem[] = []): RecoveryRecord => recovery({
    handoff: { ...recovery().handoff!, items, reference },
  });

  it("keeps reference-only records out of the pending count and searches their reason", () => {
    expect(pendingContinuations([referenced()], now)).toEqual([]);
    expect(savedReferences([referenced()], "窗口丢失")).toHaveLength(1);
    expect(savedReferences([referenced()], "找不到")).toEqual([]);
    expect(savedReferences([recovery()], "")).toEqual([]);
    expect(pendingContinuations([referenced([item])], now)).toHaveLength(1);
    expect(savedReferences([referenced([item])])).toHaveLength(1);
  });

  it("saves a reference without inventing follow-up items, dates or actions", () => {
    expect(referenceInput(" /tmp/session-atlas ", "  有用的方法  ", "  以后参考  ")).toEqual({
      expectedVersion: null,
      cwd: "/tmp/session-atlas", summary: "有用的方法", items: [],
      reference: { title: "有用的方法", reason: "以后参考" }, source: "user", requiresRunningProcess: undefined,
    });
    expect(referenceInput("/tmp/session-atlas", "主题", " ")).toBeNull();
    expect(referenceInput("/tmp/session-atlas", " ", "原因")).toBeNull();
    expect(referenceInput("relative/path", "主题", "原因")).toBeNull();
  });

  it("keeps the existing continuation summary, items and process restriction when adding a reference", () => {
    const existing = recovery({ handoff: { ...recovery().handoff!, requiresRunningProcess: true } });
    const result = referenceInput(existing.cwd, reference.title, reference.reason, existing)!;
    expect(result.items).toEqual(existing.handoff!.items);
    expect(result.summary).toBe(existing.handoff!.summary);
    expect(result.requiresRunningProcess).toBe(true);
    expect(result.reference).toEqual(reference);
    expect(existing.handoff).not.toHaveProperty("reference");
  });

  it("ends pending items without sending a reference removal, and removes a reference without changing items", () => {
    const record = referenced([item, { ...item, id: "done", status: "done" }]);
    const ended = endContinuationsInput(record);
    expect(ended.items.map((entry) => entry.status)).toEqual(["cancelled", "done"]);
    expect(ended).not.toHaveProperty("reference");
    const unreferenced = removeReferenceInput(record);
    expect(unreferenced.reference).toBeNull();
    expect(unreferenced.items).toEqual(record.handoff!.items);
    expect(record.handoff!.items[0]?.status).toBe("pending");
    expect(record.handoff!.reference).toEqual(reference);
  });

  it("renders a reference shelf without pending, due or completion controls", () => {
    const markup = renderShelf([referenced()], [], { initialView: "reference" });
    expect(markup).toContain('aria-label="保存用途"');
    expect(markup).toContain("待续 <em>0</em>");
    expect(markup).toContain("可能有用 <em>1</em>");
    expect(markup).toContain(reference.title); expect(markup).toContain(reference.reason);
    expect(markup).toContain("搜索收藏"); expect(markup).toContain("恢复原线程");
    expect(markup).toContain("登记待续"); expect(markup).toContain("移除收藏");
    expect(markup).not.toContain('aria-label="完成：');
    expect(markup).not.toContain("该核验了"); expect(markup).not.toContain("下一步</small>");
    expect(markup).not.toContain("结束待续");
  });

  it("offers reference registration for a linked target and recently closed records", () => {
    const markup = renderShelf([referenced()], [session({ conversationId: "another-thread" })], { initialView: "reference" });
    expect(markup).toContain('<optgroup label="已关联线程">');
    expect(markup).toContain('<optgroup label="最近关闭">');
    expect(markup).toContain(`value="${referenced().sessionId}"`);
    const targetMarkup = renderShelf([], [session()], { target: "iterm:terminal-one", initialView: "reference" });
    expect(targetMarkup).toContain("保存到可能有用");
    expect(targetMarkup).toContain("保留原因");
    expect(targetMarkup).not.toContain("事项名称");
  });

  it("opens an existing reference-only target in its reference editor", () => {
    const markup = renderShelf([referenced()], [], { target: referenced().sessionId });
    expect(markup).toContain("保存到可能有用");
    expect(markup).not.toContain("保存待续卡");
    expect(markup).toContain(reference.reason);
  });

  it("offers exact-pane close for a reference and blocks it while running", () => {
    const active = renderShelf([referenced()], [session()], { initialView: "reference" });
    expect(active.match(/<button[^>]*>保存并关闭分屏<\/button>/)?.[0]).not.toContain('disabled=""');
    const running = renderShelf([referenced()], [session({ activityState: "running" })], { initialView: "reference" });
    expect(running.match(/<button[^>]*>保存并关闭分屏<\/button>/)?.[0]).toContain('disabled=""');
  });

  it("renders only topic and reason fields for references and keeps adding a first follow-up possible", () => {
    const markup = renderToStaticMarkup(<ReferenceEditor sessionId={referenced().sessionId} record={referenced([item])}
      busy={false} onSave={async () => true} />);
    expect(markup).toContain("主题"); expect(markup).toContain("保留原因");
    expect(markup).toContain("保存收藏会保留这些事项");
    expect(markup).not.toContain("事项名称"); expect(markup).not.toContain('type="datetime-local"');
    const continuationMarkup = renderToStaticMarkup(<HandoffEditor sessionId={referenced().sessionId} record={referenced()}
      busy={false} onSave={async () => true} />);
    expect(continuationMarkup).toContain("后续事项 1");
    expect(continuationMarkup).toContain("事项名称");
  });
});
