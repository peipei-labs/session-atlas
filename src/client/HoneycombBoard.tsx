import { useEffect, useRef, useState, type CSSProperties, type FocusEvent } from "react";

import type { RecoveryRecord, SessionSummary } from "../shared/types";
import { deriveContinuityLane, groupSessionsByProject, groupSessionsByWindow, sessionIdentity, type ContinuityLane } from "./attention-model";
import { activityLabel, attentionLabel, formatTime, planFraction, sessionTone } from "./format";
import { Icon, type IconName } from "./icons";
import { getSavedThreadId, getSavedThreadStatus, SavedThreadStatus } from "./SavedThreadStatus";
import { ThreadTagChips } from "./ThreadTags";
import { isThreadTagId } from "./thread-tags-model";

import { MemoryBadge, MemorySummary } from "./MemoryPanel";
import type { MemoryPresentation, SessionMemory } from "./memory-model";

const ROW_SIZE = 4;
const TIP_WIDTH = 240;

type RectEdges = Pick<DOMRect, "left" | "right" | "top" | "bottom">;

export function measureHoneyTipHeight(tooltip: HTMLDivElement, width: number): number {
  const previousStyle = tooltip.style.cssText;
  const scrollTop = tooltip.scrollTop, scrollLeft = tooltip.scrollLeft;
  try {
    tooltip.style.display = "grid";
    tooltip.style.width = `${width}px`;
    tooltip.style.maxHeight = "none";
    return tooltip.getBoundingClientRect().height;
  } finally {
    tooltip.style.cssText = previousStyle;
    tooltip.scrollTop = scrollTop;
    tooltip.scrollLeft = scrollLeft;
  }
}

export function getHoneyTipPlacement(cell: RectEdges, board: RectEdges, naturalHeight: number, viewport: { width: number; height: number }) {
  const leftEdge = Math.max(8, board.left + 8);
  const rightEdge = Math.min(viewport.width - 8, board.right - 8);
  const topEdge = Math.max(8, board.top + 8);
  const bottomEdge = Math.min(viewport.height - 8, board.bottom - 8);
  const width = Math.max(1, Math.min(TIP_WIDTH, rightEdge - leftEdge));
  const above = Math.max(0, cell.top - topEdge);
  const below = Math.max(0, bottomEdge - cell.bottom);
  const isBelow = above < naturalHeight && below >= above;
  const maxHeight = Math.max(1, isBelow ? below : above);
  const height = Math.min(naturalHeight, maxHeight);
  const top = Math.max(topEdge, Math.min(isBelow ? cell.bottom : cell.top - height, bottomEdge - height));
  const left = Math.max(leftEdge, Math.min((cell.left + cell.right - width) / 2, rightEdge - width));
  return {
    below: isBelow,
    style: { display: "grid", left: left - cell.left, top: top - cell.top, width, maxHeight,
      overflowY: naturalHeight > maxHeight ? "auto" : "visible" } satisfies CSSProperties,
  };
}

export type BoardGrouping = "project" | "window";

interface HoneycombBoardProps {
  memory?: MemoryPresentation;
  sessions: SessionSummary[];
  recoveries?: readonly RecoveryRecord[];
  selectedId?: string;
  busyAction: string | null;
  groupBy?: BoardGrouping;
  laneFilter?: ContinuityLane | null;
  onSelect: (sessionId: string) => void;
  onFocus: (sessionId: string) => void;
}

export function attentionIcon(session: SessionSummary): IconName {
  switch (session.attentionReason) {
    case "needs_input":
      return "message";
    case "newly_completed":
      return "check";
    case "failed":
      return "failure";
    case "needs_approval":
      return "alert";
    default:
      break;
  }

  switch (session.activityState) {
    case "running":
      return "lightning";
    case "failed":
      return "failure";
    case "awaiting_input":
      return "message";
    case "awaiting_approval":
      return "alert";
    case "idle":
      return "clock";
    default:
      return "focus";
  }
}

