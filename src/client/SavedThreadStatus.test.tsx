import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ContinuationItem, RecoveryRecord, SessionHandoff, SessionSummary } from "../shared/types";
import { createDemoSnapshot } from "./demo";
import { HoneycombBoard } from "./HoneycombBoard";
import { getSavedThreadId, SavedThreadStatus } from "./SavedThreadStatus";
import { Workbench } from "./Workbench";

Object.assign(globalThis, { React });

const threadId = "01234567-89ab-cdef-8123-456789abcdef";
const session: SessionSummary = {
  ...createDemoSnapshot().sessions[0]!, id: threadId, conversationId: threadId,
  provider: "codex", surface: "managed", stale: false, title: "Saved state rendering",
  cwd: "/tmp/session-atlas", projectName: "session-atlas", attentionReason: null,
  pendingRequest: undefined, plan: undefined, activities: [], currentActivity: undefined,
};
const item = (status: ContinuationItem["status"]): ContinuationItem => ({
  id: status, title: "private item title", kind: "later", nextAction: "private next action", status,
});
const card = (handoff?: Partial<SessionHandoff>): RecoveryRecord => ({
  sessionId: threadId, cwd: session.cwd, title: "private card title", projectName: session.projectName,
  status: "active", firstSeenAt: session.observedAt, lastSeenAt: session.observedAt, resumeCommand: "private resume command",
  ...(handoff ? { handoff: { summary: "private summary", source: "thread", updatedAt: session.observedAt, items: [], ...handoff } } : {}),
});
const reference = { title: "private reference title", reason: "private reference reason" };
const render = (recovery?: RecoveryRecord | null, target = session) =>
  renderToStaticMarkup(<SavedThreadStatus session={target} recovery={recovery} />);

describe("saved thread status", () => {
  it.each([
    [undefined, "待核对"], [null, "未登记"], [card(), "未登记"],
    [card({ items: [item("pending"), item("done"), item("pending"), item("cancelled")] }), "待续2项"],
    [card({ items: [item("pending")], reference }), "待续1项 · 已收藏"],
    [card({ reference }), "已收藏"],
    [card({ items: [item("done")] }), "待续已完成"],
    [card({ items: [item("done"), item("cancelled")] }), "待续已结束"],
    [card({}), "已登记"],
  ])("renders saved state %# without exposing handoff content", (recovery, label) => {
    const markup = render(recovery as RecoveryRecord | null | undefined);
    expect(markup).toContain(`>${label}</span>`);
    expect(markup).not.toContain("private");
  });

  it("uses the same saved state for identified managed and legacy threads", () => {
    for (const target of [session, { ...session, id: "iterm:pane", surface: "legacy" as const, recoveryStatus: "recorded" as const }]) {
      expect(render(card({ items: [item("pending")] }), target)).toContain("待续1项");
      expect(getSavedThreadId(target)).toBe(threadId);
    }
    expect(getSavedThreadId({ ...session, conversationId: undefined })).toBe(threadId);
  });

  it("keeps ambiguous identities and wrong-record matches unconfirmed", () => {
    for (const target of [
      { ...session, id: "managed:unknown", conversationId: undefined },
      { ...session, id: "iterm:pane", conversationId: undefined, surface: "legacy" as const },
      ...(["pending", "ambiguous", "failed"] as const).map((recoveryStatus) => ({
        ...session, provider: "terminal" as const, surface: "legacy" as const, recoveryStatus,
      })),
    ]) expect(render(card({ reference }), target)).toContain(">待核对</span>");
    expect(render({ ...card({ reference }), sessionId: "another-thread" })).toContain(">待核对</span>");
  });

  it("does not label ordinary shells even when a historical card is supplied", () => {
    expect(render(card({ reference }), { ...session, provider: "terminal", surface: "legacy", conversationId: undefined, recoveryStatus: undefined })).toBe("");
  });

  it("shows the supplied recovery on the board and workbench, independently of parked attention", () => {
    const recovery = card({ items: [item("pending")], reference });
    const board = renderToStaticMarkup(<HoneycombBoard sessions={[session]} recoveries={[recovery]}
      busyAction={null} onSelect={vi.fn()} onFocus={vi.fn()} />);
    expect(board).toContain(">待续1项 · 已收藏</span>");
    expect(board).not.toContain("private");
    for (const parked of [false, true]) {
      const detail = renderToStaticMarkup(<Workbench session={{ ...session, parked }} recovery={recovery} open busyAction={null}
        onClose={vi.fn()} onSelect={vi.fn()} onFocus={vi.fn()} onSend={async () => true}
        onInterrupt={vi.fn()} onRespond={async () => true} onUpdateAttention={vi.fn()} />);
      expect(detail).toContain(">待续1项 · 已收藏</span>");
      expect(detail).toContain(`aria-label="${parked ? "取消稍后再看" : "稍后再看"}" aria-pressed="${parked}"`);
      expect(detail).not.toContain("暂存");
      expect(detail).not.toContain("private");
    }
  });
});
