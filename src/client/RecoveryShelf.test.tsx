import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { RecoveryPreview, RecoveryRecord, SessionSummary } from "../shared/types";
import { RecoveryShelf } from "./RecoveryShelf";
import { OpenThreadAction } from "./OpenThreadAction";
import { createDemoSnapshot } from "./demo";

Object.assign(globalThis, { React });

const recovery: RecoveryRecord = {
  sessionId: "01234567-89ab-cdef-8123-456789abcdef",
  cwd: "/Users/example/Code/session-atlas",
  title: "Session Atlas",
  projectName: "session-atlas",
  terminalSessionId: "terminal-one",
  status: "closed",
  firstSeenAt: "2026-08-27T12:00:00.000Z",
  lastSeenAt: "2026-08-27T12:10:00.000Z",
  closedAt: "2026-08-27T12:11:00.000Z",
  resumeCommand:
    "codex resume -C '/Users/example/Code/session-atlas' '01234567-89ab-cdef-8123-456789abcdef'",
};

const preview: RecoveryPreview = {
  sessionId: recovery.sessionId,
  status: "available",
  firstRequest: "把最近关闭的线程内容显示清楚。",
  latestRequest: "再保留精确的恢复命令。",
  userMessageCount: 3,
};

describe("RecoveryShelf", () => {
  it.each(["http-first", "snapshot-first"])("allows restoring again after an observed thread closes: %s", async (order) => {
    const slots: unknown[] = [];
    const effects: Array<() => void> = [];
    let records = [recovery], sessions: SessionSummary[] = [];
    let complete!: (value: "restored") => void;
    const onOpen = vi.fn(() => new Promise<"restored">((resolve) => { complete = resolve; }));
    const live = { ...createDemoSnapshot().sessions[0]!, conversationId: recovery.sessionId, stale: false };
    const draw = () => {
      let cursor = 0;
      const internals = (React as unknown as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown } }).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
      const previous = internals.H;
      internals.H = {
        useState: (initial: unknown) => {
          const slot = cursor++;
          if (!(slot in slots)) slots[slot] = typeof initial === "function" ? initial() : initial;
          return [slots[slot], (next: unknown) => { slots[slot] = typeof next === "function" ? next(slots[slot]) : next; }];
        },
        useEffect: (effect: () => void, deps: unknown[]) => {
          const slot = cursor++, old = slots[slot] as unknown[] | undefined;
          if (!old || deps.some((dep, index) => !Object.is(dep, old[index]))) effects.push(effect);
          slots[slot] = deps;
        },
      };
      try { return RecoveryShelf({ records, sessions, canRestore: true, onOpen }); }
      finally { internals.H = previous; for (const effect of effects.splice(0)) effect(); }
    };
    const action = (node: React.ReactNode): React.ComponentProps<typeof OpenThreadAction> | undefined => {
      for (const child of React.Children.toArray(node)) {
        if (!React.isValidElement(child)) continue;
        if (child.type === OpenThreadAction) return child.props as React.ComponentProps<typeof OpenThreadAction>;
        const nested = action((child.props as { children?: React.ReactNode }).children);
        if (nested) return nested;
      }
      return undefined;
    };
    action(draw())!.onResume!();
    if (order === "snapshot-first") { sessions = [live]; records = []; draw(); }
    complete("restored"); await Promise.resolve();
    draw();
    sessions = [live]; records = []; draw();
    sessions = []; records = [recovery];
    expect(action(draw())!.submitted).toBe(false);
    action(draw())!.onResume!();
    expect(onOpen).toHaveBeenCalledTimes(2);
    complete("restored"); await Promise.resolve();
  });

  it("offers checked opening before the manual fallback for an ordinary closed thread without a card", () => {
    const markup = renderToStaticMarkup(<RecoveryShelf records={[recovery]} canRestore onOpen={async () => "restored"} />);
    expect(markup).toContain("恢复原线程");
    expect(markup.indexOf("恢复原线程")).toBeLessThan(markup.indexOf("复制备用命令"));
    expect(markup).not.toContain("未登记");
  });
  it("shows the exact session id, cwd, and copy fallback when expanded", () => {
    const markup = renderToStaticMarkup(
      <RecoveryShelf
        records={[recovery]}
        previews={{ [recovery.sessionId]: preview }}
      />,
    );

    expect(markup).toContain('data-testid="recovery-section"');
    expect(markup).toContain("最近关闭");
    expect(markup).toContain(recovery.sessionId);
    expect(markup).toContain(recovery.cwd);
    expect(markup).toContain("codex resume -C");
    expect(markup).toContain("复制备用命令");
    expect(markup).toContain("最初要求");
    expect(markup).toContain(preview.firstRequest);
    expect(markup).toContain("最后要求");
    expect(markup).toContain(preview.latestRequest);
    expect(markup).toContain("3 条用户消息");
    expect(markup).toContain("恢复信息");
    expect(markup).not.toContain("新开 Tab");
    expect(markup).not.toContain("执行恢复");
  });


  it("offers one-click recovery only for restart placeholders", () => {
    const markup = renderToStaticMarkup(
      <RecoveryShelf
        records={[recovery]}
        restartSessionIds={[recovery.sessionId]}
        canRestore
        onRestore={async () => true}
      />,
    );

    expect(markup).toContain('data-testid="recovery-restore-banner"');
    expect(markup).toContain("重启后待恢复：1 个 Codex session");
    expect(markup).toContain("一键恢复");
    expect(markup).toContain("原来的 iTerm2 tab 和分屏");
    expect(markup).toContain("Buried Sessions");
  });

  it("does not render an empty recovery section", () => {
    expect(
      renderToStaticMarkup(<RecoveryShelf records={[]} />),
    ).toBe("");
  });
});
