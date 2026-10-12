import type { ItermWindowLayoutRecord } from "../../shared/types.js";
import type { ItermSessionSnapshot } from "./types.js";
import type { ItermRecoveryTarget, ItermThreadRestoreTarget, ContinuationCloseProof } from "../provider-ports.js";
import { ITERM_BRIDGE_PROTOCOL_VERSION } from "./types.js";

export const MAX_BRIDGE_LINE_BYTES = 1024 * 1024;

export interface BridgeHelloMessage {
  type: "hello";
  protocol: typeof ITERM_BRIDGE_PROTOCOL_VERSION;
  bridgeVersion: string;
  sentAt: string;
}

export interface BridgeHealthMessage {
  type: "health";
  protocol: typeof ITERM_BRIDGE_PROTOCOL_VERSION;
  status: "online";
  sentAt: string;
  message?: string;
}

export interface BridgeSnapshotMessage {
  type: "snapshot";
  protocol: typeof ITERM_BRIDGE_PROTOCOL_VERSION;
  observedAt: string;
  sessions: ItermSessionSnapshot[];
}

export interface BridgeFocusResultMessage {
  type: "focus-result";
  protocol: typeof ITERM_BRIDGE_PROTOCOL_VERSION;
  requestId: string;
  ok: boolean;
  error?: string;
}

export interface BridgeRestoreLayoutResultMessage {
  type: "restore-layout-result";
  protocol: typeof ITERM_BRIDGE_PROTOCOL_VERSION;
  requestId: string;
  ok: boolean;
  error?: string;
  partial?: boolean;
  createdWindowId?: string;
}

export interface BridgeRestoreRecoveriesResultMessage {
  type: "restore-recoveries-result";
  protocol: typeof ITERM_BRIDGE_PROTOCOL_VERSION;
  requestId: string;
  ok: boolean;
  error?: string;
  partial?: boolean;
}

export interface BridgeConfigureAutoResumeResultMessage {
  type: "configure-auto-resume-result";
  protocol: typeof ITERM_BRIDGE_PROTOCOL_VERSION;
  requestId: string;
  ok: boolean;
  error?: string;
}

export interface BridgeClearAutoResumeResultMessage {
  type: "clear-auto-resume-result";
  protocol: typeof ITERM_BRIDGE_PROTOCOL_VERSION;
  requestId: string;
  ok: boolean;
  error?: string;
}

export interface BridgeSavedMarkerResultMessage {
  type: "configure-saved-marker-result" | "clear-saved-marker-result";
  protocol: typeof ITERM_BRIDGE_PROTOCOL_VERSION;
  requestId: string;
  ok: boolean;
  error?: string;
}

export interface BridgeCloseSessionResultMessage {
  type: "close-session-result";
  protocol: typeof ITERM_BRIDGE_PROTOCOL_VERSION;
  requestId: string;
  ok: boolean;
  error?: string;
}

export interface BridgeRestoreThreadResultMessage {
  type: "restore-thread-result";
  protocol: typeof ITERM_BRIDGE_PROTOCOL_VERSION;
  requestId: string;
  ok: boolean;
  error?: string;
  partial?: boolean;
  terminalSessionId?: string;
  windowId?: string;
}

export interface BridgeCloseSessionCommand {
  proof: ContinuationCloseProof;
  type: "close-session";
  protocol: typeof ITERM_BRIDGE_PROTOCOL_VERSION;
  requestId: string;
  sessionId: string;
  conversationId: string;
  cwd: string;
  expectedJobPid: number;
  expectedJobName: string;
  expectedCommandLine: string;
  expiresAt: number;
}

export interface BridgeRestoreThreadCommand {
  type: "restore-thread";
  protocol: typeof ITERM_BRIDGE_PROTOCOL_VERSION;
  requestId: string;
  target: ItermThreadRestoreTarget;
  controllerPort: number;
  expiresAt: number;
}

