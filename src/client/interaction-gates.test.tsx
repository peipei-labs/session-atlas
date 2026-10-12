import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ActivityState, RecoveryRecord, SessionSummary } from "../shared/types";
import { findRestartRecoveryIds, isInteractiveShortcutTarget } from "./App";
import { Header } from "./Header";
import { LaneRail } from "./LaneRail";
import { HoneycombBoard } from "./HoneycombBoard";
import { SessionRow } from "./SessionRow";
import {
  buildSessionTitleUpdate,
  ExecutionRoute,
  submitSessionTitleUpdate,
  Workbench,
} from "./Workbench";

Object.assign(globalThis, { React });

function makeSession(
  activityState: ActivityState,
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    id: "session-1",
    provider: "codex",
    surface: "managed",
    title: "Gate regression",
    cwd: "/tmp/session-atlas",
    projectKey: "session-atlas",
    projectName: "Session Atlas",
    activityState,
    attentionReason: null,
    lastActivityAt: "2026-08-19T00:00:00.000Z",
    observedAt: "2026-08-19T00:00:00.000Z",
    stale: false,
    activities: [],
    capabilities: {
      open: true,
      focus: false,
      send: false,
      steer: false,
      interrupt: true,
      approve: false,
      answer: false,
    },
    pinned: false,
    parked: false,
    ...overrides,
  };
}

function renderDetail(
  session: SessionSummary,
  focusedSession?: SessionSummary,
  busyAction: string | null = null,
): string {
  return renderToStaticMarkup(
    <Workbench
      session={session}
      focusedSession={focusedSession}
      open
      busyAction={busyAction}
      onClose={vi.fn()}
      onSelect={vi.fn()}
      onFocus={vi.fn()}
      onSend={vi.fn(async () => true)}
      onInterrupt={vi.fn()}
      onRespond={vi.fn(async () => true)}
      onUpdateAttention={vi.fn()}
    />,
  );
}

function renderRow(
  session: SessionSummary,
  focusPending = false,
  selected = false,
): string {
  return renderToStaticMarkup(
    <SessionRow
      session={session}
      selected={selected}
      focusPending={focusPending}
      onSelect={vi.fn()}
      onFocus={vi.fn()}
    />,
  );
}

function renderBoard(
  sessions: SessionSummary[],
  selectedId?: string,
  busyAction: string | null = null,
  laneFilter?: "attention" | "running" | "returnable" | "later" | null,
): string {
  return renderToStaticMarkup(
    <HoneycombBoard
      sessions={sessions}
      selectedId={selectedId}
      busyAction={busyAction}
      laneFilter={laneFilter}
      onSelect={vi.fn()}
      onFocus={vi.fn()}
    />,
  );
}