function sessionLocator(session: SessionSummary): string {
  const identity = sessionIdentity(session);
  if (identity.tabIndex) {
    return identity.locator;
  }
  const compact = (session.conversationId ?? session.id)
    .replace(/[^a-z0-9]/giu, "")
    .slice(-4)
    .toLocaleUpperCase("en-US");
  return compact || identity.locator;
}

function chunkRows<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    rows.push(items.slice(index, index + size));
  }
  return rows;
}

function HoneyCell({
  session,
  recovery,
  selected,
  busy,
  dimmed = false,
  memoryEnabled = false,
  memory,
  memorySampledAt,
  memoryHighlighted = false,
  onSelect,
  onFocus,
}: {
  session: SessionSummary;
  recovery?: RecoveryRecord | null;
  selected: boolean;
  busy: boolean;
  dimmed?: boolean;
  memoryEnabled?: boolean;
  memory?: SessionMemory;
  memorySampledAt?: string;
  memoryHighlighted?: boolean;
  onSelect: () => void;
  onFocus: () => void;
}) {
  const identity = sessionIdentity(session);
  const tone = sessionTone(session);
  const status = session.stale
    ? "状态已过期"
    : session.attentionReason
      ? attentionLabel(session.attentionReason)
      : activityLabel(session.activityState);
  const activity = session.currentActivity && session.currentActivity !== session.title
    ? session.currentActivity
    : status;
  const plan = planFraction(session);
  const savedStatus = getSavedThreadStatus(session, recovery);
  const threadId = getSavedThreadId(session);
  const tags = isThreadTagId(threadId) ? session.tags ?? (recovery?.sessionId === threadId ? recovery.tags : undefined) : undefined;
  const cellRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<ReturnType<typeof getHoneyTipPlacement>>();

  const showTip = () => {
    const cell = cellRef.current;
    const tooltip = tipRef.current;
    const board = cell?.closest(".honeycomb-board");
    if (!cell || !tooltip || !board) return;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const cellRect = cell.getBoundingClientRect(), boardRect = board.getBoundingClientRect();
    const initial = getHoneyTipPlacement(cellRect, boardRect, 0, viewport);
    const height = measureHoneyTipHeight(tooltip, initial.style.width);
    setTip(getHoneyTipPlacement(cellRect, boardRect, height, viewport));
  };

  const hideTip = () => setTip(undefined);
  const tipVisible = tip !== undefined;
  useEffect(() => {
    if (!tipVisible) return;
    const board = cellRef.current?.closest(".honeycomb-board");
    board?.addEventListener("scroll", hideTip, { passive: true });
    window.addEventListener("resize", hideTip);
    return () => {
      board?.removeEventListener("scroll", hideTip);
      window.removeEventListener("resize", hideTip);
    };
  }, [tipVisible]);

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      hideTip();
    }
  };

  return (
    <div
      ref={cellRef}
      className={`honey-cell tone-${tone}${selected ? " is-selected" : ""}${session.focused ? " is-focused" : ""}${session.stale ? " is-stale" : ""}${dimmed ? " is-lane-dimmed" : ""}${tip ? ` is-tip-visible${tip.below ? " is-below" : ""}` : ""}`}
      data-testid="honey-cell"
      onPointerEnter={showTip}
      onPointerLeave={hideTip}
      onFocus={() => { if (!tipVisible) showTip(); }}
      onBlur={handleBlur}
    >
      <button
        className="honey-hit"
        type="button"
        aria-current={selected ? "true" : undefined}
        aria-label={`${identity.fullLocator}，${identity.primary}，${status}${savedStatus ? `，${savedStatus.label}` : ""}${tags?.length ? `，标签：${tags.join("、")}` : ""}${session.focused ? "，你在这里" : ""}`}
        onClick={onSelect}
      >
        <span className="honey-hex" aria-hidden="true">
          <span className="honey-hex-inner">
            <Icon name={attentionIcon(session)} />
          </span>
        </span>
        {session.pinned ? (
          <span className="honey-pinned" aria-hidden="true">
            <Icon name="pin" />
          </span>
        ) : null}
        {session.focused ? (
          <span className="honey-here" aria-hidden="true" />
        ) : null}
        <span className="honey-label">
          <code>{sessionLocator(session) || "—"}</code>
          <strong>{identity.primary}</strong>
        </span>
        {memoryEnabled ? <MemoryBadge session={session} memory={memory} highlighted={memoryHighlighted} /> : null}
        <SavedThreadStatus session={session} recovery={recovery} compact />
        <ThreadTagChips tags={tags} compact />
      </button>

      <div ref={tipRef} className="honey-tip" role="tooltip" style={tip?.style}>
        <strong>{identity.primary}</strong>
        {identity.tabIndex ? <span className="honey-tip-project">{identity.fullLocator}</span> : null}
        {identity.secondary ? (
          <span className="honey-tip-project">{identity.secondary}</span>
        ) : null}
        <span className="honey-tip-activity">{activity}</span>
        <ThreadTagChips tags={tags} />
        <span className="honey-tip-meta">
          <time dateTime={session.lastActivityAt}>{formatTime(session.lastActivityAt)}</time>
          <span>{status}</span>
          {plan ? <code>计划 {plan}</code> : null}
        </span>
        {memoryEnabled ? <MemorySummary session={session} memory={memory} sampledAt={memorySampledAt} /> : null}
        {session.branch || identity.tty ? (
          <span className="honey-tip-meta">
            {session.branch ? <code>⎇ {session.branch}</code> : null}
            {identity.tty ? <code>{identity.tty}</code> : null}
          </span>
        ) : null}
        {session.capabilities.focus ? (
          <button
            className="row-quick-action"
            type="button"
            aria-label={`跳回 ${identity.primary} 的 iTerm 会话`}
            disabled={session.stale || busy}
            onClick={onFocus}
          >
            <Icon name="focus" />
            <span>跳回 iTerm</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function HoneycombBoard({
  memory,
  sessions,
  recoveries,
  selectedId,
  busyAction,
  groupBy = "project",
  laneFilter = null,
  onSelect,
  onFocus,
}: HoneycombBoardProps) {
  const clusters =
    groupBy === "window" ? groupSessionsByWindow(sessions) : groupSessionsByProject(sessions);
  const focusPending = busyAction?.startsWith("focus:") ?? false;
  const recoveryById = new Map(recoveries?.map((recovery) => [recovery.sessionId, recovery]));

  return (
    <div className="honeycomb-board" aria-label="会话状态墙">
      {clusters.map((cluster) => (
        <section
          className={`honey-cluster is-${cluster.urgency}`}
          key={cluster.key}
          aria-label={`${cluster.name}，${cluster.sessions.length} 个会话`}
        >
          <h2 className="honey-cluster-heading">
            <span className="honey-cluster-marker" aria-hidden="true" />
            <strong>{cluster.name}</strong>
            <em>{cluster.sessions.length}</em>
          </h2>
          <div className="honeycomb-rows">
            {chunkRows(cluster.sessions, ROW_SIZE).map((row, rowIndex) => (
              <div
                className={`honeycomb-row${rowIndex % 2 ? " is-offset" : ""}`}
                key={rowIndex}
              >
                {row.map((session) => (
                  <HoneyCell
                    key={session.id}
                    session={session}
                    memoryEnabled={Boolean(memory)}
                    memory={session.terminalSessionId ? memory?.byTerminal.get(session.terminalSessionId) : undefined}
                    memorySampledAt={memory?.sampledAt}
                    memoryHighlighted={Boolean(session.terminalSessionId && memory?.highlighted.has(session.terminalSessionId))}
                    recovery={recoveries ? recoveryById.get(getSavedThreadId(session) ?? "") ?? null : undefined}
                    selected={session.id === selectedId}
                    busy={focusPending}
                    dimmed={laneFilter ? deriveContinuityLane(session) !== laneFilter : false}
                    onSelect={() => onSelect(session.id)}
                    onFocus={() => onFocus(session.id)}
                  />
                ))}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