export interface BridgeErrorMessage {
  type: "error";
  protocol: typeof ITERM_BRIDGE_PROTOCOL_VERSION;
  requestId?: string;
  code: string;
  message: string;
}

export type BridgeInboundMessage =
  | BridgeHelloMessage
  | BridgeHealthMessage
  | BridgeSnapshotMessage
  | BridgeFocusResultMessage
  | BridgeRestoreLayoutResultMessage
  | BridgeRestoreRecoveriesResultMessage
  | BridgeConfigureAutoResumeResultMessage
  | BridgeClearAutoResumeResultMessage
  | BridgeSavedMarkerResultMessage
  | BridgeCloseSessionResultMessage
  | BridgeRestoreThreadResultMessage
  | BridgeErrorMessage;

export interface BridgeFocusCommand {
  type: "focus";
  protocol: typeof ITERM_BRIDGE_PROTOCOL_VERSION;
  requestId: string;
  sessionId: string;
  expiresAt: number;
}

export interface BridgeRestoreLayoutCommand {
  type: "restore-layout";
  protocol: typeof ITERM_BRIDGE_PROTOCOL_VERSION;
  requestId: string;
  layout: ItermWindowLayoutRecord;
  controllerPort: number;
}

export interface BridgeRestoreRecoveriesCommand {
  type: "restore-recoveries";
  protocol: typeof ITERM_BRIDGE_PROTOCOL_VERSION;
  requestId: string;
  batchId: string;
  recoveries: readonly ItermRecoveryTarget[];
  controllerPort: number;
}

export interface BridgeConfigureAutoResumeCommand {
  type: "configure-auto-resume";
  protocol: typeof ITERM_BRIDGE_PROTOCOL_VERSION;
  requestId: string;
  sessionId: string;
  cwd: string;
  conversationId: string;
  controllerPort: number;
  expectedJobPid: number;
  expectedJobName: string;
  expectedCommandLine: string;
}

export interface BridgeClearAutoResumeCommand {
  type: "clear-auto-resume";
  protocol: typeof ITERM_BRIDGE_PROTOCOL_VERSION;
  requestId: string;
  sessionId: string;
  conversationId: string;
}

export interface BridgeConfigureSavedMarkerCommand {
  type: "configure-saved-marker";
  protocol: typeof ITERM_BRIDGE_PROTOCOL_VERSION;
  requestId: string;
  sessionId: string;
  conversationId: string;
  cwd: string;
  expectedJobPid: number;
  expectedJobName: string;
  expectedCommandLine: string;
  expiresAt: number;
}

export interface BridgeClearSavedMarkerCommand {
  type: "clear-saved-marker";
  protocol: typeof ITERM_BRIDGE_PROTOCOL_VERSION;
  requestId: string;
  sessionId: string;
  conversationId: string;
  forget: boolean;
  expiresAt: number;
}

const CODEX_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown, max = 16_384): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalAutoResumeKind(
  value: unknown,
): value is "helper" | "legacy" | "marker" | undefined {
  return value === undefined || value === "helper" || value === "legacy" || value === "marker";
}

function isOptionalPositiveInteger(value: unknown): value is number | undefined {
  return value === undefined || (Number.isSafeInteger(value) && (value as number) > 0);
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function isOptionalSplitPath(
  value: unknown,
): value is Array<{ vertical: boolean; index: number }> | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= 32 &&
      value.every(
        (step) =>
          isRecord(step) &&
          Object.keys(step).length === 2 &&
          typeof step.vertical === "boolean" &&
          Number.isSafeInteger(step.index) &&
          (step.index as number) >= 0 &&
          (step.index as number) < 128,
      ))
  );
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    isNonEmptyString(value, 64) &&
    Number.isFinite(Date.parse(value))
  );
}

