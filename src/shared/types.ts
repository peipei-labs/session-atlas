export type Provider = "codex" | "claude" | "terminal";

export type SessionSurface = "managed" | "legacy" | "interactive" | "background";

export type ActivityState =
  | "running"
  | "idle"
  | "awaiting_input"
  | "awaiting_approval"
  | "failed"
  | "offline"
  | "unknown";

export type AttentionReason =
  | "needs_approval"
  | "needs_input"
  | "failed"
  | "newly_completed"
  | null;

export type SessionAction =
  | "open"
  | "focus"
  | "send"
  | "steer"
  | "interrupt"
  | "approve"
  | "answer";

export type PlanStepStatus = "pending" | "in_progress" | "completed";

export interface SessionPlanStep {
  id: string;
  label: string;
  status: PlanStepStatus;
}

export interface SessionPlan {
  steps: SessionPlanStep[];
  done: number;
  total: number;
}

export type SessionExecutionStepStatus = "completed" | "in_progress" | "failed";

export interface SessionExecutionStep {
  id: string;
  label: string;
  status: SessionExecutionStepStatus;
  count?: number;
}

export interface SessionExecution {
  turnId: string;
  turnStatus: "in_progress" | "completed" | "interrupted" | "failed";
  observedAt: string;
  steps: SessionExecutionStep[];
  truncated: boolean;
}

export interface SessionThreadDetail {
  sessionId: string;
  plan?: SessionPlan;
  execution?: SessionExecution;
  message?: string;
}

export interface SessionActivity {
  id: string;
  at: string;
  label: string;
  tone?: "default" | "success" | "warning" | "danger";
}

export interface PendingRequestChoice {
  id: string;
  label: string;
  description?: string;
}

export interface PendingRequest {
  requestId: string;
  threadId: string;
  turnId?: string;
  kind: "approval" | "question";
  title: string;
  detail?: string;
  command?: string;
  cwd?: string;
  choices: PendingRequestChoice[];
  receivedAt: string;
}

export interface SessionCapabilities {
  open: boolean;
  focus: boolean;
  send: boolean;
  steer: boolean;
  interrupt: boolean;
  approve: boolean;
  answer: boolean;
}

export interface SessionSummary {
  id: string;
  provider: Provider;
  conversationId?: string;
  runtimeId?: string;
  terminalSessionId?: string;
  surface: SessionSurface;
  title: string;
  tags?: string[];
  cwd: string;
  projectKey: string;
  projectName: string;
  branch?: string;
  activityState: ActivityState;
  attentionReason: AttentionReason;
  rawState?: string;
  currentActivity?: string;
  lastTurnStatus?: string;
  recoveryStatus?: "recorded" | "pending" | "ambiguous" | "failed";
  recoveryMessage?: string;
  lastActivityAt: string;
  observedAt: string;
  stale: boolean;
  focused?: boolean;
  buried?: boolean;
  terminal?: {
    windowId?: string;
    tabId?: string;
    tty?: string;
    jobName?: string;
    jobPid?: number;
    windowIndex?: number;
    tabIndex?: number;
    paneIndex?: number;
    tabCount?: number;
    paneCount?: number;
    currentWindow?: boolean;
  };
  plan?: SessionPlan;
  activities: SessionActivity[];
  pendingRequest?: PendingRequest;
  capabilities: SessionCapabilities;
  pinned: boolean;
  parked: boolean;
  acknowledgedAt?: string;
}

export interface SessionAtlasHealth {
  controller: "online" | "degraded";
  codex: "online" | "readonly" | "offline";
  iterm: "online" | "offline";
  recovery?: "online" | "degraded";
  unprotectedCodexSessions?: number;
  autoResume?: "online" | "degraded" | "disabled";
  autoResumeUnarmedSessions?: number;
  codexVersion?: string;
  message?: string;
}

export type RecoveryStatus = "active" | "closed";

export type ContinuationKind = "time" | "condition" | "input" | "later";

export interface ContinuationItem {
  id: string;
  title: string;
  kind: ContinuationKind;
  nextAction: string;
  status: "pending" | "done" | "cancelled";
  condition?: string;
  anchorLabel?: string;
  anchorAt?: string;
  delayHours?: number;
  dueAt?: string;
}

export interface SessionReference {
  title: string;
  reason: string;
}

export interface SessionHandoff {
  version?: string;
  summary: string;
  items: ContinuationItem[];
  reference?: SessionReference;
  updatedAt: string;
  source: "thread" | "user";
  sourceTurnId?: string;
  requiresRunningProcess?: boolean;
}

