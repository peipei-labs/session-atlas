import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname } from "node:path";

import type {
  BookmarkTitleMarker,
  ItermLayoutPane,
  ItermLayoutTab,
  ItermWindowLayoutRecord,
  RecoveryLocation,
  RecoveryRecord,
  SessionHandoff,
  UpsertHandoffInput,
} from "../shared/types.js";
import { hasSavedHandoff, parseHandoffVersion, parseStoredHandoff, parseUpsertHandoffInput } from "./handoff.js";
import { AppError } from "./errors.js";
import type { LegacyCodexMatch } from "./legacy-codex-observer.js";
import { normalizeItermTitle } from "./normalization.js";
import type { ItermSessionSnapshot } from "./provider-ports.js";

interface StoredRecovery {
  sessionId: string;
  cwd: string;
  cwdOverride?: string;
  title: string;
  projectName: string;
  terminalSessionId?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  closedAt?: string;
  restoreStatus?: "partial";
  restoreAttemptedAt?: string;
  restoreMessage?: string;
  createdWindowId?: string;
  handoff?: SessionHandoff;
  bookmarkTitleMarker?: BookmarkTitleMarker;
  savedLocation?: RecoveryLocation;
}

interface RecoveryStateFile {
  version: 2;
  recoveries: Record<string, StoredRecovery>;
  layouts: Record<string, StoredWindowLayout>;
}

interface StoredWindowLayout {
  windowId: string;
  windowIndex?: number;
  firstSeenAt: string;
  lastSeenAt: string;
  closedAt?: string;
  restoreStatus?: "partial";
  restoreAttemptedAt?: string;
  restoreMessage?: string;
  createdWindowId?: string;
  tabs: ItermLayoutTab[];
}

const EMPTY_STATE: RecoveryStateFile = { version: 2, recoveries: {}, layouts: {} };
const RECOVERY_TOUCH_INTERVAL_MS = 60_000;
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_CLOSED_RECOVERIES = 200;
const DEFAULT_MAX_CLOSED_LAYOUTS = 100;

class RecoveryStateError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isBookmarkTitleMarker(value: unknown): value is BookmarkTitleMarker {
  return isRecord(value) &&
    Object.keys(value).every((key) => key === "originalName" || key === "appliedName") &&
    typeof value.originalName === "string" &&
    value.originalName.trim().length > 0 &&
    value.originalName.length <= 256 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value.originalName) &&
    value.appliedName === `🔖 ${value.originalName}`;
}

function isStoredRecovery(value: unknown): value is StoredRecovery {
  if (!isRecord(value)) return false;
  if (value.handoff !== undefined) {
    try {
      value.handoff = parseStoredHandoff(value.handoff);
    } catch {
      return false;
    }
  }
  const restoreStateValid =
    value.restoreStatus === undefined
      ? value.restoreAttemptedAt === undefined &&
        value.restoreMessage === undefined &&
        value.createdWindowId === undefined
      : value.restoreStatus === "partial" &&
        isTimestamp(value.restoreAttemptedAt) &&
        typeof value.restoreMessage === "string" &&
        value.restoreMessage.length > 0 &&
        (value.createdWindowId === undefined ||
          (typeof value.createdWindowId === "string" && value.createdWindowId.length > 0));
  return (
    typeof value.sessionId === "string" &&
    value.sessionId.length > 0 &&
    typeof value.cwd === "string" &&
    value.cwd.length > 0 &&
    (value.cwdOverride === undefined || (typeof value.cwdOverride === "string" && value.cwdOverride.startsWith("/"))) &&
    typeof value.title === "string" &&
    value.title.length > 0 &&
    typeof value.projectName === "string" &&
    value.projectName.length > 0 &&
    (value.terminalSessionId === undefined || typeof value.terminalSessionId === "string") &&
    isTimestamp(value.firstSeenAt) &&
    isTimestamp(value.lastSeenAt) &&
    (value.closedAt === undefined || isTimestamp(value.closedAt)) &&
    (value.bookmarkTitleMarker === undefined || isBookmarkTitleMarker(value.bookmarkTitleMarker)) &&
    (value.savedLocation === undefined || isSavedLocation(value.savedLocation)) &&
    restoreStateValid
  );
}

