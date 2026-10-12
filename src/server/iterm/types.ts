export const ITERM_BRIDGE_PROTOCOL_VERSION = 14 as const;
export const ITERM_BRIDGE_VERSION = "0.16.0" as const;

export interface ItermSplitPathStep {
  vertical: boolean;
  index: number;
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
  splitPath?: ItermSplitPathStep[];
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
  observedAt: string;
  connectedAt?: string;
  bridgeVersion?: string;
  message?: string;
}

export interface ItermRestoreUncertain {
  windowId: string;
  createdWindowId?: string;
}

export interface ItermBridgeAdapterOptions {
  socketPath?: string;
  requestTimeoutMs?: number;
  restoreRequestTimeoutMs?: number;
  staleAfterMs?: number;
  now?: () => Date;
}