describe("client action gates", () => {
  it("preserves native keyboard activation for focused controls", () => {
    const interactiveTarget = {
      closest: vi.fn(() => ({ tagName: "BUTTON" })),
    } as unknown as EventTarget;
    const pageTarget = {
      closest: vi.fn(() => null),
    } as unknown as EventTarget;

    expect(isInteractiveShortcutTarget(interactiveTarget)).toBe(true);
    expect(isInteractiveShortcutTarget(pageTarget)).toBe(false);
  });

  it("offers batch recovery only when the recorded pane is now an idle shell", () => {
    const recovery: RecoveryRecord = {
      sessionId: "01234567-89ab-cdef-8123-456789abcdef",
      cwd: "/tmp/session-atlas",
      title: "Session Atlas",
      projectName: "session-atlas",
      terminalSessionId: "terminal-one",
      status: "closed",
      firstSeenAt: "2026-08-19T00:00:00.000Z",
      lastSeenAt: "2026-08-19T00:10:00.000Z",
      closedAt: "2026-08-19T00:11:00.000Z",
      resumeCommand:
        "codex resume -C '/tmp/session-atlas' '01234567-89ab-cdef-8123-456789abcdef'",
    };
    const placeholder = makeSession("idle", {
      provider: "terminal",
      surface: "legacy",
      cwd: recovery.cwd,
      terminalSessionId: recovery.terminalSessionId,
      terminal: { jobName: "zsh" },
    });

    expect(findRestartRecoveryIds([recovery], [placeholder])).toEqual([recovery.sessionId]);
    expect(findRestartRecoveryIds([recovery], [{ ...placeholder, cwd: "/tmp" }])).toEqual([recovery.sessionId]);
    expect(findRestartRecoveryIds([recovery], [{ ...placeholder, terminalSessionId: "other-pane" }])).toEqual([]);
    expect(
      findRestartRecoveryIds([recovery], [
        { ...placeholder, terminal: { jobName: "codex" } },
      ]),
    ).toEqual([]);
    expect(
      findRestartRecoveryIds([{ ...recovery, restoreStatus: "partial" }], [placeholder]),
    ).toEqual([]);
    expect(
      findRestartRecoveryIds(
        [
          recovery,
          {
            ...recovery,
            sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            closedAt: "2026-08-19T00:12:00.000Z",
          },
        ],
        [placeholder],
      ),
    ).toEqual(["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]);
  });

  it("keeps a mobile search query in the expanded header state", () => {
    const markup = renderToStaticMarkup(
      <Header
        health={{ controller: "online", codex: "online", iterm: "online" }}
        query="atlas"
        canCreateThread
        searchInputRef={null}
        onCreateThread={vi.fn()}
        onQueryChange={vi.fn()}
      />,
    );

    expect(markup).toContain('class="session-search is-active"');
    expect(markup).toContain('value="atlas"');
  });

  it("shows recovery degradation as limited while both providers remain online", () => {
    const markup = renderToStaticMarkup(
      <Header
        health={{
          controller: "degraded",
          codex: "online",
          iterm: "online",
          recovery: "degraded",
        }}
        query=""
        canCreateThread
        searchInputRef={null}
        onCreateThread={vi.fn()}
        onQueryChange={vi.fn()}
      />,
    );

    expect(markup).toContain('class="connection-state is-limited"');
    expect(markup).toContain("受限");
    expect(markup).not.toContain("离线");
  });

  it.each(["awaiting_approval", "awaiting_input"] satisfies ActivityState[])(
    "keeps interrupt enabled while %s when the provider permits it",
    (activityState) => {
      const markup = renderDetail(makeSession(activityState));
      const interruptButton = markup.match(
        /<button class="action-button is-destructive"[^>]*>.*?中断任务<\/span><\/button>/s,
      )?.[0];

      expect(interruptButton).toBeDefined();
      expect(interruptButton).not.toContain('disabled=""');
    },
  );

  it("disables legacy focus actions when the session is stale", () => {
    const staleLegacy = makeSession("unknown", {
      provider: "terminal",
      surface: "legacy",
      stale: true,
      capabilities: {
        open: false,
        focus: true,
        send: false,
        steer: false,
        interrupt: false,
        approve: false,
        answer: false,
      },
    });

    const detailMarkup = renderDetail(staleLegacy);
    const rowMarkup = renderRow(staleLegacy);

    const detailFocusButton = detailMarkup.match(
      /<button class="action-button is-primary"[^>]*>.*?跳回 iTerm<\/span><\/button>/s,
    )?.[0];

    expect(detailFocusButton).toContain('disabled=""');
    expect(rowMarkup).not.toContain('class="session-row-focus"');
    expect(detailMarkup).toContain("状态已经过期");
    expect(detailMarkup).not.toContain("发送消息给 Codex");
    expect(detailMarkup).not.toContain("中断任务");
    expect(detailMarkup).not.toContain("处理审批");
    expect(detailMarkup).not.toContain("回答问题");
  });

  it("disables every focus button while an iTerm switch is in progress", () => {
    const first = makeSession("idle", {
      id: "first",
      provider: "terminal",
      surface: "legacy",
      capabilities: {
        open: false,
        focus: true,
        send: false,
        steer: false,
        interrupt: false,
        approve: false,
        answer: false,
      },
    });
    const second = { ...first, id: "second", title: "Second" };

    const detailMarkup = renderDetail(first, undefined, "focus:second");
    const firstRow = renderRow(first, true);
    const secondRow = renderRow(second, true);

    const detailFocusButton = detailMarkup.match(
      /<button class="action-button is-primary"[^>]*>.*?切换中…<\/span><\/button>/s,
    )?.[0];

    expect(detailFocusButton).toContain('disabled=""');
    expect(firstRow).toMatch(/<button class="session-row-focus"[^>]*disabled=""/);
    expect(secondRow).toMatch(/<button class="session-row-focus"[^>]*disabled=""/);
  });

  it("clusters every routed session by project on the honeycomb board", () => {
    const sessions = [
      makeSession("awaiting_input", {
        id: "needs-input",
        title: "Needs input",
        attentionReason: "needs_input",
      }),
      makeSession("running", { id: "running", title: "Running" }),
      makeSession("idle", { id: "returnable", title: "Returnable" }),
      makeSession("idle", {
        id: "other-project",
        title: "Other",
        projectKey: "other",
        projectName: "Other Project",
      }),
    ];
    const markup = renderBoard(sessions);

    expect(markup.match(/data-testid="honey-cell"/g)).toHaveLength(4);
    expect(markup.match(/class="honey-cluster is-/g)).toHaveLength(2);
    expect(markup).toContain("Session Atlas");
    expect(markup).toContain("Other Project");
    expect(markup).toContain('aria-label="会话状态墙"');
  });

  it("lets a stale cell keep its tooltip but disables the jump-back action", () => {
    const stale = makeSession("unknown", {
      id: "stale",
      stale: true,
      capabilities: {
        open: false,
        focus: true,
        send: false,
        steer: false,
        interrupt: false,
        approve: false,
        answer: false,
      },
    });
    const markup = renderBoard([stale]);

    expect(markup).toContain("is-stale");
    expect(markup).toContain("状态已过期");
    const quickAction = markup.match(/<button class="row-quick-action"[^>]*>/)?.[0];
    expect(quickAction).toContain('disabled=""');
  });

  it("disables the tooltip jump-back action while that focus request is busy", () => {
    const session = makeSession("idle", {
      id: "busy-focus",
      capabilities: {
        open: false,
        focus: true,
        send: false,
        steer: false,
        interrupt: false,
        approve: false,
        answer: false,
      },
    });
    const markup = renderBoard([session], undefined, "focus:busy-focus");

    const quickAction = markup.match(/<button class="row-quick-action"[^>]*>/)?.[0];
    expect(quickAction).toContain('disabled=""');
  });

  it("disables every tooltip jump-back action while any focus request is busy", () => {
    const first = makeSession("idle", {
      id: "first-focus",
      capabilities: {
        open: false,
        focus: true,
        send: false,
        steer: false,
        interrupt: false,
        approve: false,
        answer: false,
      },
    });
    const second = { ...first, id: "second-focus", title: "Second focus" };
    const markup = renderBoard([first, second], undefined, "focus:first-focus");
    const actions = markup.match(/<button class="row-quick-action"[^>]*>/g) ?? [];

    expect(actions).toHaveLength(2);
    expect(actions.every((action) => action.includes('disabled=""'))).toBe(true);
  });

  it("renders the Workbench as a native modal dialog", () => {
    const markup = renderDetail(makeSession("idle"));

    expect(markup).toContain('<dialog class="workbench is-open"');
  });

  it("renders every cell without hiding identities behind an overflow", () => {
    const sessions = Array.from({ length: 6 }, (_, index) =>
      makeSession("idle", {
        id: `returnable-${index + 1}`,
        title: `Returnable ${index + 1}`,
      }),
    );
    const markup = renderBoard(sessions);

    expect(markup.match(/data-testid="honey-cell"/g)).toHaveLength(6);
    expect(markup).toContain("Returnable 1");
    expect(markup).toContain("Returnable 6");
  });

  it("marks the focused iTerm session separately from the selected row", () => {
    const selected = makeSession("idle", {
      id: "selected",
      title: "Selected workbench",
      focused: false,
    });
    const focused = makeSession("running", {
      id: "focused",
      title: "Focused terminal",
      focused: true,
      terminal: { tabIndex: 7, tabCount: 10, tty: "/dev/ttys077" },
    });
    const boardMarkup = renderBoard([selected, focused], "selected");
    const detailMarkup = renderDetail(selected, focused);

    const selectedCell = boardMarkup.match(/<div[^>]*data-testid="honey-cell"[^>]*>/g) ?? [];
    expect(selectedCell.some((cell) => cell.includes("is-selected"))).toBe(true);
    expect(selectedCell.some((cell) => cell.includes("is-focused"))).toBe(true);
    expect(boardMarkup).toContain("你在这里");
    expect(detailMarkup).toContain('<span class="is-selected">正在查看</span>');
    expect(detailMarkup).not.toContain('<span class="is-focused">你在这里</span>');
    expect(detailMarkup).toContain('aria-label="iTerm 实际位置"');
    expect(detailMarkup).toContain("07 · Focused terminal");
  });

  it("surfaces the lane nav, attention queue, and focus chip in the lane rail", () => {
    const waiting = makeSession("awaiting_input", {
      id: "waiting",
      title: "Needs input",
      attentionReason: "needs_input",
    });
    const focused = makeSession("running", {
      id: "focused",
      title: "Focused terminal",
      focused: true,
      terminal: { tabIndex: 7, windowIndex: 1, tty: "/dev/ttys077" },
    });
    const idle = makeSession("idle", { id: "idle", title: "Idle one" });
    const markup = renderToStaticMarkup(
      <LaneRail sessions={[waiting, focused, idle]} focusedSession={focused} laneFilter={null} onLaneFilter={vi.fn()} onSelect={vi.fn()} />,
    );

    expect(markup).toContain('data-testid="focus-chip"');
    expect(markup).toContain("你在这里");
    expect(markup).toContain("Focused terminal");
    expect(markup.match(/data-testid="queue-chip"/g)).toHaveLength(1);
    expect(markup).toContain("Needs input");
    expect(markup).toContain("等待回答");
    expect(markup.match(/data-testid="lane-button"/g)).toHaveLength(4);
    expect(markup).toContain("等待你");
    expect(markup).toContain("后台推进");
    expect(markup).toContain("可随时返回");
    expect(markup).toContain("稍后");
    expect(markup).not.toContain("is-active");
  });

  it("always renders the lane nav, even with no sessions and no focus", () => {
    const markup = renderToStaticMarkup(
      <LaneRail sessions={[]} laneFilter={null} onLaneFilter={vi.fn()} onSelect={vi.fn()} />,
    );

    expect(markup.match(/data-testid="lane-button"/g)).toHaveLength(4);
    expect(markup).not.toContain('data-testid="focus-chip"');
    expect(markup).not.toContain('data-testid="queue-chip"');
  });

  it("marks the filtered lane as pressed and toggles it back off", () => {
    const onLaneFilter = vi.fn();
    const active = renderToStaticMarkup(
      <LaneRail sessions={[makeSession("running")]} laneFilter="running" onLaneFilter={onLaneFilter} onSelect={vi.fn()} />,
    );
    expect(active).toContain('data-lane="running"');
    expect(active).toMatch(/class="lane-nav-button is-active"[^>]*data-lane="running"|data-lane="running"[^>]*aria-pressed="true"/);

    const tree = LaneRail({ sessions: [], laneFilter: "running", onLaneFilter, onSelect: vi.fn() });
    const buttons = (function walk(node: React.ReactNode): React.ReactElement<{ "data-lane"?: string; onClick?: () => void }>[] {
      return React.Children.toArray(node).flatMap((child) =>
        React.isValidElement(child)
          ? [child as React.ReactElement<{ "data-lane"?: string; onClick?: () => void }>, ...walk((child as React.ReactElement<{ children?: React.ReactNode }>).props.children)]
          : []);
    })(tree);
    buttons.find((button) => button.props["data-lane"] === "running")!.props.onClick!();
    expect(onLaneFilter).toHaveBeenCalledWith(null);
  });

  it("dims cells outside the active lane filter without removing them", () => {
    const waiting = makeSession("awaiting_input", {
      id: "waiting",
      title: "Needs input",
      attentionReason: "needs_input",
    });
    const running = makeSession("running", { id: "running", title: "Running" });
    const markup = renderBoard([waiting, running], undefined, null, "attention");

    const cells = markup.match(/<div[^>]*data-testid="honey-cell"[^>]*>/g) ?? [];
    expect(cells).toHaveLength(2);
    const waitingCell = cells.find((cell) => cell.includes("tone-attention"))!;
    const runningCell = cells.find((cell) => !cell.includes("tone-attention"))!;
    expect(waitingCell).not.toContain("is-lane-dimmed");
    expect(runningCell).toContain("is-lane-dimmed");

    const unfiltered = renderBoard([waiting, running]);
    expect(unfiltered).not.toContain("is-lane-dimmed");
  });

  it("puts the action surface before the execution route and recent activity", () => {
    const markup = renderDetail(
      makeSession("idle", {
        attentionReason: "newly_completed",
        stale: true,
        currentActivity: "整理验收结果",
        plan: {
          done: 1,
          total: 2,
          steps: [
            { id: "done", label: "完成实现", status: "completed" },
            { id: "verify", label: "等待验收", status: "in_progress" },
          ],
        },
        activities: [
          {
            id: "activity-1",
            at: "2026-08-19T00:00:00.000Z",
            label: "完成实现",
          },
        ],
      }),
    );

    const metaIndex = markup.indexOf('class="session-meta"');
    const focusIndex = markup.indexOf('class="current-activity"');
    const staleIndex = markup.indexOf('class="stale-notice"');
    const interactionIndex = markup.indexOf('class="interaction-grid');
    const planIndex = markup.indexOf('class="detail-section plan-section"');
    const activityIndex = markup.indexOf('class="detail-section activity-section"');
    const auxiliaryIndex = markup.indexOf('class="detail-bottom-actions"');

    expect(metaIndex).toBeGreaterThanOrEqual(0);
    expect(metaIndex).toBeLessThan(focusIndex);
    expect(focusIndex).toBeLessThan(staleIndex);
    expect(staleIndex).toBeLessThan(interactionIndex);
    expect(interactionIndex).toBeLessThan(planIndex);
    expect(planIndex).toBeLessThan(activityIndex);
    expect(activityIndex).toBeLessThan(auxiliaryIndex);
    expect(markup).toContain("执行路线");
    expect(markup).not.toContain("执行计划");
  });

  it.each([
    ["managed", "该会话未上报执行路线"],
    ["legacy", "该终端未上报执行路线"],
  ] as const)("uses truthful no-plan copy for %s sessions", (surface, copy) => {
    const markup = renderDetail(
      makeSession("idle", {
        provider: surface === "legacy" ? "terminal" : "codex",
        surface,
        plan: undefined,
      }),
    );

    expect(markup).toContain(copy);
    expect(markup).not.toContain("执行计划");
  });

  it("renders observed Codex work as an execution record without calling it a future plan", () => {
    const session = makeSession("running", {
      conversationId: "thread-one",
      surface: "legacy",
      plan: undefined,
    });
    const markup = renderToStaticMarkup(
      <ExecutionRoute
        session={session}
        detail={{
          sessionId: session.id,
          execution: {
            turnId: "turn-one",
            turnStatus: "in_progress",
            observedAt: "2026-08-19T00:00:00.000Z",
            truncated: false,
            steps: [
              { id: "received", label: "收到本轮任务", status: "completed" },
              { id: "commands", label: "执行命令", status: "completed", count: 3 },
              { id: "current", label: "正在处理下一步", status: "in_progress" },
            ],
          },
        }}
      />,
    );

    expect(markup).toContain("实际执行记录");
    expect(markup).toContain("收到本轮任务");
    expect(markup).toContain("执行命令");
    expect(markup).toContain("× 3");
    expect(markup).toContain("正在处理下一步");
    expect(markup).toContain("只表示已经发生和正在进行的操作");
    expect(markup).not.toContain("待执行");
    expect(markup).not.toContain("plan-progress");
  });

  it("renders a reported plan alongside observed item history", () => {
    const session = makeSession("running", {
      plan: {
        done: 1,
        total: 3,
        steps: [
          { id: "inspect", label: "检查现状", status: "completed" },
          { id: "implement", label: "实现功能", status: "in_progress" },
          { id: "verify", label: "完成验收", status: "pending" },
        ],
      },
    });
    const markup = renderToStaticMarkup(
      <ExecutionRoute
        session={session}
        detail={{
          sessionId: session.id,
          execution: {
            turnId: "turn-one",
            turnStatus: "in_progress",
            observedAt: "2026-08-19T00:00:00.000Z",
            truncated: false,
            steps: [{ id: "command", label: "执行命令", status: "completed" }],
          },
        }}
      />,
    );

    expect(markup).toContain("执行路线");
    expect(markup).toContain("检查现状");
    expect(markup).toContain("实现功能");
    expect(markup).toContain("完成验收");
    expect(markup).toContain("待执行");
    expect(markup).not.toContain("plan-progress");
    expect(markup).toContain("实际执行记录");
    expect(markup).toContain("执行命令");
  });

  it("offers a bounded session naming form without making it the primary action", () => {
    const markup = renderDetail(makeSession("idle", { title: "Code (codex)" }));

    expect(markup).toContain('aria-label="重命名会话"');
    expect(markup).toContain('class="session-title-edit-form" hidden=""');
    expect(markup).toContain('value="Code (codex)"');
    expect(markup).toContain('maxLength="120"');
    expect(markup).not.toMatch(/session-title-edit-(?:trigger|form)[\s\S]*data-primary-action="true"/);
  });

  it("builds the trimmed title payload and rejects an empty submission", () => {
    const onUpdate = vi.fn();

    expect(buildSessionTitleUpdate("  Atlas dashboard  ")).toEqual({
      title: "Atlas dashboard",
    });
    expect(buildSessionTitleUpdate("   ")).toBeNull();
    expect(submitSessionTitleUpdate("session-1", "  Atlas dashboard  ", onUpdate)).toBe(true);
    expect(onUpdate).toHaveBeenCalledWith("session-1", { title: "Atlas dashboard" });
    expect(submitSessionTitleUpdate("session-1", "   ", onUpdate)).toBe(false);
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("offers acknowledge only for a newly completed result", () => {
    const markup = renderDetail(
      makeSession("idle", { attentionReason: "newly_completed" }),
    );

    expect(markup).toContain("标记已查看");
    expect(markup).not.toContain("查看结果");
  });

  it("does not let a failed session disappear through acknowledge", () => {
    const markup = renderDetail(makeSession("failed", { attentionReason: "failed" }));

    expect(markup).toContain("执行失败");
    expect(markup).not.toContain("标记已查看");
  });

  it("marks the first safe approval choice as the primary action", () => {
    const approval = makeSession("awaiting_approval", {
      capabilities: {
        ...makeSession("idle").capabilities,
        approve: true,
      },
      pendingRequest: {
        requestId: "request-1",
        threadId: "thread-1",
        kind: "approval",
        title: "允许执行命令吗？",
        choices: [
          { id: "decline", label: "拒绝" },
          { id: "accept", label: "允许" },
        ],
        receivedAt: "2026-08-19T00:00:00.000Z",
      },
    });
    const primaryButton = renderDetail(approval).match(
      /<button[^>]*data-primary-action="true"[^>]*>.*?<\/button>/s,
    )?.[0];

    expect(primaryButton).toContain("允许");

    const destructiveOnly = renderDetail({
      ...approval,
      pendingRequest: {
        ...approval.pendingRequest!,
        choices: [{ id: "decline", label: "拒绝" }],
      },
    });
    expect(destructiveOnly).not.toContain('data-primary-action="true"');
  });
});