function isSavedLocation(value: unknown): value is RecoveryLocation {
  if (!isRecord(value)) return false;
  const keys = ["windowId", "windowIndex", "tabId", "tabIndex", "paneIndex", "profileName", "splitPath"];
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    return false;
  }
  return (
    [value.windowId, value.tabId, value.profileName].every(
      (entry) => entry === undefined || (typeof entry === "string" && entry.length > 0),
    ) &&
    [value.windowIndex, value.tabIndex, value.paneIndex].every(
      (entry) => entry === undefined || (Number.isSafeInteger(entry) && (entry as number) > 0),
    ) &&
    (value.splitPath === undefined || isSplitPath(value.splitPath))
  );
}

function savedLocation(
  session: ItermSessionSnapshot,
  current?: RecoveryLocation,
): RecoveryLocation | undefined {
  const location: RecoveryLocation = {
    ...(current ?? {}),
    ...(session.windowId ? { windowId: session.windowId } : {}),
    ...(session.windowIndex ? { windowIndex: session.windowIndex } : {}),
    ...(session.tabId ? { tabId: session.tabId } : {}),
    ...(session.tabIndex ? { tabIndex: session.tabIndex } : {}),
    ...(session.paneIndex ? { paneIndex: session.paneIndex } : {}),
    ...(session.profileName ? { profileName: session.profileName } : {}),
    ...(session.splitPath
      ? { splitPath: session.splitPath.map((step) => ({ vertical: step.vertical, index: step.index })) }
      : {}),
  };
  return Object.keys(location).length > 0 ? location : undefined;
}

function isSplitPath(value: unknown): value is ItermLayoutPane["splitPath"] {
  return (
    Array.isArray(value) &&
    value.length <= 32 &&
    value.every(
      (step) =>
        isRecord(step) &&
        Object.keys(step).length === 2 &&
        typeof step.vertical === "boolean" &&
        Number.isSafeInteger(step.index) &&
        (step.index as number) >= 0,
    )
  );
}

function isStoredPane(value: unknown): value is ItermLayoutPane {
  if (!isRecord(value)) return false;
  return (
    typeof value.sessionId === "string" &&
    value.sessionId.length > 0 &&
    typeof value.title === "string" &&
    value.title.length > 0 &&
    typeof value.cwd === "string" &&
    (value.profileName === undefined || typeof value.profileName === "string") &&
    (value.jobName === undefined || typeof value.jobName === "string") &&
    (value.conversationId === undefined || typeof value.conversationId === "string") &&
    value.resumeCommand === undefined &&
    isSplitPath(value.splitPath)
  );
}

function isStoredTab(value: unknown): value is ItermLayoutTab {
  return (
    isRecord(value) &&
    typeof value.tabId === "string" &&
    value.tabId.length > 0 &&
    Number.isSafeInteger(value.tabIndex) &&
    (value.tabIndex as number) > 0 &&
    Array.isArray(value.panes) &&
    value.panes.length > 0 &&
    value.panes.every(isStoredPane)
  );
}

function isStoredWindowLayout(value: unknown): value is StoredWindowLayout {
  if (!isRecord(value)) return false;
  const restoreStateValid =
    value.restoreStatus === undefined
      ? value.restoreAttemptedAt === undefined &&
        value.restoreMessage === undefined &&
        value.createdWindowId === undefined
      : value.restoreStatus === "partial" &&
        isTimestamp(value.restoreAttemptedAt) &&
        typeof value.restoreMessage === "string" &&
        value.restoreMessage.length > 0 &&
        (value.createdWindowId === undefined ||
          (typeof value.createdWindowId === "string" && value.createdWindowId.length > 0));
  return (
    typeof value.windowId === "string" &&
    value.windowId.length > 0 &&
    (value.windowIndex === undefined ||
      (Number.isSafeInteger(value.windowIndex) && (value.windowIndex as number) > 0)) &&
    isTimestamp(value.firstSeenAt) &&
    isTimestamp(value.lastSeenAt) &&
    (value.closedAt === undefined || isTimestamp(value.closedAt)) &&
    restoreStateValid &&
    Array.isArray(value.tabs) &&
    value.tabs.length > 0 &&
    value.tabs.every(isStoredTab)
  );
}