export interface UpsertHandoffInput {
  expectedVersion: string | null;
  cwd: string;
  summary: string;
  items: ContinuationItem[];
  reference?: SessionReference | null;
  source?: "thread" | "user";
  sourceTurnId?: string;
  requiresRunningProcess?: boolean;
}

export interface RecoveryLocation {
  windowId?: string;
  windowIndex?: number;
  tabId?: string;
  tabIndex?: number;
  paneIndex?: number;
  profileName?: string;
  splitPath?: Array<{ vertical: boolean; index: number }>;
}

export interface BookmarkTitleMarker {
  originalName: string;
  appliedName: string;
}

export interface RecoveryRecord {
  sessionId: string;
  cwd: string;
  cwdOverride?: string;
  title: string;
  tags?: string[];
  projectName: string;
  terminalSessionId?: string;
  status: RecoveryStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  closedAt?: string;
  resumeCommand: string;
  restoreStatus?: "partial";
  restoreAttemptedAt?: string;
  restoreMessage?: string;
  createdWindowId?: string;
  handoff?: SessionHandoff;
  bookmarkTitleMarker?: BookmarkTitleMarker;
  savedLocation?: RecoveryLocation;
}

export interface RestoreRecoveriesInput {
  sessionIds: string[];
}

export interface RestoreRecoveriesResult {
  requested: number;
  sessionIds: string[];
}

export interface RecoveryPreviewsInput {
  sessionIds: string[];
}

export interface RecoveryPreview {
  sessionId: string;
  status: "available" | "missing";
  firstRequest?: string;
  latestRequest?: string;
  userMessageCount?: number;
}

export interface RecoveryPreviewsResult {
  previews: RecoveryPreview[];
}

export interface AutoResumePreflightInput {
  conversationId: string;
  terminalSessionId: string;
}

export interface AutoResumePreflightResult {
  activeElsewhere: boolean;
  duplicateProfileCleared: boolean;
}

export interface ItermLayoutPane {
  sessionId: string;
  title: string;
  cwd: string;
  profileName?: string;
  jobName?: string;
  conversationId?: string;
  resumeCommand?: string;
  splitPath: Array<{ vertical: boolean; index: number }>;
}

export interface ItermLayoutTab {
  tabId: string;
  tabIndex: number;
  panes: ItermLayoutPane[];
}

export interface ItermWindowLayoutRecord {
  windowId: string;
  windowIndex?: number;
  status: RecoveryStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  closedAt?: string;
  restoreStatus?: "partial";
  restoreAttemptedAt?: string;
  restoreMessage?: string;
  createdWindowId?: string;
  tabs: ItermLayoutTab[];
}

export interface SessionAtlasSnapshot {
  revision: number;
  generatedAt: string;
  health: SessionAtlasHealth;
  sessions: SessionSummary[];
  recoveries: RecoveryRecord[];
  windowLayouts: ItermWindowLayoutRecord[];
}

export type SessionAtlasEvent =
  | { type: "snapshot"; snapshot: SessionAtlasSnapshot }
  | { type: "session-upsert"; session: SessionSummary; revision: number }
  | { type: "session-remove"; sessionId: string; revision: number }
  | { type: "recovery-upsert"; recovery: RecoveryRecord; revision: number }
  | { type: "recovery-remove"; sessionId: string; revision: number }
  | { type: "layout-upsert"; layout: ItermWindowLayoutRecord; revision: number }
  | { type: "layout-remove"; windowId: string; revision: number }
  | { type: "health"; health: SessionAtlasHealth; revision: number };

export interface CreateThreadInput {
  cwd: string;
  title?: string;
  prompt?: string;
}

export interface SendMessageInput {
  text: string;
}

export interface RespondRequestInput {
  choiceId: string;
  text?: string;
}

export interface UpdateAttentionInput {
  pinned?: boolean;
  parked?: boolean;
  acknowledge?: boolean;
  title?: string;
}

export interface ThreadTagsResult {
  sessionId: string;
  tags: string[];
}

export interface UpdateThreadTagsInput {
  add?: string[];
  remove?: string[];
}

export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}

export const EMPTY_CAPABILITIES: SessionCapabilities = {
  open: false,
  focus: false,
  send: false,
  steer: false,
  interrupt: false,
  approve: false,
  answer: false,
};

export interface ProcessMemory {
  pid: number;
  ppid: number;
  tty: string;
  name: string;
  rssBytes: number;
  footprintBytes: number | null;
}

export interface MemorySnapshot {
  sampledAt: string;
  sessions: Array<{
    sessionId: string;
    terminalSessionId: string;
    title: string;
    terminal: NonNullable<SessionSummary["terminal"]>;
    rssBytes: number;
    footprintBytes: number | null;
    missingFootprints: number;
    processes: ProcessMemory[];
  }>;
}
