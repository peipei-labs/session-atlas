import type {
  ItermWindowLayoutRecord,
  RecoveryRecord,
  SessionAtlasHealth,
  SessionSummary,
} from "../shared/types";
import { shortId } from "./format";

export type ContinuityLane = "attention" | "running" | "returnable" | "later";

export interface SessionIdentity {
  primary: string;
  secondary?: string;
  locator: string;
  fullLocator: string;
  tty?: string;
  shortcut?: string;
  windowIndex?: number;
  tabIndex?: number;
  tabCount?: number;
  paneIndex?: number;
  paneCount?: number;
  hasHierarchy: boolean;
}

const laneOrder: Record<ContinuityLane, number> = {
  attention: 0,
  running: 1,
  returnable: 2,
  later: 3,
};

function pathBasename(value?: string): string | undefined {
  const parts = value
    ?.trim()
    .split(/[\\/]+/)
    .filter(Boolean);
  return parts?.at(-1);
}

function compactPath(value?: string): string | undefined {
  const parts = value
    ?.trim()
    .split(/[\\/]+/)
    .filter(Boolean);
  return parts?.slice(-2).join("/");
}

const BRAILLE_SPINNER_PREFIX = /^[\s\u200B-\u200D\uFEFF]*[\u2800-\u28FF]+\s*/u;
const GENERIC_LEGACY_TITLE = /^(?:iterm session|terminal|shell)$/i;

function cleanSessionTitle(value: string): string {
  return value.trim().replace(BRAILLE_SPINNER_PREFIX, "").trim();
}

function usefulProjectName(value: string): string | undefined {
  const projectName = value.trim();
  return projectName && projectName.toLocaleLowerCase("en-US") !== "unknown project"
    ? projectName
    : undefined;
}

function positiveInteger(value?: number): number | undefined {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value : undefined;
}

function terminalShortcut(tabIndex?: number, tabCount?: number): string | undefined {
  if (!tabIndex) {
    return undefined;
  }
  if (tabIndex <= 8) {
    return `⌘${tabIndex}`;
  }
  if (tabCount && tabCount > 8 && tabIndex === tabCount) {
    return "⌘9 · LAST";
  }
  return undefined;
}