function parseSession(value: unknown): ItermSessionSnapshot | null {
  if (!isRecord(value)) return null;
  if (!isNonEmptyString(value.sessionId, 512)) return null;
  if (!isNonEmptyString(value.name, 4096)) return null;
  if (typeof value.cwd !== "string" || value.cwd.length > 16_384) return null;
  if (typeof value.focused !== "boolean" || typeof value.buried !== "boolean") {
    return null;
  }
  if (!isIsoTimestamp(value.observedAt)) return null;
  if (!isOptionalString(value.tty) || !isOptionalString(value.jobName)) return null;
  if (!isOptionalString(value.commandLine) || !isOptionalString(value.profileName)) return null;
  if (
    !isOptionalString(value.autoResumeConversationId) ||
    (value.autoResumeConversationId !== undefined &&
      !CODEX_SESSION_ID.test(value.autoResumeConversationId))
  ) {
    return null;
  }
  if (!isOptionalAutoResumeKind(value.autoResumeKind)) return null;
  if (value.savedMarkerConversationId !== undefined || value.savedMarkerOwnerSessionId !== undefined || value.savedMarkerState !== undefined) {
    if (
      !isNonEmptyString(value.savedMarkerConversationId, 36) ||
      !CODEX_SESSION_ID.test(value.savedMarkerConversationId) ||
      !isNonEmptyString(value.savedMarkerOwnerSessionId, 512) ||
      /[\r\n\0]/u.test(value.savedMarkerOwnerSessionId) ||
      (value.savedMarkerState !== "requested" && value.savedMarkerState !== "applied")
    ) return null;
  }
  if (value.autoResumeKind !== undefined && value.autoResumeConversationId === undefined) {
    return null;
  }
  if (
    value.autoResumeControllerPort !== undefined &&
    (!Number.isSafeInteger(value.autoResumeControllerPort) ||
      (value.autoResumeControllerPort as number) < 1 ||
      (value.autoResumeControllerPort as number) > 65_535)
  ) {
    return null;
  }
  if (
    (value.autoResumeKind === "helper") !==
    (value.autoResumeControllerPort !== undefined)
  ) {
    return null;
  }
  if (!isOptionalSplitPath(value.splitPath)) return null;
  if (!isOptionalString(value.windowId) || !isOptionalString(value.tabId)) return null;
  if (
    !isOptionalPositiveInteger(value.windowIndex) ||
    !isOptionalPositiveInteger(value.tabIndex) ||
    !isOptionalPositiveInteger(value.paneIndex) ||
    !isOptionalPositiveInteger(value.tabCount) ||
    !isOptionalPositiveInteger(value.paneCount) ||
    !isOptionalBoolean(value.currentWindow)
  ) {
    return null;
  }
  if (
    value.jobPid !== undefined &&
    (!Number.isSafeInteger(value.jobPid) || (value.jobPid as number) <= 0)
  ) {
    return null;
  }

  const result: ItermSessionSnapshot = {
    sessionId: value.sessionId,
    name: value.name,
    cwd: value.cwd,
    focused: value.focused,
    buried: value.buried,
    observedAt: value.observedAt,
  };
  if (value.tty !== undefined) result.tty = value.tty;
  if (value.jobName !== undefined) result.jobName = value.jobName;
  if (value.jobPid !== undefined) result.jobPid = value.jobPid as number;
  if (value.commandLine !== undefined) result.commandLine = value.commandLine;
  if (value.profileName !== undefined) result.profileName = value.profileName;
  if (value.autoResumeConversationId !== undefined) {
    result.autoResumeConversationId = value.autoResumeConversationId;
  }
  if (value.autoResumeKind !== undefined) result.autoResumeKind = value.autoResumeKind;
  if (value.autoResumeControllerPort !== undefined) {
    result.autoResumeControllerPort = value.autoResumeControllerPort as number;
  }
  if (value.savedMarkerConversationId !== undefined) {
    result.savedMarkerConversationId = value.savedMarkerConversationId as string;
    result.savedMarkerOwnerSessionId = value.savedMarkerOwnerSessionId as string;
    result.savedMarkerState = value.savedMarkerState as "requested" | "applied";
  }
  if (value.splitPath !== undefined) result.splitPath = value.splitPath.map((step) => ({ ...step }));
  if (value.windowId !== undefined) result.windowId = value.windowId;
  if (value.tabId !== undefined) result.tabId = value.tabId;
  if (value.windowIndex !== undefined) result.windowIndex = value.windowIndex;
  if (value.tabIndex !== undefined) result.tabIndex = value.tabIndex;
  if (value.paneIndex !== undefined) result.paneIndex = value.paneIndex;
  if (value.tabCount !== undefined) result.tabCount = value.tabCount;
  if (value.paneCount !== undefined) result.paneCount = value.paneCount;
  if (value.currentWindow !== undefined) result.currentWindow = value.currentWindow;
  return result;
}

