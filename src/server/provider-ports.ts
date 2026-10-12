import type {
  CreateThreadInput,
  ItermWindowLayoutRecord,
  RespondRequestInput,
  SessionAtlasHealth,
  SessionExecution,
  SessionSummary,
} from "../shared/types.js";

export type ProviderEvent =
  | { type: "session-upsert"; session: SessionSummary }
  | { type: "session-remove"; sessionId: string }
  | { type: "health"; health: SessionAtlasHealth };

export interface CodexProviderPort {
  start(): Promise<void>;
  stop(): Promise<void>;
  getHealth(): SessionAtlasHealth;
  list(): Promise<SessionSummary[]>;
  readExecution(threadId: string): Promise<SessionExecution>;
  createThread(input: CreateThreadInput): Promise<SessionSummary>;
  sendMessage(threadId: string, text: string): Promise<void>;
  interrupt(threadId: string): Promise<void>;
  respondRequest(
    threadId: string,
    requestId: string,
    input: RespondRequestInput,
  ): Promise<void>;
  subscribe(listener: (event: ProviderEvent) => void): () => void;
}

export interface ItermSessionSnapshot {
  sessionId: string;
  name: string;
  cwd: string;
  tty?: string;
  jobName?: string;
  jobPid?: number;
  commandLine?: string;
  profileName?: string;
  autoResumeConversationId?: string;
  autoResumeKind?: "helper" | "legacy" | "marker";
  autoResumeControllerPort?: number;
  savedMarkerConversationId?: string;
  savedMarkerOwnerSessionId?: string;
  savedMarkerState?: "requested" | "applied";
  splitPath?: Array<{ vertical: boolean; index: number }>;
  focused: boolean;
  buried: boolean;
  windowId?: string;
  tabId?: string;
  windowIndex?: number;
  tabIndex?: number;
  paneIndex?: number;
  tabCount?: number;
  paneCount?: number;
  currentWindow?: boolean;
  observedAt: string;
}

export interface ItermBridgeHealth {
  status: "online" | "offline";
  message?: string;
}

export interface ItermRestoreUncertain {
  windowId: string;
  createdWindowId?: string;
}

export interface ItermRecoveryTarget {
  targetSessionId: string;
  cwd: string;
  expectedPlaceholderCwd?: string;
  conversationId: string;
  title: string;
  profileName?: string;
  splitVertical: boolean;
}

export interface ContinuationCloseProof {
  rolloutPath: string;
  size: number;
  mtimeNs: string;
}

export interface ItermThreadRestoreTarget {
  conversationId: string;
  cwd: string;
  title: string;
  profileName?: string;
  windowId?: string;
  savedCard?: boolean;
}

export interface ItermThreadRestoreResult {
  terminalSessionId: string;
  windowId?: string;
}

export interface ItermBridgePort {
  closeSession?(session: ItermSessionSnapshot, conversationId: string, proof: ContinuationCloseProof): Promise<void>;
  confirmThreadRestored?(conversationId: string, terminalSessionId: string): void;
  restoreThread?(target: ItermThreadRestoreTarget, controllerPort: number): Promise<ItermThreadRestoreResult>;
  start(): Promise<void>;
  stop(): Promise<void>;
  getSessions(): readonly ItermSessionSnapshot[];
  getHealth(): ItermBridgeHealth;
  focus(sessionId: string): Promise<void>;
  configureAutoResume(
    session: ItermSessionSnapshot,
    conversationId: string,
    controllerPort: number,
  ): Promise<void>;
  clearAutoResume(sessionId: string, conversationId: string): Promise<void>;
  configureSavedMarker?(session: ItermSessionSnapshot, conversationId: string): Promise<void>;
  clearSavedMarker?(sessionId: string, conversationId: string, forget?: boolean): Promise<void>;
  restoreLayout(layout: ItermWindowLayoutRecord, controllerPort: number): Promise<string | undefined>;
  restoreRecoveries(
    batchId: string,
    targets: readonly ItermRecoveryTarget[],
    controllerPort: number,
  ): Promise<void>;
  on(event: "snapshot", listener: (sessions: readonly ItermSessionSnapshot[]) => void): this;
  on(event: "health", listener: (health: ItermBridgeHealth) => void): this;
  on(event: "restore-uncertain", listener: (event: ItermRestoreUncertain) => void): this;
  off(event: "snapshot", listener: (sessions: readonly ItermSessionSnapshot[]) => void): this;
  off(event: "health", listener: (health: ItermBridgeHealth) => void): this;
  off(event: "restore-uncertain", listener: (event: ItermRestoreUncertain) => void): this;
}
