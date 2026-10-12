import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { RecoveryRecord, SessionSummary } from "../shared/types";
import { createDemoSnapshot } from "./demo";
import { OpenThreadAction, openThreadLocations, threadLocationStatus } from "./OpenThreadAction";

Object.assign(globalThis, { React });
const id = "01234567-89ab-cdef-8123-456789abcdef";
const record: RecoveryRecord = {
  sessionId: id, cwd: "/project", title: "同名项目", projectName: "project", status: "closed",
  firstSeenAt: "2026-09-14T00:00:00Z", lastSeenAt: "2026-09-14T00:00:00Z", resumeCommand: "codex resume fixture",
};
function session(index: number, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return { ...createDemoSnapshot().sessions[0]!, id: `iterm:pane-${index}`, conversationId: id, surface: "legacy", stale: false,
    terminalSessionId: `pane-${index}`, terminal: { windowId: "window", windowIndex: 2, tabIndex: 5, paneIndex: index, paneCount: 3 },
    capabilities: { open: true, focus: true, send: false, steer: false, interrupt: false, approve: false, answer: false }, ...overrides };
}
type Element = React.ReactElement<{ children?: React.ReactNode; disabled?: boolean; onClick?: () => void }>;
const buttons = (node: React.ReactNode): Element[] => React.Children.toArray(node).flatMap((child) => {
  if (!React.isValidElement(child)) return [];
  const element = child as Element;
  return [...(element.type === "button" ? [element] : []), ...buttons(element.props.children)];
});

describe("open an original thread", () => {
  it("returns to the exact displayed live location using the server-checked action", () => {
    const onResume = vi.fn();
    const tree = OpenThreadAction({ record, sessions: [session(3)], canUseIterm: true, busy: false, onResume });
    expect(renderToStaticMarkup(tree)).toContain("回到窗口 2 · Tab 5 · 分屏 3");
    buttons(tree)[0]!.props.onClick!();
    expect(onResume).toHaveBeenCalledOnce();
  });

  it("shows each existing duplicate and never requests a new resume when one is selected", () => {
    const onResume = vi.fn(), onFocusSession = vi.fn(async () => true);
    const tree = OpenThreadAction({ record, sessions: [session(3), session(1)], canUseIterm: true, busy: false, onResume, onFocusSession });
    expect(renderToStaticMarkup(tree)).toContain("同一线程在 2 处打开");
    expect(threadLocationStatus(record, [session(3), session(1)])).toBe("已在 2 处打开");
    buttons(tree)[0]!.props.onClick!();
    expect(onFocusSession).toHaveBeenCalledWith("iterm:pane-1");
    expect(onResume).not.toHaveBeenCalled();
  });

  it("opens managed sessions in their workbench even when iTerm is offline", () => {
    const onOpenSession = vi.fn(), onResume = vi.fn();
    const tree = OpenThreadAction({ record, sessions: [session(1, { surface: "managed", terminal: undefined })], canUseIterm: false, busy: false, onResume, onOpenSession });
    expect(buttons(tree)[0]!.props.disabled).toBe(false);
    buttons(tree)[0]!.props.onClick!();
    expect(onOpenSession).toHaveBeenCalledWith("iterm:pane-1");
    expect(onResume).not.toHaveBeenCalled();
  });

  it("does not borrow another thread or a stale location despite matching names and directories", () => {
    const sessions = [session(1, { stale: true }), session(2, { conversationId: "other-thread" })];
    expect(openThreadLocations(sessions, id)).toEqual([]);
    const active = { ...record, status: "active" as const };
    expect(threadLocationStatus(active, [])).toBe("打开位置待核对");
    expect(renderToStaticMarkup(<OpenThreadAction record={active} sessions={sessions} canUseIterm busy={false} onResume={() => {}} />)).toContain("检查并回到原线程");
  });

  it("keeps a submitted restore disabled until an existing location is observed", () => {
    const props = { record, canUseIterm: true, busy: false, submitted: true, onResume: vi.fn() };
    expect(buttons(OpenThreadAction({ ...props, sessions: [] }))[0]!.props.disabled).toBe(true);
    const tree = OpenThreadAction({ ...props, sessions: [session(1)] });
    expect(buttons(tree)[0]!.props.disabled).toBe(false);
    expect(renderToStaticMarkup(tree)).toContain("回到窗口 2");
  });

  it("keeps unavailable or busy focus choices disabled", () => {
    const props = { record, sessions: [session(1), session(2)], canUseIterm: false, busy: false, onFocusSession: vi.fn(async () => true) };
    expect(buttons(OpenThreadAction(props)).every((button) => button.props.disabled)).toBe(true);
    expect(buttons(OpenThreadAction({ ...props, canUseIterm: true, busy: true })).every((button) => button.props.disabled)).toBe(true);
  });
});