function compareText(a: string, b: string): number {
  const normalizedA = a.trim().normalize("NFKC").toLocaleLowerCase("zh-CN");
  const normalizedB = b.trim().normalize("NFKC").toLocaleLowerCase("zh-CN");

  if (normalizedA < normalizedB) {
    return -1;
  }
  if (normalizedA > normalizedB) {
    return 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareStable(a: SessionSummary, b: SessionSummary): number {
  return compareText(displaySessionName(a), displaySessionName(b)) || compareText(a.id, b.id);
}

function compareFocusedPinnedStable(a: SessionSummary, b: SessionSummary): number {
  if (Boolean(a.focused) !== Boolean(b.focused)) {
    return a.focused ? -1 : 1;
  }
  if (a.pinned !== b.pinned) {
    return a.pinned ? -1 : 1;
  }
  return compareStable(a, b);
}

function attentionPriority(session: SessionSummary): number {
  if (
    session.attentionReason === "needs_approval" ||
    session.pendingRequest?.kind === "approval" ||
    session.activityState === "awaiting_approval"
  ) {
    return 0;
  }
  if (
    session.attentionReason === "needs_input" ||
    session.pendingRequest?.kind === "question" ||
    session.activityState === "awaiting_input"
  ) {
    return 1;
  }
  if (session.attentionReason === "failed" || session.activityState === "failed") {
    return 2;
  }
  if (session.attentionReason === "newly_completed") {
    return 3;
  }
  return 4;
}

function compareManagedRecency(a: SessionSummary, b: SessionSummary): number {
  const aManaged = a.surface === "managed";
  const bManaged = b.surface === "managed";
  if (aManaged !== bManaged) {
    return aManaged ? -1 : 1;
  }
  if (!aManaged) {
    return 0;
  }

  const aTime = Date.parse(a.lastActivityAt);
  const bTime = Date.parse(b.lastActivityAt);
  if (!Number.isFinite(aTime) || !Number.isFinite(bTime)) {
    return 0;
  }
  return bTime - aTime;
}

function compareAttention(a: SessionSummary, b: SessionSummary): number {
  if (a.pinned !== b.pinned) {
    return a.pinned ? -1 : 1;
  }

  return (
    attentionPriority(a) - attentionPriority(b) ||
    compareManagedRecency(a, b) ||
    compareStable(a, b)
  );
}

function uniqueById(sessions: SessionSummary[]): SessionSummary[] {
  const seen = new Set<string>();
  return sessions.filter((session) => {
    if (seen.has(session.id)) {
      return false;
    }
    seen.add(session.id);
    return true;
  });
}

function normalizedLimit(limit: number): number {
  return Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
}

export function deriveContinuityLane(session: SessionSummary): ContinuityLane {
  if (session.parked || session.stale || session.buried || session.activityState === "offline") {
    return "later";
  }
  if (
    session.attentionReason !== null ||
    session.activityState === "awaiting_input" ||
    session.activityState === "awaiting_approval" ||
    session.activityState === "failed"
  ) {
    return "attention";
  }
  if (session.activityState === "running") {
    return "running";
  }
  return "returnable";
}

export function continuityLaneLabel(lane: ContinuityLane): string {
  switch (lane) {
    case "attention":
      return "等待你";
    case "running":
      return "后台推进";
    case "returnable":
      return "可随时返回";
    case "later":
      return "稍后";
  }
}

export function displaySessionName(session: SessionSummary): string {
  const title = cleanSessionTitle(session.title);
  if (session.surface !== "legacy" && title) {
    return title;
  }
  if (title && !GENERIC_LEGACY_TITLE.test(title)) {
    return title;
  }

  const pathName = pathBasename(session.cwd) ?? pathBasename(session.terminal?.tty);
  if (pathName) {
    return pathName;
  }

  const projectName = usefulProjectName(session.projectName);
  if (projectName) {
    return projectName;
  }

  const terminalIdentity = session.terminalSessionId ?? session.id.replace(/^iterm:/, "");
  return session.surface === "legacy"
    ? `iTerm · ${shortId(terminalIdentity)}`
    : title || shortId(session.id);
}

export function sessionIdentity(session: SessionSummary): SessionIdentity {
  const terminal = session.terminal;
  const windowIndex = positiveInteger(terminal?.windowIndex);
  const tabIndex = positiveInteger(terminal?.tabIndex);
  const tabCount = positiveInteger(terminal?.tabCount);
  const paneIndex = positiveInteger(terminal?.paneIndex);
  const paneCount = positiveInteger(terminal?.paneCount);
  const tty = pathBasename(terminal?.tty);
  const projectName = usefulProjectName(session.projectName);
  const cwdLabel = compactPath(session.cwd);
  const secondary = session.surface === "legacy"
    ? cwdLabel ?? projectName
    : projectName ?? cwdLabel;
  const fallbackIdentity =
    session.terminalSessionId ?? session.conversationId ?? session.id.replace(/^iterm:/, "");
  const tabLocator = tabIndex ? String(tabIndex).padStart(2, "0") : undefined;
  const baseLocator = tabLocator ? windowIndex ? `${windowIndex}·${tabLocator}` : tabLocator : tty ?? shortId(fallbackIdentity);
  const locator = paneIndex && ((paneCount ?? 0) > 1 || paneIndex > 1) ? `${baseLocator}/P${paneIndex}` : baseLocator;

  return {
    primary: displaySessionName(session),
    secondary,
    locator,
    fullLocator: [windowIndex ? `窗口 ${windowIndex}` : undefined, tabIndex ? `Tab ${tabIndex}` : undefined,
      paneIndex ? `分屏 ${paneIndex}` : undefined].filter(Boolean).join(" · ") || locator,
    tty,
    shortcut: terminalShortcut(tabIndex, tabCount),
    windowIndex,
    tabIndex,
    tabCount,
    paneIndex,
    paneCount,
    hasHierarchy: Boolean(
      terminal?.windowId ||
        terminal?.tabId ||
        windowIndex ||
        tabIndex ||
        paneIndex ||
        typeof terminal?.currentWindow === "boolean",
    ),
  };
}

export function buildAttentionQueue(
  sessions: SessionSummary[],
  limit = 4,
): SessionSummary[] {
  const queueLimit = normalizedLimit(limit);
  if (queueLimit === 0) {
    return [];
  }

  const uniqueSessions = uniqueById(sessions);
  return uniqueSessions
    .filter((session) => deriveContinuityLane(session) === "attention")
    .sort(compareAttention)
    .slice(0, queueLimit);
}

export function buildNavigationQueue(sessions: SessionSummary[]): SessionSummary[] {
  const attentionQueue = buildAttentionQueue(sessions, sessions.length);
  const queuedIds = new Set(attentionQueue.map((session) => session.id));
  const remaining = uniqueById(sessions)
    .filter((session) => !queuedIds.has(session.id))
    .sort(
      (a, b) =>
        laneOrder[deriveContinuityLane(a)] - laneOrder[deriveContinuityLane(b)] ||
        compareFocusedPinnedStable(a, b),
    );

  return [...attentionQueue, ...remaining];
}

export function chooseInitialSessionId(
  sessions: SessionSummary[],
  persistedId?: string,
): string | undefined {
  const uniqueSessions = uniqueById(sessions);

  if (persistedId && uniqueSessions.some((session) => session.id === persistedId)) {
    return persistedId;
  }

  const attention = uniqueSessions
    .filter((session) => deriveContinuityLane(session) === "attention")
    .sort(compareAttention)[0];
  if (attention) {
    return attention.id;
  }

  const focused = uniqueSessions.filter((session) => session.focused).sort(compareStable)[0];
  if (focused) {
    return focused.id;
  }

  const pinned = uniqueSessions.filter((session) => session.pinned).sort(compareStable)[0];
  return pinned?.id ?? uniqueSessions.sort(compareStable)[0]?.id;
}

export function groupContinuityLanes(
  sessions: SessionSummary[],
): Record<ContinuityLane, SessionSummary[]> {
  const groups: Record<ContinuityLane, SessionSummary[]> = {
    attention: [],
    running: [],
    returnable: [],
    later: [],
  };

  for (const session of uniqueById(sessions)) {
    groups[deriveContinuityLane(session)].push(session);
  }

  groups.attention.sort(compareAttention);
  groups.running.sort(compareFocusedPinnedStable);
  groups.returnable.sort(compareFocusedPinnedStable);
  groups.later.sort(compareFocusedPinnedStable);
  return groups;
}

export interface ProjectCluster {
  key: string;
  name: string;
  sessions: SessionSummary[];
  urgency: ContinuityLane;
}

export function groupSessionsByProject(sessions: SessionSummary[]): ProjectCluster[] {
  const clusters = new Map<string, ProjectCluster>();

  for (const session of uniqueById(sessions)) {
    const key = session.projectKey || session.projectName || "ungrouped";
    const existing = clusters.get(key);
    if (existing) {
      existing.sessions.push(session);
    } else {
      clusters.set(key, {
        key,
        name: session.projectName || session.projectKey || "未分组",
        sessions: [session],
        urgency: "later",
      });
    }
  }

  const ordered = Array.from(clusters.values());
  for (const cluster of ordered) {
    cluster.sessions.sort(
      (a, b) =>
        laneOrder[deriveContinuityLane(a)] - laneOrder[deriveContinuityLane(b)] ||
        compareFocusedPinnedStable(a, b),
    );
    cluster.urgency = deriveContinuityLane(cluster.sessions[0]!);
  }

  return ordered.sort(
    (a, b) =>
      laneOrder[a.urgency] - laneOrder[b.urgency] ||
      Date.parse(b.sessions[0]!.lastActivityAt) - Date.parse(a.sessions[0]!.lastActivityAt) ||
      a.name.localeCompare(b.name, "zh-CN"),
  );
}

export function groupSessionsByWindow(sessions: SessionSummary[]): ProjectCluster[] {
  interface WindowClusterDraft {
    cluster: ProjectCluster;
    windowIndex?: number;
  }
  const drafts = new Map<string, WindowClusterDraft>();

  for (const session of uniqueById(sessions)) {
    const windowIndex = positiveInteger(session.terminal?.windowIndex);
    const key =
      session.terminal?.windowId ?? (windowIndex ? `index:${windowIndex}` : "unlocated");
    const existing = drafts.get(key);
    if (existing) {
      existing.cluster.sessions.push(session);
      if (existing.windowIndex === undefined && windowIndex !== undefined) {
        existing.windowIndex = windowIndex;
        existing.cluster.name = `窗口 ${windowIndex}`;
      }
    } else {
      drafts.set(key, {
        windowIndex,
        cluster: {
          key,
          name: windowIndex ? `窗口 ${windowIndex}` : "未定位窗口",
          sessions: [session],
          urgency: "later",
        },
      });
    }
  }

  const ordered = Array.from(drafts.values());
  for (const draft of ordered) {
    draft.cluster.sessions.sort(
      (a, b) =>
        compareOptionalNumber(positiveInteger(a.terminal?.tabIndex), positiveInteger(b.terminal?.tabIndex)) ||
        compareOptionalNumber(positiveInteger(a.terminal?.paneIndex), positiveInteger(b.terminal?.paneIndex)) ||
        compareText(a.id, b.id),
    );
    draft.cluster.urgency = draft.cluster.sessions.reduce<ContinuityLane>((urgency, session) => {
      const lane = deriveContinuityLane(session);
      return laneOrder[lane] < laneOrder[urgency] ? lane : urgency;
    }, "later");
  }

  return ordered
    .sort(
      (a, b) =>
        compareOptionalNumber(a.windowIndex, b.windowIndex) ||
        a.cluster.name.localeCompare(b.cluster.name, "zh-CN"),
    )
    .map((draft) => draft.cluster);
}

/* ---------- iTerm tab grouping (moved from TerminalDeck) ---------- */

export interface TerminalTabGroup {
  key: string;
  representative: SessionSummary;
  sessions: SessionSummary[];
  identity: SessionIdentity;
  windowIndex?: number;
  tabIndex?: number;
  tabCount?: number;
  paneCount: number;
  focused: boolean;
}

function compareOptionalNumber(a?: number, b?: number): number {
  if (a === b) {
    return 0;
  }
  if (a === undefined) {
    return 1;
  }
  if (b === undefined) {
    return -1;
  }
  return a - b;
}

function comparePanes(a: SessionSummary, b: SessionSummary): number {
  if (Boolean(a.focused) !== Boolean(b.focused)) {
    return a.focused ? -1 : 1;
  }
  return (
    compareOptionalNumber(
      positiveInteger(a.terminal?.paneIndex),
      positiveInteger(b.terminal?.paneIndex),
    ) || a.id.localeCompare(b.id)
  );
}

function terminalTabKey(session: SessionSummary): string {
  const terminal = session.terminal;
  if (terminal?.tabId) {
    return `tab:${terminal.windowId ?? "current"}:${terminal.tabId}`;
  }
  const windowIndex = positiveInteger(terminal?.windowIndex);
  const tabIndex = positiveInteger(terminal?.tabIndex);
  if (windowIndex && tabIndex) {
    return `tab-index:${windowIndex}:${tabIndex}`;
  }
  return `session:${session.id}`;
}

export function groupTerminalTabs(sessions: SessionSummary[]): TerminalTabGroup[] {
  const visibleTerminals = sessions.filter(
    (session) =>
      session.surface === "legacy" &&
      !session.buried &&
      !session.stale &&
      session.activityState !== "offline",
  );
  const hasWindowMetadata = visibleTerminals.some(
    (session) => typeof session.terminal?.currentWindow === "boolean",
  );
  const currentWindowSessions = hasWindowMetadata
    ? visibleTerminals.filter((session) => session.terminal?.currentWindow === true)
    : visibleTerminals;
  const grouped = new Map<string, SessionSummary[]>();

  for (const session of currentWindowSessions) {
    const key = terminalTabKey(session);
    const group = grouped.get(key);
    if (group) {
      group.push(session);
    } else {
      grouped.set(key, [session]);
    }
  }

  const tabs = Array.from(grouped, ([key, tabSessions]) => {
    const orderedSessions = tabSessions.slice().sort(comparePanes);
    const representative = orderedSessions[0]!;
    const identity = sessionIdentity(representative);
    const reportedPaneCount = orderedSessions.reduce(
      (maximum, session) =>
        Math.max(maximum, positiveInteger(session.terminal?.paneCount) ?? 0),
      0,
    );

    return {
      key,
      representative,
      sessions: orderedSessions,
      identity,
      windowIndex: positiveInteger(representative.terminal?.windowIndex),
      tabIndex: identity.tabIndex,
      tabCount: identity.tabCount,
      paneCount: Math.max(orderedSessions.length, reportedPaneCount),
      focused: orderedSessions.some((session) => session.focused),
    } satisfies TerminalTabGroup;
  });

  return tabs.sort(
    (a, b) =>
      compareOptionalNumber(a.windowIndex, b.windowIndex) ||
      compareOptionalNumber(a.tabIndex, b.tabIndex) ||
      a.identity.primary.localeCompare(b.identity.primary, "zh-CN") ||
      a.key.localeCompare(b.key),
  );
}

/* ---------- recovery & window-layout restore eligibility ---------- */

const IDLE_SHELLS = new Set(["bash", "dash", "fish", "nu", "sh", "tcsh", "zsh"]);

export function findRestartRecoveryIds(
  recoveries: readonly RecoveryRecord[],
  sessions: readonly SessionSummary[],
): string[] {
  const liveByTerminalId = new Map(
    sessions.flatMap((session) =>
      session.terminalSessionId ? [[session.terminalSessionId, session] as const] : [],
    ),
  );
  const newestByTerminalId = new Map<string, RecoveryRecord>();
  for (const recovery of recoveries) {
    if (
      recovery.status !== "closed" ||
      recovery.restoreStatus === "partial" ||
      !recovery.terminalSessionId
    ) {
      continue;
    }
    const live = liveByTerminalId.get(recovery.terminalSessionId);
    const jobName = live?.terminal?.jobName?.trim().toLowerCase();
    const eligible = live &&
      live.surface === "legacy" &&
      !live.buried &&
      jobName &&
      IDLE_SHELLS.has(jobName);
    if (!eligible) continue;
    const current = newestByTerminalId.get(recovery.terminalSessionId);
    const recoveryAt = Date.parse(recovery.closedAt ?? recovery.lastSeenAt);
    const currentAt = current
      ? Date.parse(current.closedAt ?? current.lastSeenAt)
      : Number.NEGATIVE_INFINITY;
    if (!current || recoveryAt > currentAt) {
      newestByTerminalId.set(recovery.terminalSessionId, recovery);
    }
  }
  return [...newestByTerminalId.values()].map((recovery) => recovery.sessionId);
}

export function isLayoutRestorable(
  layout: ItermWindowLayoutRecord,
  health: SessionAtlasHealth,
): boolean {
  return (
    layout.status === "closed" &&
    layout.restoreStatus !== "partial" &&
    !layout.createdWindowId &&
    health.iterm === "online"
  );
}

export function findClosedWindowLayouts(
  layouts: readonly ItermWindowLayoutRecord[],
): ItermWindowLayoutRecord[] {
  return layouts
    .filter((layout) => layout.status === "closed")
    .sort(
      (left, right) =>
        Date.parse(right.closedAt ?? right.lastSeenAt) -
        Date.parse(left.closedAt ?? left.lastSeenAt),
    );
}