function parseState(raw: string): RecoveryStateFile {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new RecoveryStateError("Recovery state is not valid JSON.", { cause: error });
  }
  if (!isRecord(value) || !isRecord(value.recoveries)) {
    throw new RecoveryStateError("Recovery state has an invalid shape.");
  }
  if (!Object.values(value.recoveries).every(isStoredRecovery)) {
    throw new RecoveryStateError("Recovery state has an invalid shape.");
  }
  if (value.version === 1) {
    return {
      version: 2,
      recoveries: { ...(value.recoveries as Record<string, StoredRecovery>) },
      layouts: {},
    };
  }
  if (
    value.version !== 2 ||
    !isRecord(value.layouts) ||
    !Object.values(value.layouts).every(isStoredWindowLayout)
  ) {
    throw new RecoveryStateError("Recovery state has an invalid shape.");
  }
  return {
    version: 2,
    recoveries: { ...(value.recoveries as Record<string, StoredRecovery>) },
    layouts: { ...(value.layouts as Record<string, StoredWindowLayout>) },
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isCodexSession(session: ItermSessionSnapshot): boolean {
  return /(?:^|[\s/])codex(?:[\s-]|$)/iu.test(
    `${session.jobName ?? ""} ${session.commandLine ?? ""}`,
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function buildResumeCommand(cwd: string, sessionId: string): string {
  return `codex resume -C ${shellQuote(cwd)} ${shellQuote(sessionId)}`;
}

function materialize(stored: StoredRecovery): RecoveryRecord {
  return {
    ...stored,
    status: stored.closedAt ? "closed" : "active",
    resumeCommand: buildResumeCommand(stored.cwd, stored.sessionId),
  };
}

function materializeLayout(stored: StoredWindowLayout): ItermWindowLayoutRecord {
  return {
    ...stored,
    status: stored.closedAt ? "closed" : "active",
    tabs: stored.tabs.map((tab) => ({
      ...tab,
      panes: tab.panes.map((pane) => ({
        ...pane,
        ...(pane.conversationId
          ? { resumeCommand: buildResumeCommand(pane.cwd, pane.conversationId) }
          : {}),
      })),
    })),
  };
}

export interface RecoveryObservationResult {
  records: RecoveryRecord[];
  changed: RecoveryRecord[];
  removedSessionIds: string[];
  layouts: ItermWindowLayoutRecord[];
  changedLayouts: ItermWindowLayoutRecord[];
  removedWindowIds: string[];
}

export interface RecoveryStoreOptions {
  retentionMs?: number;
  maxClosedRecoveries?: number;
  maxClosedLayouts?: number;
  now?: () => Date;
}

export class RecoveryStore {
  readonly filePath: string;
  readonly retentionMs: number;
  readonly maxClosedRecoveries: number;
  readonly maxClosedLayouts: number;
  readonly now: () => Date;
  loadWarning: string | undefined;
  #state: RecoveryStateFile = clone(EMPTY_STATE);
  #loaded = false;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string, options: RecoveryStoreOptions = {}) {
    this.filePath = filePath;
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.maxClosedRecoveries =
      options.maxClosedRecoveries ?? DEFAULT_MAX_CLOSED_RECOVERIES;
    this.maxClosedLayouts = options.maxClosedLayouts ?? DEFAULT_MAX_CLOSED_LAYOUTS;
    this.now = options.now ?? (() => new Date());
  }

  async load(): Promise<void> {
    if (this.#loaded) return;
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    try {
      const loaded = parseState(await readFile(this.filePath, "utf8"));
      const retained = clone(loaded);
      this.#pruneClosed(retained);
      if (!sameValue(loaded, retained)) {
        await this.#writeAtomic(retained);
      }
      this.#state = retained;
      await chmod(this.filePath, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.#state = clone(EMPTY_STATE);
      } else if (error instanceof RecoveryStateError) {
        const quarantinedPath = `${this.filePath}.corrupt-${this.now()
          .toISOString()
          .replaceAll(":", "-")}-${randomUUID()}`;
        await rename(this.filePath, quarantinedPath);
        this.#state = clone(EMPTY_STATE);
        this.loadWarning = `Invalid recovery state was preserved at ${quarantinedPath}`;
      } else {
        throw error;
      }
    }
    this.#loaded = true;
  }

  list(): RecoveryRecord[] {
    this.#assertLoaded();
    return Object.values(this.#state.recoveries)
      .map(materialize)
      .sort((left, right) => {
        const leftAt = Date.parse(left.closedAt ?? left.lastSeenAt);
        const rightAt = Date.parse(right.closedAt ?? right.lastSeenAt);
        return rightAt - leftAt;
      })
      .map(clone);
  }

  listLayouts(): ItermWindowLayoutRecord[] {
    this.#assertLoaded();
    return Object.values(this.#state.layouts)
      .map(materializeLayout)
      .sort((left, right) => {
        const leftAt = Date.parse(left.closedAt ?? left.lastSeenAt);
        const rightAt = Date.parse(right.closedAt ?? right.lastSeenAt);
        return rightAt - leftAt;
      })
      .map(clone);
  }

  getHandoff(sessionId: string): SessionHandoff | undefined {
    this.#assertLoaded();
    return clone(this.#state.recoveries[sessionId]?.handoff);
  }

  async upsertHandoff(
    sessionId: string,
    input: UpsertHandoffInput,
    session?: ItermSessionSnapshot,
  ): Promise<RecoveryRecord> {
    this.#assertLoaded();
    const parsed = parseUpsertHandoffInput(input);
    let result: RecoveryRecord | undefined;
    await this.#enqueue(async () => {
      const next = clone(this.#state);
      const current = next.recoveries[sessionId];
      this.#checkHandoffVersion(current?.handoff, parsed.expectedVersion);
      const now = this.now().toISOString();
      const { cwd, expectedVersion: _expectedVersion, reference: requestedReference, ...content } = parsed;
      const reference = requestedReference === undefined
        ? current?.handoff?.reference
        : requestedReference;
      const projectName = basename(cwd) || cwd;
      const location = session
        ? savedLocation(session, current?.savedLocation)
        : current?.savedLocation;
      const updated: StoredRecovery = {
        ...(current ?? {}),
        sessionId,
        cwd,
        title: session
          ? normalizeItermTitle(session.name, projectName)
          : current?.title ?? projectName,
        projectName,
        ...(session ? { terminalSessionId: session.sessionId } : {}),
        firstSeenAt: current?.firstSeenAt ?? now,
        lastSeenAt: session?.observedAt ?? current?.lastSeenAt ?? now,
        handoff: { ...content, ...(reference ? { reference } : {}), source: parsed.source!, updatedAt: now, version: randomUUID() },
        ...(location ? { savedLocation: location } : {}),
      };
      if (session) delete updated.closedAt;
      else if (!current) updated.closedAt = now;
      next.recoveries[sessionId] = updated;
      await this.#writeAtomic(next);
      this.#state = next;
      result = materialize(updated);
    });
    return clone(result!);
  }

  async removeHandoff(sessionId: string, expectedVersion: string | null): Promise<RecoveryRecord> {
    this.#assertLoaded();
    let result: RecoveryRecord | undefined;
    await this.#enqueue(async () => {
      const next = clone(this.#state);
      const recovery = next.recoveries[sessionId];
      if (!recovery) throw new Error(`Unknown recovery record: ${sessionId}`);
      this.#checkHandoffVersion(recovery.handoff, expectedVersion);
      delete recovery.handoff;
      if (!sameValue(next, this.#state)) {
        await this.#writeAtomic(next);
        this.#state = next;
      }
      result = materialize(recovery);
    });
    return clone(result!);
  }

  #checkHandoffVersion(handoff: SessionHandoff | undefined, expectedVersion: string | null): void {
    if (parseHandoffVersion(expectedVersion) !== (handoff?.version ?? handoff?.updatedAt ?? null)) {
      throw new AppError(409, "HANDOFF_CONFLICT", "卡片已被其他页面或原线程更新。当前修改未保存，请读取最新卡片后合并修改。");
    }
  }

  async saveRecoveryLocation(
    sessionId: string,
    session: ItermSessionSnapshot,
  ): Promise<RecoveryRecord> {
    this.#assertLoaded();
    let result: RecoveryRecord | undefined;
    await this.#enqueue(async () => {
      const next = clone(this.#state);
      const recovery = next.recoveries[sessionId];
      if (!recovery) throw new Error(`Unknown recovery record: ${sessionId}`);
      const location = savedLocation(session, recovery.savedLocation);
      if (location) recovery.savedLocation = location;
      recovery.terminalSessionId = session.sessionId;
      if (!sameValue(next, this.#state)) {
        await this.#writeAtomic(next);
        this.#state = next;
      }
      result = materialize(recovery);
    });
    return clone(result!);
  }

  async clearRecoveryRestoreState(sessionId: string): Promise<RecoveryRecord> {
    this.#assertLoaded();
    let result: RecoveryRecord | undefined;
    await this.#enqueue(async () => {
      const next = clone(this.#state);
      const recovery = next.recoveries[sessionId];
      if (!recovery) throw new Error(`Unknown recovery record: ${sessionId}`);
      delete recovery.restoreStatus;
      delete recovery.restoreAttemptedAt;
      delete recovery.restoreMessage;
      delete recovery.createdWindowId;
      if (!sameValue(next, this.#state)) {
        await this.#writeAtomic(next);
        this.#state = next;
      }
      result = materialize(recovery);
    });
    return clone(result!);
  }

  async updateRecoveryCwd(sessionId: string, cwd: string, explicitOverride = false): Promise<RecoveryRecord> {
    this.#assertLoaded();
    let result: RecoveryRecord | undefined;
    await this.#enqueue(async () => {
      const next = clone(this.#state);
      const recovery = next.recoveries[sessionId];
      if (!recovery) throw new Error(`Unknown recovery record: ${sessionId}`);
      recovery.cwd = cwd;
      if (explicitOverride) recovery.cwdOverride = cwd;
      recovery.projectName = basename(cwd) || cwd;
      if (!sameValue(next, this.#state)) {
        await this.#writeAtomic(next);
        this.#state = next;
      }
      result = materialize(recovery);
    });
    return clone(result!);
  }

  async updateBookmarkTitleMarker(sessionId: string, marker?: BookmarkTitleMarker): Promise<RecoveryRecord> {
    this.#assertLoaded();
    if (marker !== undefined && !isBookmarkTitleMarker(marker)) {
      throw new AppError(400, "INVALID_BOOKMARK_TITLE_MARKER", "Invalid bookmark title marker.");
    }
    const requestedMarker = clone(marker);
    let result: RecoveryRecord | undefined;
    await this.#enqueue(async () => {
      const next = clone(this.#state);
      const recovery = next.recoveries[sessionId];
      if (!recovery) throw new Error(`Unknown recovery record: ${sessionId}`);
      if (requestedMarker) recovery.bookmarkTitleMarker = requestedMarker;
      else delete recovery.bookmarkTitleMarker;
      if (!sameValue(next, this.#state)) {
        await this.#writeAtomic(next);
        this.#state = next;
      }
      result = materialize(recovery);
    });
    return clone(result!);
  }

  async markLayoutRestoreUncertain(
    windowId: string,
    message: string,
    createdWindowId?: string,
  ): Promise<ItermWindowLayoutRecord> {
    this.#assertLoaded();
    let result: ItermWindowLayoutRecord | undefined;
    await this.#enqueue(async () => {
      const current = this.#state.layouts[windowId];
      if (!current) throw new Error(`Unknown recovery layout: ${windowId}`);
      const next = clone(this.#state);
      const updated = next.layouts[windowId]!;
      updated.restoreStatus = "partial";
      updated.restoreAttemptedAt ??= this.now().toISOString();
      updated.restoreMessage = message;
      if (createdWindowId) updated.createdWindowId = createdWindowId;
      if (!sameValue(next, this.#state)) {
        await this.#writeAtomic(next);
        this.#state = next;
      }
      result = materializeLayout(updated);
    });
    return clone(result!);
  }

  async markRecoveriesRestoreUncertain(
    sessionIds: readonly string[],
    message: string,
    createdWindowId?: string,
  ): Promise<RecoveryRecord[]> {
    this.#assertLoaded();
    let result: RecoveryRecord[] = [];
    await this.#enqueue(async () => {
      const next = clone(this.#state);
      const attemptedAt = this.now().toISOString();
      for (const sessionId of sessionIds) {
        const recovery = next.recoveries[sessionId];
        if (!recovery) throw new Error(`Unknown recovery record: ${sessionId}`);
        recovery.restoreStatus = "partial";
        recovery.restoreAttemptedAt ??= attemptedAt;
        recovery.restoreMessage = message;
        if (createdWindowId) recovery.createdWindowId = createdWindowId;
      }
      if (!sameValue(next, this.#state)) {
        await this.#writeAtomic(next);
        this.#state = next;
      }
      result = sessionIds.map((sessionId) => materialize(next.recoveries[sessionId]!));
    });
    return result.map(clone);
  }

  async observe(
    sessions: readonly ItermSessionSnapshot[],
    matches: readonly LegacyCodexMatch[],
  ): Promise<RecoveryObservationResult> {
    this.#assertLoaded();
    if (sessions.length !== matches.length) {
      throw new Error("Recovery observation requires one Codex match per iTerm session.");
    }

    let result: RecoveryObservationResult = {
      records: this.list(),
      changed: [],
      removedSessionIds: [],
      layouts: this.listLayouts(),
      changedLayouts: [],
      removedWindowIds: [],
    };
    await this.#enqueue(async () => {
      const next: RecoveryStateFile = clone(this.#state);
      const previous = this.#state.recoveries;
      const previousLayouts = this.#state.layouts;
      const observedTerminalIds = new Set(sessions.map((session) => session.sessionId));
      const codexTerminalIds = new Set(
        sessions.filter(isCodexSession).map((session) => session.sessionId),
      );
      const linkedByConversation = new Map<
        string,
        { session: ItermSessionSnapshot; observedAt: string }
      >();
      const linkedConversationByTerminal = new Map<string, string>();

      for (const [index, session] of sessions.entries()) {
        const match = matches[index];
        if (match?.status !== "linked" || !match.conversationId || !session.cwd) continue;
        linkedByConversation.set(match.conversationId, {
          session,
          observedAt: session.observedAt,
        });
        linkedConversationByTerminal.set(session.sessionId, match.conversationId);
      }

      for (const [sessionId, { session, observedAt }] of linkedByConversation) {
        const current = next.recoveries[sessionId];
        // iTerm reports the shell directory, which may differ from the saved thread's cwd.
        const cwd = current?.handoff ? current.cwd : session.cwd;
        const location = savedLocation(session, current?.savedLocation);
        const title = normalizeItermTitle(
          session.name,
          basename(cwd) || "Codex session",
        );
        const identityChanged =
          !current ||
          current.cwd !== cwd ||
          current.title !== title ||
          current.terminalSessionId !== session.sessionId ||
          current.closedAt !== undefined;
        const touchDue =
          !current ||
          Date.parse(observedAt) - Date.parse(current.lastSeenAt) >=
            RECOVERY_TOUCH_INTERVAL_MS;
        next.recoveries[sessionId] = {
          sessionId,
          cwd,
          title,
          projectName: basename(cwd) || cwd,
          terminalSessionId: session.sessionId,
          firstSeenAt: current?.firstSeenAt ?? observedAt,
          lastSeenAt: identityChanged || touchDue ? observedAt : current.lastSeenAt,
          ...(current?.handoff ? { handoff: current.handoff } : {}),
          ...(current?.bookmarkTitleMarker ? { bookmarkTitleMarker: current.bookmarkTitleMarker } : {}),
          ...(current?.cwdOverride ? { cwdOverride: current.cwdOverride } : {}),
          ...(location ? { savedLocation: location } : {}),
        };
      }

      const snapshotObservedAt = sessions.reduce(
        (latest, session) =>
          Date.parse(session.observedAt) > Date.parse(latest) ? session.observedAt : latest,
        sessions[0]?.observedAt ?? this.now().toISOString(),
      );
      for (const [sessionId, current] of Object.entries(next.recoveries)) {
        if (linkedByConversation.has(sessionId) || current.closedAt) continue;
        const terminalId = current.terminalSessionId;
        const replacementId = terminalId
          ? linkedConversationByTerminal.get(terminalId)
          : undefined;
        const terminalStillRunningCodex = Boolean(
          terminalId && observedTerminalIds.has(terminalId) && codexTerminalIds.has(terminalId),
        );
        if (!replacementId && terminalStillRunningCodex) continue;
        current.closedAt = snapshotObservedAt;
      }

      const observedLayouts = this.#buildObservedLayouts(
        sessions,
        matches,
        snapshotObservedAt,
      );
      for (const [windowId, observed] of observedLayouts) {
        const current = next.layouts[windowId];
        const identityChanged =
          !current ||
          current.closedAt !== undefined ||
          current.windowIndex !== observed.windowIndex ||
          !sameValue(current.tabs, observed.tabs);
        const touchDue =
          !current ||
          Date.parse(snapshotObservedAt) - Date.parse(current.lastSeenAt) >=
            RECOVERY_TOUCH_INTERVAL_MS;
        next.layouts[windowId] = {
          ...observed,
          firstSeenAt: current?.firstSeenAt ?? snapshotObservedAt,
          lastSeenAt: identityChanged || touchDue ? snapshotObservedAt : current.lastSeenAt,
        };
      }
      for (const [windowId, current] of Object.entries(next.layouts)) {
        if (observedLayouts.has(windowId) || current.closedAt) continue;
        const retainedSessionStillExists = current.tabs.some((tab) =>
          tab.panes.some((pane) => observedTerminalIds.has(pane.sessionId)),
        );
        if (retainedSessionStillExists) continue;
        current.closedAt = snapshotObservedAt;
      }

      this.#pruneClosed(next);

      if (!sameValue(next, this.#state)) {
        await this.#writeAtomic(next);
        this.#state = next;
      }

      const records = this.list();
      const changed = records.filter((record) => {
        const before = previous[record.sessionId];
        const after = next.recoveries[record.sessionId];
        return !before || !sameValue(before, after);
      });
      const removedSessionIds = Object.keys(previous).filter(
        (sessionId) => next.recoveries[sessionId] === undefined,
      );
      const layouts = this.listLayouts();
      const changedLayouts = layouts.filter((layout) => {
        const before = previousLayouts[layout.windowId];
        const after = next.layouts[layout.windowId];
        return !before || !sameValue(before, after);
      });
      const removedWindowIds = Object.keys(previousLayouts).filter(
        (windowId) => next.layouts[windowId] === undefined,
      );
      result = {
        records,
        changed,
        removedSessionIds,
        layouts,
        changedLayouts,
        removedWindowIds,
      };
    });
    return result;
  }

  #assertLoaded(): void {
    if (!this.#loaded) throw new Error("RecoveryStore.load() must complete before use.");
  }

  async #enqueue(operation: () => Promise<void>): Promise<void> {
    const pending = this.#writeQueue.then(operation, operation);
    this.#writeQueue = pending.catch(() => undefined);
    return pending;
  }

  #buildObservedLayouts(
    sessions: readonly ItermSessionSnapshot[],
    matches: readonly LegacyCodexMatch[],
    observedAt: string,
  ): Map<string, StoredWindowLayout> {
    const layouts = new Map<string, StoredWindowLayout>();
    for (const [index, session] of sessions.entries()) {
      if (session.buried || !session.windowId || !session.tabId) continue;
      let layout = layouts.get(session.windowId);
      if (!layout) {
        layout = {
          windowId: session.windowId,
          ...(session.windowIndex ? { windowIndex: session.windowIndex } : {}),
          firstSeenAt: observedAt,
          lastSeenAt: observedAt,
          tabs: [],
        };
        layouts.set(session.windowId, layout);
      }
      let tab = layout.tabs.find((candidate) => candidate.tabId === session.tabId);
      if (!tab) {
        tab = {
          tabId: session.tabId,
          tabIndex: session.tabIndex ?? layout.tabs.length + 1,
          panes: [],
        };
        layout.tabs.push(tab);
      }
      const match = matches[index];
      const conversationId =
        match?.status === "linked" && match.conversationId
          ? match.conversationId
          : undefined;
      tab.panes.push({
        sessionId: session.sessionId,
        title: normalizeItermTitle(
          session.name,
          basename(session.cwd) || "iTerm session",
        ),
        cwd: session.cwd,
        ...(session.profileName ? { profileName: session.profileName } : {}),
        ...(conversationId ? { conversationId } : {}),
        splitPath:
          session.splitPath?.map((step) => ({ ...step })) ?? [
            { vertical: true, index: Math.max(0, (session.paneIndex ?? 1) - 1) },
          ],
      });
    }
    for (const layout of layouts.values()) {
      layout.tabs.sort((left, right) => left.tabIndex - right.tabIndex);
      for (const tab of layout.tabs) {
        tab.panes.sort((left, right) =>
          left.splitPath
            .map((step) => `${step.vertical ? 1 : 0}:${String(step.index).padStart(3, "0")}`)
            .join("/")
            .localeCompare(
              right.splitPath
                .map((step) => `${step.vertical ? 1 : 0}:${String(step.index).padStart(3, "0")}`)
                .join("/"),
            ),
        );
      }
    }
    return layouts;
  }

  #pruneClosed(next: RecoveryStateFile): void {
    const cutoff = this.now().getTime() - this.retentionMs;
    const closed = Object.values(next.recoveries)
      .filter(
        (record): record is StoredRecovery & { closedAt: string } =>
          Boolean(record.closedAt) && !hasSavedHandoff(record.handoff) && !record.bookmarkTitleMarker,
      )
      .sort((left, right) => Date.parse(right.closedAt) - Date.parse(left.closedAt));
    for (const [index, record] of closed.entries()) {
      if (index >= this.maxClosedRecoveries || Date.parse(record.closedAt) < cutoff) {
        delete next.recoveries[record.sessionId];
      }
    }
    const closedLayouts = Object.values(next.layouts)
      .filter(
        (layout): layout is StoredWindowLayout & { closedAt: string } => Boolean(layout.closedAt),
      )
      .sort((left, right) => Date.parse(right.closedAt) - Date.parse(left.closedAt));
    for (const [index, layout] of closedLayouts.entries()) {
      if (index >= this.maxClosedLayouts || Date.parse(layout.closedAt) < cutoff) {
        delete next.layouts[layout.windowId];
      }
    }
  }

  async #writeAtomic(next: RecoveryStateFile): Promise<void> {
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporaryPath, this.filePath);
      await chmod(this.filePath, 0o600);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}