export function parseBridgeMessage(value: unknown): BridgeInboundMessage | null {
  if (!isRecord(value) || value.protocol !== ITERM_BRIDGE_PROTOCOL_VERSION) {
    return null;
  }

  switch (value.type) {
    case "hello":
      if (!isNonEmptyString(value.bridgeVersion, 128) || !isIsoTimestamp(value.sentAt)) {
        return null;
      }
      return {
        type: "hello",
        protocol: ITERM_BRIDGE_PROTOCOL_VERSION,
        bridgeVersion: value.bridgeVersion,
        sentAt: value.sentAt,
      };
    case "health":
      if (value.status !== "online" || !isIsoTimestamp(value.sentAt)) return null;
      if (!isOptionalString(value.message)) return null;
      return {
        type: "health",
        protocol: ITERM_BRIDGE_PROTOCOL_VERSION,
        status: "online",
        sentAt: value.sentAt,
        ...(value.message === undefined ? {} : { message: value.message }),
      };
    case "snapshot": {
      if (!isIsoTimestamp(value.observedAt) || !Array.isArray(value.sessions)) {
        return null;
      }
      const sessions: ItermSessionSnapshot[] = [];
      const seen = new Set<string>();
      for (const rawSession of value.sessions) {
        const session = parseSession(rawSession);
        if (session === null || seen.has(session.sessionId)) return null;
        seen.add(session.sessionId);
        sessions.push(session);
      }
      return {
        type: "snapshot",
        protocol: ITERM_BRIDGE_PROTOCOL_VERSION,
        observedAt: value.observedAt,
        sessions,
      };
    }
    case "restore-thread-result":
      if (!isNonEmptyString(value.requestId, 128) || typeof value.ok !== "boolean") return null;
      if (!isOptionalString(value.error) || !isOptionalBoolean(value.partial)) return null;
      if (value.terminalSessionId !== undefined && !isNonEmptyString(value.terminalSessionId, 512)) return null;
      if (value.windowId !== undefined && !isNonEmptyString(value.windowId, 512)) return null;
      if (value.ok && (value.partial === true || !value.terminalSessionId)) return null;
      return {
        type: "restore-thread-result", protocol: ITERM_BRIDGE_PROTOCOL_VERSION,
        requestId: value.requestId, ok: value.ok,
        ...(value.error === undefined ? {} : { error: value.error }),
        ...(value.partial === undefined ? {} : { partial: value.partial }),
        ...(value.terminalSessionId === undefined ? {} : { terminalSessionId: value.terminalSessionId }),
        ...(value.windowId === undefined ? {} : { windowId: value.windowId }),
      };
    case "close-session-result":
      if (!isNonEmptyString(value.requestId, 128) || typeof value.ok !== "boolean") return null;
      if (!isOptionalString(value.error)) return null;
      return {
        type: "close-session-result", protocol: ITERM_BRIDGE_PROTOCOL_VERSION,
        requestId: value.requestId, ok: value.ok,
        ...(value.error === undefined ? {} : { error: value.error }),
      };
    case "focus-result":
      if (!isNonEmptyString(value.requestId, 128) || typeof value.ok !== "boolean") {
        return null;
      }
      if (!isOptionalString(value.error)) return null;
      return {
        type: "focus-result",
        protocol: ITERM_BRIDGE_PROTOCOL_VERSION,
        requestId: value.requestId,
        ok: value.ok,
        ...(value.error === undefined ? {} : { error: value.error }),
      };
    case "restore-layout-result":
      if (!isNonEmptyString(value.requestId, 128) || typeof value.ok !== "boolean") {
        return null;
      }
      if (!isOptionalString(value.error) || !isOptionalBoolean(value.partial)) return null;
      if (value.createdWindowId !== undefined && !isNonEmptyString(value.createdWindowId, 512)) {
        return null;
      }
      if (value.ok && value.partial === true) return null;
      return {
        type: "restore-layout-result",
        protocol: ITERM_BRIDGE_PROTOCOL_VERSION,
        requestId: value.requestId,
        ok: value.ok,
        ...(value.error === undefined ? {} : { error: value.error }),
        ...(value.partial === undefined ? {} : { partial: value.partial }),
        ...(value.createdWindowId === undefined
          ? {}
          : { createdWindowId: value.createdWindowId }),
      };
    case "restore-recoveries-result":
      if (!isNonEmptyString(value.requestId, 128) || typeof value.ok !== "boolean") {
        return null;
      }
      if (!isOptionalString(value.error) || !isOptionalBoolean(value.partial)) return null;
      if (value.ok && value.partial === true) return null;
      return {
        type: "restore-recoveries-result",
        protocol: ITERM_BRIDGE_PROTOCOL_VERSION,
        requestId: value.requestId,
        ok: value.ok,
        ...(value.error === undefined ? {} : { error: value.error }),
        ...(value.partial === undefined ? {} : { partial: value.partial }),
      };
    case "configure-auto-resume-result":
      if (!isNonEmptyString(value.requestId, 128) || typeof value.ok !== "boolean") {
        return null;
      }
      if (!isOptionalString(value.error)) return null;
      return {
        type: "configure-auto-resume-result",
        protocol: ITERM_BRIDGE_PROTOCOL_VERSION,
        requestId: value.requestId,
        ok: value.ok,
        ...(value.error === undefined ? {} : { error: value.error }),
      };
    case "configure-saved-marker-result":
    case "clear-saved-marker-result":
      if (!isNonEmptyString(value.requestId, 128) || typeof value.ok !== "boolean") return null;
      if (!isOptionalString(value.error)) return null;
      return {
        type: value.type,
        protocol: ITERM_BRIDGE_PROTOCOL_VERSION,
        requestId: value.requestId,
        ok: value.ok,
        ...(value.error === undefined ? {} : { error: value.error }),
      };
    case "clear-auto-resume-result":
      if (!isNonEmptyString(value.requestId, 128) || typeof value.ok !== "boolean") {
        return null;
      }
      if (!isOptionalString(value.error)) return null;
      return {
        type: "clear-auto-resume-result",
        protocol: ITERM_BRIDGE_PROTOCOL_VERSION,
        requestId: value.requestId,
        ok: value.ok,
        ...(value.error === undefined ? {} : { error: value.error }),
      };
    case "error":
      if (!isNonEmptyString(value.code, 128) || !isNonEmptyString(value.message)) {
        return null;
      }
      if (value.requestId !== undefined && !isNonEmptyString(value.requestId, 128)) {
        return null;
      }
      return {
        type: "error",
        protocol: ITERM_BRIDGE_PROTOCOL_VERSION,
        code: value.code,
        message: value.message,
        ...(value.requestId === undefined ? {} : { requestId: value.requestId }),
      };
    default:
      return null;
  }
}
