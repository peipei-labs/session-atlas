import { randomUUID } from "node:crypto";

import type {
  AutoResumePreflightInput,
  AutoResumePreflightResult,
  CreateThreadInput,
  ItermWindowLayoutRecord,
  RecoveryPreviewsInput,
  RecoveryPreviewsResult,
  RecoveryRecord,
  RespondRequestInput,
  RestoreRecoveriesInput,
  RestoreRecoveriesResult,
  SessionAction,
  SessionAtlasSnapshot,
  SessionSummary,
  SessionThreadDetail,
  ThreadTagsResult,
  UpdateAttentionInput,
  UpdateThreadTagsInput,
  UpsertHandoffInput,
} from "../shared/types.js";
import { parseThreadTagUpdate, ThreadTagsValidationError } from "../shared/thread-tags.js";
import type { ServerConfig } from "./config.js";
import { AppError } from "./errors.js";
import {
  isCodexCommand,
  LegacyCodexObserver,
  type LegacyCodexMatch,
} from "./legacy-codex-observer.js";
import { normalizeItermSession } from "./normalization.js";
import { readRecoveryPreviews } from "./recovery-preview.js";
import type {
  CodexProviderPort,
  ItermBridgeHealth,
  ItermBridgePort,
  ItermRecoveryTarget,
  ItermRestoreUncertain,
  ItermSessionSnapshot,
  ProviderEvent,
} from "./provider-ports.js";
import { validateProjectCwd } from "./project-path.js";
import { SessionRegistry } from "./session-registry.js";
import { hasSavedHandoff } from "./handoff.js";
import { readContinuationRuntime, rolloutHasWriter, validateConversationId } from "./continuation-runtime.js";
import type { BookmarkTitleClient } from "./codex/daemon-titles.js";

export interface ControllerDependencies {
  config: ServerConfig;
  registry: SessionRegistry;
  codex: CodexProviderPort;
  iterm: ItermBridgePort;
  legacyCodexObserver?: LegacyCodexObserver;
  rolloutWriterCheck?: typeof rolloutHasWriter;
  bookmarkTitleClient?: BookmarkTitleClient;
}

type BookmarkTitleStatus = "applied" | "cleared" | "unchanged" | "unavailable";

interface RecoveryOpenResult {
  action: "focused" | "restored";
  terminalSessionId: string;
  windowId?: string;
}

function checkContinuationRequest(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AppError(408, "CONTINUATION_CANCELLED", "准备耗时过长或请求已取消，未继续执行关闭或恢复；请重新操作。");
  }
}

async function readForContinuation<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  let cancel!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => { try { checkContinuationRequest(signal); } catch (error) { reject(error); } };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  });
  try { return await Promise.race([operation, cancelled]); }
  finally { signal.removeEventListener("abort", cancel); }
}

function inventoryOwnership(sessions: readonly ItermSessionSnapshot[]): string {
  return JSON.stringify(sessions.map((session) => [
    session.sessionId, session.jobPid, session.jobName, session.commandLine, session.cwd, session.tty,
    session.autoResumeConversationId, session.autoResumeKind, session.autoResumeControllerPort,
  ]).sort((left, right) => String(left[0]).localeCompare(String(right[0]))));
}

export class SessionAtlasController {
  readonly config: ServerConfig;
  readonly registry: SessionRegistry;
  readonly codex: CodexProviderPort;
  readonly iterm: ItermBridgePort;
  readonly legacyCodexObserver: LegacyCodexObserver;
  #started = false;
  #hasStarted = false;
  #workQueue: Promise<void> = Promise.resolve();
  #unsubscribeCodex?: () => void;
  #pendingItermSnapshot?: {
    generation: number;
    sessions: readonly ItermSessionSnapshot[];
  };
  #itermSnapshotGeneration = 0;
  #hasAuthoritativeItermSnapshot = false;
  #itermIngestScheduled = false;
  #restorePersistenceQueue: Promise<void> = Promise.resolve();
  #recoveryObservation: Promise<void> = Promise.resolve();
  #windowRestoreReservations = new Map<string, string | null>();
  #recoveryBatchByWindow = new Map<string, string[]>();
  #recoveryBatchInProgress = false;
  #autoResumeAttempts = new Map<string, number>();
  #autoResumeFailures = new Set<string>();
  #autoResumeMarkerRevalidations = new Set<string>();
  #autoResumeClearAttempts = new Map<string, number>();
  #autoResumeClearFailures = new Set<string>();
  #autoResumeClaims = new Map<string, { terminalSessionId: string; generation: number }>();
  #autoResumeDisarmed = false;
  #continuationBusy = new Set<string>();
  #continuationResumes = new Map<string, string | undefined>();
  #savedMarkerAttempts = new Map<string, { count: number; succeeded: boolean }>();
  #registrationMarkerAttempts = new Map<string, { identity: string; count: number; succeeded: boolean }>();
  #savedMarkerObserver: LegacyCodexObserver;
  readonly #rolloutWriterCheck: typeof rolloutHasWriter;
  readonly #bookmarkTitleClient?: BookmarkTitleClient;

  readonly #onItermSnapshot = (sessions: readonly ItermSessionSnapshot[]): void => {
    this.#hasAuthoritativeItermSnapshot = true;
    this.#pendingItermSnapshot = {
      generation: ++this.#itermSnapshotGeneration,
      sessions: sessions.map((session) => ({ ...session })),
    };
    this.#scheduleItermIngest();
  };

  readonly #onItermHealth = (health: ItermBridgeHealth): void => {
    if (health.status !== "online") {
      this.#hasAuthoritativeItermSnapshot = false;
      this.#savedMarkerAttempts.clear();
    }
    this.registry.setItermHealth(health.status, health.message);
  };

  readonly #onItermRestoreUncertain = (event: ItermRestoreUncertain): void => {
    this.#restorePersistenceQueue = this.#restorePersistenceQueue
      .then(async () => {
        if (event.windowId.startsWith("thread:")) {
          await this.registry.markRecoveriesRestoreUncertain(
            [event.windowId.slice("thread:".length)],
            "恢复结果尚未确认，请先检查 iTerm2 中已经创建的分屏。",
            event.createdWindowId,
          );
          return;
        }
        const recoverySessionIds = this.#recoveryBatchByWindow.get(event.windowId);
        if (recoverySessionIds) {
          await this.registry.markRecoveriesRestoreUncertain(
            recoverySessionIds,
            "iTerm may have created part of this recovery window. Inspect the created sessions before retrying.",
            event.createdWindowId,
          );
          return;
        }
        await this.registry.markWindowLayoutRestoreUncertain(
          event.windowId,
          "iTerm may have created part of this window. Inspect the created sessions before retrying.",
          event.createdWindowId,
        );
      })
      .catch((error) => {
        this.registry.setControllerMessage(
          `Could not persist uncertain restore state: ${errorMessage(error)}`,
        );
      });
  };

  constructor(dependencies: ControllerDependencies) {
    this.config = dependencies.config;
    this.registry = dependencies.registry;
    this.codex = dependencies.codex;
    this.iterm = dependencies.iterm;
    this.legacyCodexObserver = dependencies.legacyCodexObserver ?? new LegacyCodexObserver();
    this.#savedMarkerObserver = new LegacyCodexObserver({
      codexHome: this.legacyCodexObserver.codexHome,
      readCommand: this.legacyCodexObserver.readCommand,
      readSessionMeta: this.legacyCodexObserver.readSessionMeta,
      retryAfterMs: this.legacyCodexObserver.retryAfterMs,
      trustResumeCommand: false,
    });
    this.#rolloutWriterCheck = dependencies.rolloutWriterCheck ?? rolloutHasWriter;
    this.#bookmarkTitleClient = dependencies.bookmarkTitleClient;
  }

  async start(): Promise<void> {
    if (this.#started) {
      return;
    }
    if (this.#hasStarted) {
      throw new Error("A stopped Session Atlas controller cannot be restarted; create a new instance.");
    }
    this.#hasStarted = true;
    await this.registry.load();
    this.#started = true;

    this.#unsubscribeCodex = this.codex.subscribe((event) => {
      void this.#enqueue(() => this.#handleCodexEvent(event));
    });
    this.iterm.on("snapshot", this.#onItermSnapshot);
    this.iterm.on("health", this.#onItermHealth);
    this.iterm.on("restore-uncertain", this.#onItermRestoreUncertain);

    try {
      await this.codex.start();
      this.registry.setCodexHealth(this.codex.getHealth());
      const sessions = await this.codex.list();
      await this.registry.replaceWhere(
        (session) => session.provider === "codex" && session.surface === "managed",
        sessions.filter((session) => session.surface === "managed"),
      );
    } catch (error) {
      this.registry.setCodexHealth({
        controller: "degraded",
        codex: "offline",
        iterm: this.registry.snapshot().health.iterm,
        message: `Codex provider unavailable: ${errorMessage(error)}`,
      });
    }

    try {
      await this.iterm.start();
      const health = this.iterm.getHealth();
      this.registry.setItermHealth(health.status, health.message);
      await this.#enqueue(() => this.#ingestItermSessions(
        this.iterm.getSessions(),
        ++this.#itermSnapshotGeneration,
      ));
    } catch (error) {
      this.registry.setItermHealth("offline", `iTerm bridge unavailable: ${errorMessage(error)}`);
    }
  }

  async stop(): Promise<void> {
    if (!this.#started) {
      return;
    }
    this.#started = false;
    this.#unsubscribeCodex?.();
    this.#unsubscribeCodex = undefined;
    this.iterm.off("snapshot", this.#onItermSnapshot);
    this.iterm.off("health", this.#onItermHealth);
    this.#pendingItermSnapshot = undefined;
    // Inventory normalization is read-only and may still be waiting on ps/lsof.
    // It must not delay provider shutdown or keep the LaunchAgent alive.
    await Promise.allSettled([this.codex.stop(), this.iterm.stop()]);
    await this.#recoveryObservation.catch(() => undefined);
    await this.#restorePersistenceQueue;
    this.iterm.off("restore-uncertain", this.#onItermRestoreUncertain);
  }

  snapshot(): SessionAtlasSnapshot {
    return this.registry.snapshot();
  }

  readHandoff(sessionId: string): RecoveryRecord {
    validateConversationId(sessionId);
    return this.registry.requireRecovery(sessionId);
  }

  async readThreadTags(sessionId: string): Promise<ThreadTagsResult> {
    validateConversationId(sessionId);
    const snapshot = this.snapshot();
    const known = snapshot.recoveries.some((record) => record.sessionId === sessionId)
      || snapshot.sessions.some((session) => session.provider === "codex"
        && (session.conversationId ?? (session.surface === "managed" ? session.id : undefined)) === sessionId);
    if (!known) await readContinuationRuntime(this.legacyCodexObserver.codexHome, sessionId);
    return this.registry.readThreadTags(sessionId);
  }

  async updateThreadTags(sessionId: string, input: UpdateThreadTagsInput): Promise<ThreadTagsResult> {
    validateConversationId(sessionId);
    let patch: UpdateThreadTagsInput;
    try { patch = parseThreadTagUpdate(input); }
    catch (error) {
      if (error instanceof ThreadTagsValidationError) throw new AppError(400, "VALIDATION_ERROR", error.message);
      throw error;
    }
    await readContinuationRuntime(this.legacyCodexObserver.codexHome, sessionId);
    return this.registry.updateThreadTags(sessionId, patch);
  }

  async upsertHandoff(sessionId: string, input: UpsertHandoffInput): Promise<RecoveryRecord> {
    validateConversationId(sessionId);
    return this.#withContinuation(sessionId, async () => {
      const runtime = await readContinuationRuntime(this.legacyCodexObserver.codexHome, sessionId);
      const cwd = await validateProjectCwd(
        input.source === "thread" ? runtime.cwd : input.cwd,
        this.config.allowedProjectRoots,
        this.config.deniedProjectRoots,
      );
      if (input.source !== "thread" && runtime.cwd !== cwd) {
        throw new AppError(409, "SESSION_CWD_MISMATCH", "登记目录与原线程当前目录不一致。");
      }
      const candidates = this.snapshot().sessions.filter((item) => item.conversationId === sessionId && !item.stale);
      const ids = new Set(candidates.flatMap((item) => item.terminalSessionId ? [item.terminalSessionId] : []));
      const terminal = ids.size === 1
        ? this.iterm.getSessions().find((item) => ids.has(item.sessionId))
        : undefined;
      await this.registry.upsertHandoff(sessionId, {
        ...input, cwd,
        ...(runtime.turnId ? { sourceTurnId: runtime.turnId } : {}),
      }, terminal);
      this.#refreshSavedMarkers();
      this.#registrationMarkerAttempts.delete(sessionId);
      await this.#markRegisteredPane(sessionId);
      await this.#syncBookmarkTitle(sessionId);
      return this.registry.requireRecovery(sessionId);
    });
  }

  async syncBookmarkTitleMarker(sessionId: string): Promise<{ status: BookmarkTitleStatus }> {
    validateConversationId(sessionId);
    return this.#withContinuation(sessionId, async () => {
      this.registry.requireRecovery(sessionId);
      return { status: await this.#syncBookmarkTitle(sessionId) };
    });
  }

  async #syncBookmarkTitle(sessionId: string): Promise<BookmarkTitleStatus> {
    const client = this.#bookmarkTitleClient;
    const record = this.registry.requireRecovery(sessionId);
    const marker = record.bookmarkTitleMarker;
    if (!record.handoff?.reference && !marker) return "unchanged";
    if (!client) return "unavailable";
    try {
      const name = await client.readName(sessionId);
      if (name === undefined) return "unavailable";
      if (marker) {
        if (name !== marker.originalName && name !== marker.appliedName) {
          await this.registry.updateBookmarkTitleMarker(sessionId);
          return "unchanged";
        }
        const target = record.handoff?.reference ? marker.appliedName : marker.originalName;
        if (name !== target && !await client.rename(sessionId, name, target)) return "unavailable";
        if (!record.handoff?.reference) await this.registry.updateBookmarkTitleMarker(sessionId);
        return record.handoff?.reference ? "applied" : "cleared";
      }
      if (name.startsWith("🔖 ") || !name.trim() || name.length > 256 || /[\u0000-\u001f\u007f-\u009f]/u.test(name)) return "unchanged";
      const appliedName = `🔖 ${name}`;
      // Save ownership before the RPC so a lost reply cannot leave an untracked prefix.
      await this.registry.updateBookmarkTitleMarker(sessionId, { originalName: name, appliedName });
      if (await client.rename(sessionId, name, appliedName)) return "applied";
      await this.registry.updateBookmarkTitleMarker(sessionId);
      return "unavailable";
    } catch {
      // The card is already saved; an explicit sync or later open can retry the title.
      return "unavailable";
    }
  }

  // A successful registration marks the one verifiably linked live pane, so the card is visible there.
  // Marking is best-effort: a closed, buried, or ambiguous pane stays untouched and a later open retries it.
  async #markRegisteredPane(sessionId: string): Promise<void> {
    if (!this.iterm.configureSavedMarker || !hasSavedHandoff(this.registry.getHandoff(sessionId))) return;
    try {
      const ownership = inventoryOwnership(this.iterm.getSessions());
      const terminals = await this.#findLiveContinuationTerminals(sessionId);
      if (!this.#started || !this.#hasAuthoritativeItermSnapshot || this.iterm.getHealth().status !== "online"
        || inventoryOwnership(this.iterm.getSessions()) !== ownership
        || !hasSavedHandoff(this.registry.getHandoff(sessionId))) return;
      const terminal = terminals.length === 1 ? terminals[0] : undefined;
      if (!terminal || terminal.buried) return;
      if (terminal.savedMarkerConversationId === sessionId
        && terminal.savedMarkerOwnerSessionId === terminal.sessionId
        && terminal.savedMarkerState === "applied") return;
      const identity = inventoryOwnership([terminal]);
      const previous = this.#registrationMarkerAttempts.get(sessionId);
      const attempt = previous?.identity === identity ? previous : { identity, count: 0, succeeded: false };
      if (attempt.succeeded || attempt.count >= 2) return;
      attempt.count += 1;
      this.#registrationMarkerAttempts.set(sessionId, attempt);
      await this.iterm.configureSavedMarker(terminal, sessionId);
      attempt.succeeded = true;
    } catch { /* A later explicit open or reconcile pass can retry the optional visual marker. */ }
  }

  async removeHandoff(sessionId: string, expectedVersion: string | null): Promise<void> {
    validateConversationId(sessionId);
    await this.#withContinuation(sessionId, async () => {
      await this.registry.removeHandoff(sessionId, expectedVersion);
      await this.#syncBookmarkTitle(sessionId);
    });
    this.#refreshSavedMarkers();
  }

  async parkTerminal(terminalSessionId: string, signal?: AbortSignal): Promise<{ closed: true; terminalSessionId: string }> {
    checkContinuationRequest(signal);
    this.#requireContinuationBridge();
    const session = this.snapshot().sessions.find((item) => item.terminalSessionId === terminalSessionId);
    if (!session?.conversationId) {
      throw new AppError(409, "SESSION_NOT_LINKED", "尚未取得这个分屏的唯一 Codex 会话记录，分屏已保留。空白会话或已完成的工作请使用 iTerm2 普通关闭。");
    }
    if (!hasSavedHandoff(this.registry.getHandoff(session.conversationId))) {
      throw new AppError(409, "HANDOFF_REQUIRED", "这个分屏还没有待续或收藏。请在原线程使用 $session-atlas-handoff，或在面板登记后再关闭。");
    }
    return this.closeHandoff(session.conversationId, terminalSessionId, signal);
  }

  async closeHandoff(sessionId: string, targetSessionId?: string, signal?: AbortSignal): Promise<{ closed: true; terminalSessionId: string }> {
    validateConversationId(sessionId);
    checkContinuationRequest(signal);
    return this.#withContinuation(sessionId, async () => {
      const recovery = this.registry.requireRecovery(sessionId);
      if (!hasSavedHandoff(recovery.handoff)) {
        throw new AppError(409, "HANDOFF_REQUIRED", "没有待续或收藏；不需要保留的会话可以正常关闭。");
      }
      if (recovery.handoff?.requiresRunningProcess) {
        throw new AppError(409, "SESSION_REQUIRES_PROCESS", "后续事项依赖仍在运行的本地进程，暂未关闭分屏。");
      }
      this.#requireContinuationBridge();
      if (!this.iterm.closeSession) throw new AppError(503, "BRIDGE_UPDATE_REQUIRED", "请更新 Session Atlas 的 iTerm2 companion。");
      const terminals = await this.#findLiveContinuationTerminals(sessionId, signal);
      if (terminals.length !== 1 || (targetSessionId && terminals[0]!.sessionId !== targetSessionId)) {
        throw new AppError(409, "SESSION_TARGET_CHANGED", "原线程尚未关联到唯一的当前分屏，未执行关闭。");
      }
      const terminal = terminals[0]!;
      if (terminal.buried) {
        throw new AppError(409, "SESSION_TARGET_CHANGED", "分屏的位置已经变化，请重新核对后再关闭。");
      }
      await this.registry.saveRecoveryLocation(sessionId, terminal);
      checkContinuationRequest(signal);
      const runtime = await readForContinuation(readContinuationRuntime(this.legacyCodexObserver.codexHome, sessionId), signal);
      if (runtime.state !== "idle") {
        throw new AppError(409, "SESSION_NOT_IDLE", "原线程仍在执行，或尚不能确认本轮已结束；记录已保存，分屏未关闭。");
      }
      const referenceOnly = Boolean(recovery.handoff!.reference) &&
        !recovery.handoff!.items.some((item) => item.status === "pending");
      if (!referenceOnly && ((runtime.turnStartedAt && Date.parse(runtime.turnStartedAt) > Date.parse(recovery.handoff!.updatedAt)) ||
          (recovery.handoff?.sourceTurnId && runtime.turnId && recovery.handoff.sourceTurnId !== runtime.turnId))) {
        throw new AppError(409, "HANDOFF_STALE", "登记之后原线程又开始了新一轮，请先更新待续事项。");
      }
      const cwd = await readForContinuation(validateProjectCwd(runtime.cwd, this.config.allowedProjectRoots, this.config.deniedProjectRoots), signal);
      if (cwd !== recovery.cwd) await this.registry.updateRecoveryCwd(sessionId, cwd);
      checkContinuationRequest(signal);
      await this.#callProvider(() => this.iterm.closeSession!(terminal, sessionId, runtime.closeProof), "记录已保存，但 iTerm2 未能关闭这个分屏。");
      return { closed: true as const, terminalSessionId: terminal.sessionId };
    });
  }

  async resumeHandoff(sessionId: string, signal?: AbortSignal, cwd?: string): Promise<RecoveryOpenResult> {
    return this.#openRecovery(sessionId, true, signal, cwd);
  }

  async openRecovery(sessionId: string, signal?: AbortSignal, cwd?: string): Promise<RecoveryOpenResult> {
    return this.#openRecovery(sessionId, false, signal, cwd);
  }

  async #openRecovery(sessionId: string, requireHandoff: boolean, signal?: AbortSignal, requestedCwd?: string): Promise<RecoveryOpenResult> {
    validateConversationId(sessionId);
    checkContinuationRequest(signal);
    return this.#withContinuation(sessionId, async () => {
      const recovery = this.registry.requireRecovery(sessionId);
      if (requireHandoff && !hasSavedHandoff(recovery.handoff)) throw new AppError(409, "HANDOFF_REQUIRED", "这个线程没有待续或收藏。");
      const requireUnmanaged = () => {
        if (this.snapshot().sessions.some((session) => session.provider === "codex" && session.surface === "managed"
          && !session.stale && (session.conversationId ?? session.id) === sessionId)) {
          throw new AppError(409, "SESSION_MANAGED_ACTIVE", "原线程已在 Session Atlas 工作台打开，请回到工作台继续。");
        }
      };
      const recheckRequest = () => {
        checkContinuationRequest(signal);
        requireUnmanaged();
        this.#requireContinuationBridge();
      };
      let ownership: string;
      const findTarget = async () => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          recheckRequest();
          ownership = inventoryOwnership(this.iterm.getSessions());
          const terminals = await this.#findLiveContinuationTerminals(sessionId, signal);
          recheckRequest();
          if (terminals.length > 1) throw new AppError(409, "SESSION_TARGET_AMBIGUOUS", "这个线程关联了多个分屏，请先检查现有窗口。");
          if (terminals[0]) return terminals[0];
          if (inventoryOwnership(this.iterm.getSessions()) === ownership) return undefined;
        }
        throw new AppError(409, "SESSION_TARGET_CHANGED", "分屏归属持续变化，暂时无法确认原线程是否已打开，请稍后重试。");
      };
      const focusTarget = async (target: ItermSessionSnapshot): Promise<RecoveryOpenResult> => {
        recheckRequest();
        const current = this.iterm.getSessions().find((terminal) => terminal.sessionId === target.sessionId);
        const identity = (terminal: ItermSessionSnapshot) => JSON.stringify([
          terminal.sessionId, terminal.jobPid, terminal.jobName, terminal.commandLine, terminal.cwd, terminal.tty,
        ]);
        if (!current || identity(current) !== identity(target)) {
          throw new AppError(409, "SESSION_TARGET_CHANGED", "原分屏的线程归属已变化，请重新打开。");
        }
        const beforeFocus = inventoryOwnership(this.iterm.getSessions());
        await this.#callProvider(() => this.iterm.focus(current.sessionId), "无法定位原线程。");
        if (this.#started && this.iterm.getHealth().status === "online"
          && beforeFocus === ownership && inventoryOwnership(this.iterm.getSessions()) === beforeFocus
          && hasSavedHandoff(this.registry.getHandoff(sessionId))) {
          // A marker failure must not turn a successful focus into a retryable restore failure.
          try { await this.iterm.configureSavedMarker?.(current, sessionId); }
          catch { /* A later explicit open can retry the optional visual marker. */ }
        }
        await this.#syncBookmarkTitle(sessionId);
        return { action: "focused", terminalSessionId: current.sessionId, windowId: current.windowId };
      };
      const refreshChangedTarget = async () => {
        recheckRequest();
        return inventoryOwnership(this.iterm.getSessions()) !== ownership ? findTarget() : undefined;
      };
      const target = await findTarget();
      if (target) return focusTarget(target);
      if (this.#continuationResumes.has(sessionId) || recovery.restoreStatus === "partial") {
        throw new AppError(409, "RECOVERY_RESTORE_UNCERTAIN", "已请求恢复这个线程，请先检查新建分屏，等待关联完成。");
      }
      const layoutRestoring = this.snapshot().windowLayouts.some((layout) =>
        (this.#windowRestoreReservations.has(layout.windowId) || layout.restoreStatus === "partial") &&
        layout.tabs.some((tab) => tab.panes.some((pane) => pane.conversationId === sessionId)),
      );
      if (layoutRestoring || [...this.#recoveryBatchByWindow.values()].some((ids) => ids.includes(sessionId))) {
        throw new AppError(409, "RECOVERY_RESTORE_IN_PROGRESS", "这个线程正在通过恢复历史打开，请等待关联完成。");
      }
      if (!this.iterm.restoreThread) throw new AppError(503, "BRIDGE_UPDATE_REQUIRED", "请更新 Session Atlas 的 iTerm2 companion。");
      const runtime = await readForContinuation(readContinuationRuntime(this.legacyCodexObserver.codexHome, sessionId), signal);
      const cwd = await readForContinuation(validateProjectCwd(requestedCwd ?? recovery.cwdOverride ?? runtime.cwd, this.config.allowedProjectRoots, this.config.deniedProjectRoots), signal);
      const hasWriter = await readForContinuation(this.#rolloutWriterCheck(runtime.path), signal);
      const openedDuringPreparation = await refreshChangedTarget();
      if (openedDuringPreparation) return focusTarget(openedDuringPreparation);
      if (hasWriter) {
        throw new AppError(409, "SESSION_ACTIVE_ELSEWHERE", "原线程仍被其他进程打开，请先定位或关闭原实例。");
      }
      if (cwd !== recovery.cwd || requestedCwd !== undefined) await this.registry.updateRecoveryCwd(sessionId, cwd, requestedCwd !== undefined);
      recheckRequest();
      this.#continuationResumes.set(sessionId, undefined);
      try {
        await this.registry.markRecoveriesRestoreUncertain([sessionId], "已请求恢复，等待新分屏与原线程关联。");
      } catch (error) {
        this.#continuationResumes.delete(sessionId);
        throw error;
      }
      let reservationCleared = false;
      try {
        const openedDuringPersistence = await refreshChangedTarget();
        if (openedDuringPersistence) {
          await this.registry.clearRecoveryRestoreState(sessionId);
          this.#continuationResumes.delete(sessionId);
          reservationCleared = true;
          return await focusTarget(openedDuringPersistence);
        }
        recheckRequest();
        const result = await this.#callProvider(() => this.iterm.restoreThread!({
          conversationId: sessionId, cwd, title: recovery.title,
          windowId: recovery.savedLocation?.windowId,
          profileName: recovery.savedLocation?.profileName,
          ...(hasSavedHandoff(this.registry.getHandoff(sessionId)) ? { savedCard: true } : {}),
        }, this.config.port), "无法恢复原线程。");
        this.#continuationResumes.set(sessionId, result.terminalSessionId);
        await this.#syncBookmarkTitle(sessionId);
        return { action: "restored", ...result };
      } catch (error) {
        if (!(error instanceof AppError && error.code === "WINDOW_RESTORE_PARTIAL")) {
          this.#continuationResumes.delete(sessionId);
          if (!reservationCleared) await this.registry.clearRecoveryRestoreState(sessionId);
        }
        throw error;
      }
    });
  }

  #requireContinuationBridge(): void {
    if (this.iterm.getHealth().status !== "online" || !this.#hasAuthoritativeItermSnapshot) {
      throw new AppError(503, "ITERM_OFFLINE", "iTerm2 连接或会话清单暂时不可用。");
    }
  }

  async #findLiveContinuationTerminals(sessionId: string, signal?: AbortSignal): Promise<ItermSessionSnapshot[]> {
    checkContinuationRequest(signal);
    this.#requireContinuationBridge();
    const terminals = this.iterm.getSessions().map((terminal) => ({ ...terminal }));
    const observer = new LegacyCodexObserver({
      codexHome: this.legacyCodexObserver.codexHome,
      readCommand: this.legacyCodexObserver.readCommand,
      readSessionMeta: this.legacyCodexObserver.readSessionMeta,
      trustResumeCommand: false,
    });
    const matches = await readForContinuation(observer.observeAll(terminals), signal);
    checkContinuationRequest(signal);
    return terminals.filter((_, index) => matches[index]?.status === "linked" && matches[index]?.conversationId === sessionId);
  }

  async #withContinuation<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    if (this.#continuationBusy.has(sessionId)) throw new AppError(409, "HANDOFF_BUSY", "这个线程的操作尚未完成。");
    this.#continuationBusy.add(sessionId);
    try { return await operation(); }
    finally { this.#continuationBusy.delete(sessionId); }
  }

  async preflightAutoResume(
    input: AutoResumePreflightInput,
  ): Promise<AutoResumePreflightResult> {
    let result: AutoResumePreflightResult | undefined;
    await this.#enqueue(async () => {
      const ownership = inventoryOwnership(this.#pendingItermSnapshot?.sessions ?? this.iterm.getSessions());
      await this.#drainPendingItermSnapshots();
      if (
        this.iterm.getHealth().status !== "online" ||
        !this.#hasAuthoritativeItermSnapshot
      ) {
        throw new AppError(
          503,
          "ITERM_SNAPSHOT_UNAVAILABLE",
          "An authoritative iTerm snapshot is not available yet.",
        );
      }
      if (this.#pendingItermSnapshot && inventoryOwnership(this.#pendingItermSnapshot.sessions) !== ownership) {
        throw new AppError(503, "ITERM_SNAPSHOT_UNAVAILABLE", "Terminal ownership changed during recovery preflight; retry with the latest inventory.");
      }
      const snapshot = this.snapshot();
      const recordedOwner = snapshot.recoveries.find(
        (recovery) => recovery.status === "active" && recovery.sessionId === input.conversationId,
      )?.terminalSessionId;
      const runningOwner = snapshot.sessions.find(
        (session) => session.conversationId === input.conversationId && session.terminalSessionId,
      )?.terminalSessionId;
      const markedOwner = this.iterm.getSessions().find(
        (session) => session.autoResumeConversationId === input.conversationId,
      )?.sessionId;
      const owner = recordedOwner ?? runningOwner ?? markedOwner ??
        this.#autoResumeClaims.get(input.conversationId)?.terminalSessionId ??
        input.terminalSessionId;
      this.#autoResumeClaims.set(input.conversationId, {
        terminalSessionId: owner,
        generation: this.#itermSnapshotGeneration,
      });
      const activeElsewhere = owner !== input.terminalSessionId;
      if (!activeElsewhere || this.iterm.getHealth().status !== "online") {
        result = { activeElsewhere, duplicateProfileCleared: false };
        return;
      }

      try {
        await this.iterm.clearAutoResume(input.terminalSessionId, input.conversationId);
        result = { activeElsewhere: true, duplicateProfileCleared: true };
      } catch {
        result = { activeElsewhere: true, duplicateProfileCleared: false };
      }
    });
    if (!result) throw new AppError(503, "CONTROLLER_STOPPED", "Session Atlas is stopping.");
    return result;
  }

  async disarmAutoResume(): Promise<{ cleared: number }> {
    let result: { cleared: number } | undefined;
    await this.#enqueue(async () => {
      await this.#drainPendingItermSnapshots();
      if (
        this.iterm.getHealth().status !== "online" ||
        !this.#hasAuthoritativeItermSnapshot
      ) {
        throw new AppError(
          503,
          "ITERM_OFFLINE",
          "The iTerm bridge must be online before automatic recovery can be disarmed.",
        );
      }
      const candidates = this.iterm.getSessions().flatMap((session) =>
        session.autoResumeConversationId
          ? [{ sessionId: session.sessionId, conversationId: session.autoResumeConversationId }]
          : [],
      );
      for (const candidate of candidates) {
        try {
          await this.iterm.clearAutoResume(candidate.sessionId, candidate.conversationId);
        } catch (error) {
          throw new AppError(
            503,
            "AUTO_RESUME_DISARM_FAILED",
            "An owned iTerm recovery command could not be cleared.",
            { cause: error },
          );
        }
      }
      this.#autoResumeDisarmed = true;
      result = { cleared: candidates.length };
    });
    if (!result) throw new AppError(503, "CONTROLLER_STOPPED", "Session Atlas is stopping.");
    return result;
  }

  async readSessionDetail(sessionId: string): Promise<SessionThreadDetail> {
    const session = this.registry.requireSession(sessionId);
    const plan = session.plan
      ? {
          ...session.plan,
          steps: session.plan.steps.map((step) => ({ ...step })),
        }
      : undefined;
    if (session.provider !== "codex") {
      return {
        sessionId,
        ...(plan ? { plan } : {}),
        message: "该终端不是已关联的 Codex 线程，无法读取执行记录。",
      };
    }
    if (!session.conversationId) {
      return {
        sessionId,
        ...(plan ? { plan } : {}),
        message: "该 Codex 线程尚未完成精确关联，无法读取执行记录。",
      };
    }

    const execution = await this.#callProvider(
      () => this.codex.readExecution(session.conversationId!),
      "Codex could not read the thread execution record.",
    );
    return {
      sessionId,
      ...(plan ? { plan } : {}),
      ...(execution.steps.length > 0
        ? { execution }
        : { message: "该线程本轮还没有可展示的执行记录。" }),
    };
  }

  async readRecoveryPreviews(
    input: RecoveryPreviewsInput,
    signal?: AbortSignal,
  ): Promise<RecoveryPreviewsResult> {
    const requireClosed = () => {
      for (const sessionId of input.sessionIds) {
        const recovery = this.registry.requireRecovery(sessionId);
        if (recovery.status !== "closed") {
          throw new AppError(
            409,
            "RECOVERY_STILL_ACTIVE",
            `${recovery.title} is still active and cannot be previewed.`,
          );
        }
      }
    };
    requireClosed();
    const previews = await readRecoveryPreviews(
      this.legacyCodexObserver.codexHome,
      input.sessionIds,
      signal,
    );
    requireClosed();
    return { previews };
  }

  async createThread(input: CreateThreadInput): Promise<SessionSummary> {
    this.#requireCodexWritable();
    const cwd = await validateProjectCwd(
      input.cwd,
      this.config.allowedProjectRoots,
      this.config.deniedProjectRoots,
    );
    const created = await this.#callProvider(
      () => this.codex.createThread({ ...input, cwd }),
      "Codex could not create the thread.",
    );
    return this.registry.upsert(created);
  }

  async focus(sessionId: string): Promise<void> {
    const session = this.#requireCapability(sessionId, "focus");
    if (!session.terminalSessionId) {
      throw new AppError(409, "SESSION_NOT_FOCUSABLE", "The session has no iTerm target.");
    }
    if (this.iterm.getHealth().status !== "online") {
      throw new AppError(503, "ITERM_OFFLINE", "The iTerm bridge is offline.");
    }
    await this.#callProvider(
      () => this.iterm.focus(session.terminalSessionId!),
      "iTerm could not focus the session.",
    );
  }

  async restoreWindowLayout(windowId: string): Promise<void> {
    const layout = this.registry.requireWindowLayout(windowId);
    for (const pane of layout.tabs.flatMap((tab) => tab.panes)) {
      if (pane.conversationId && (this.#continuationBusy.has(pane.conversationId) || this.#continuationResumes.has(pane.conversationId))) {
        throw new AppError(409, "RECOVERY_RESTORE_IN_PROGRESS", "该窗口中的一个线程正在单独恢复，请等待关联完成。");
      }
    }
    if (layout.status !== "closed") {
      throw new AppError(
        409,
        "WINDOW_LAYOUT_STILL_ACTIVE",
        "Only a closed iTerm window layout can be restored.",
      );
    }
    if (layout.restoreStatus === "partial") {
      throw new AppError(
        409,
        "WINDOW_LAYOUT_RESTORE_UNCERTAIN",
        layout.restoreMessage ??
          "iTerm may already have created part of this window. Inspect it before retrying.",
      );
    }
    if (this.#windowRestoreReservations.has(windowId)) {
      throw new AppError(
        409,
        "WINDOW_LAYOUT_RESTORE_PENDING_OBSERVATION",
        "This iTerm window was restored and is waiting for the next observed layout.",
      );
    }
    if (this.iterm.getHealth().status !== "online") {
      throw new AppError(503, "ITERM_OFFLINE", "The iTerm bridge is offline.");
    }
    this.#windowRestoreReservations.set(windowId, null);
    try {
      const createdWindowId = await this.#callProvider(
        () => this.iterm.restoreLayout(layout, this.config.port),
        "iTerm window restoration failed.",
      );
      this.#windowRestoreReservations.set(windowId, createdWindowId ?? null);
    } catch (error) {
      if (error instanceof AppError && error.code === "WINDOW_RESTORE_PARTIAL") {
        const cause = error.cause as { createdWindowId?: unknown } | undefined;
        await this.registry.markWindowLayoutRestoreUncertain(
          windowId,
          "iTerm may have created part of this window. Inspect the created sessions before retrying.",
          typeof cause?.createdWindowId === "string" ? cause.createdWindowId : undefined,
        );
        this.#windowRestoreReservations.delete(windowId);
        throw new AppError(
          409,
          "WINDOW_LAYOUT_RESTORE_UNCERTAIN",
          "iTerm may have created part of this window. Inspect the created sessions before retrying.",
          { cause: error },
        );
      }
      this.#windowRestoreReservations.delete(windowId);
      throw error;
    }
  }

  async restoreRecoveries(input: RestoreRecoveriesInput): Promise<RestoreRecoveriesResult> {
    if (input.sessionIds.some((id) => this.#continuationBusy.has(id) || this.#continuationResumes.has(id))) {
      throw new AppError(409, "RECOVERY_RESTORE_IN_PROGRESS", "一个待续线程正在恢复，请等待关联完成。");
    }
    if (this.iterm.getHealth().status !== "online") {
      throw new AppError(503, "ITERM_OFFLINE", "The iTerm bridge is offline.");
    }
    if (this.#recoveryBatchInProgress) {
      throw new AppError(
        409,
        "RECOVERY_BATCH_IN_PROGRESS",
        "Another recovery batch is already in progress.",
      );
    }
    if (this.snapshot().windowLayouts.some((layout) =>
      (this.#windowRestoreReservations.has(layout.windowId) || layout.restoreStatus === "partial") &&
      layout.tabs.some((tab) => tab.panes.some((pane) => pane.conversationId && input.sessionIds.includes(pane.conversationId))),
    )) {
      throw new AppError(409, "RECOVERY_RESTORE_IN_PROGRESS", "一个待恢复线程所属的窗口正在恢复，请等待关联完成。");
    }

    const terminalById = new Map(
      this.iterm.getSessions().map((session) => [session.sessionId, session]),
    );
    const usedTerminalIds = new Set<string>();
    const candidates = input.sessionIds.map((sessionId) => {
      const recovery = this.registry.requireRecovery(sessionId);
      if (recovery.status !== "closed") {
        throw new AppError(
          409,
          "RECOVERY_STILL_ACTIVE",
          `${recovery.title} is already active.`,
        );
      }
      if (recovery.restoreStatus === "partial") {
        throw new AppError(
          409,
          "RECOVERY_RESTORE_UNCERTAIN",
          recovery.restoreMessage ??
            "iTerm may already have created part of this recovery window. Inspect it before retrying.",
        );
      }
      const terminal = recovery.terminalSessionId
        ? terminalById.get(recovery.terminalSessionId)
        : undefined;
      if (
        !terminal ||
        terminal.buried ||
        !isIdleShell(terminal.jobName)
      ) {
        throw new AppError(
          409,
          "RECOVERY_NOT_RESTART_PLACEHOLDER",
          `${recovery.title} no longer has its original idle iTerm pane.`,
        );
      }
      if (usedTerminalIds.has(recovery.terminalSessionId!)) {
        throw new AppError(
          409,
          "RECOVERY_PLACEHOLDER_DUPLICATE",
          "Only the newest Codex session for each original iTerm pane can be restored.",
        );
      }
      usedTerminalIds.add(recovery.terminalSessionId!);
      return { recovery, terminal };
    });
    candidates.sort(
      (left, right) =>
        (left.terminal.windowIndex ?? Number.MAX_SAFE_INTEGER) -
          (right.terminal.windowIndex ?? Number.MAX_SAFE_INTEGER) ||
        (left.terminal.tabIndex ?? Number.MAX_SAFE_INTEGER) -
          (right.terminal.tabIndex ?? Number.MAX_SAFE_INTEGER) ||
        (left.terminal.paneIndex ?? Number.MAX_SAFE_INTEGER) -
          (right.terminal.paneIndex ?? Number.MAX_SAFE_INTEGER),
    );

    const batchId = `recovery-batch:${randomUUID()}`;
    this.#recoveryBatchInProgress = true;
    this.#recoveryBatchByWindow.set(batchId, candidates.map(({ recovery }) => recovery.sessionId));
    for (const { recovery } of candidates) this.#continuationBusy.add(recovery.sessionId);
    try {
      const recheck = () => {
        if (!this.#started || this.iterm.getHealth().status !== "online") {
          throw new AppError(503, "ITERM_OFFLINE", "Session Atlas or its iTerm bridge is offline.");
        }
        for (const { recovery, terminal } of candidates) {
          const current = this.registry.requireRecovery(recovery.sessionId);
          const live = this.iterm.getSessions().find((session) => session.sessionId === terminal.sessionId);
          if (current.status !== "closed" || current.restoreStatus === "partial" ||
            current.terminalSessionId !== terminal.sessionId || !live || live.buried ||
            live.cwd !== terminal.cwd || !isIdleShell(live.jobName)) {
            throw new AppError(409, "RECOVERY_NOT_RESTART_PLACEHOLDER", "原线程或待恢复分屏已变化，请刷新后重试。");
          }
        }
      };
      const prepared = [];
      for (const candidate of candidates) {
        const runtime = await readContinuationRuntime(this.legacyCodexObserver.codexHome, candidate.recovery.sessionId);
        const cwd = await validateProjectCwd(candidate.recovery.cwdOverride ?? runtime.cwd, this.config.allowedProjectRoots, this.config.deniedProjectRoots);
        if (await this.#rolloutWriterCheck(runtime.path)) {
          throw new AppError(409, "SESSION_ACTIVE_ELSEWHERE", "原线程仍被其他进程打开，请先定位或关闭原实例。");
        }
        prepared.push({ ...candidate, cwd });
      }
      recheck();
      for (const { recovery, cwd } of prepared) {
        if (cwd !== recovery.cwd) await this.registry.updateRecoveryCwd(recovery.sessionId, cwd);
      }
      recheck();
      const targets: ItermRecoveryTarget[] = prepared.map(({ recovery, terminal, cwd }) => ({
        targetSessionId: terminal.sessionId,
        cwd,
        expectedPlaceholderCwd: terminal.cwd,
        conversationId: recovery.sessionId,
        title: recovery.title,
        ...(terminal.profileName ? { profileName: terminal.profileName } : {}),
        splitVertical: terminal.splitPath?.at(-1)?.vertical ?? false,
      }));
      await this.#callProvider(
        () => this.iterm.restoreRecoveries(batchId, targets, this.config.port),
        "iTerm recovery batch failed.",
      );
    } catch (error) {
      if (error instanceof AppError && error.code === "WINDOW_RESTORE_PARTIAL") {
        await this.#restorePersistenceQueue;
        throw new AppError(
          409,
          "RECOVERY_RESTORE_UNCERTAIN",
          "iTerm may have created part of this recovery window. Inspect the created sessions before retrying.",
          { cause: error },
        );
      }
      throw error;
    } finally {
      this.#recoveryBatchByWindow.delete(batchId);
      this.#recoveryBatchInProgress = false;
      for (const { recovery } of candidates) this.#continuationBusy.delete(recovery.sessionId);
    }

    return {
      requested: candidates.length,
      sessionIds: candidates.map(({ recovery }) => recovery.sessionId),
    };
  }

  async sendMessage(sessionId: string, text: string): Promise<void> {
    const session = this.registry.requireSession(sessionId);
    const action: SessionAction = session.activityState === "running" ? "steer" : "send";
    this.#assertCapability(session, action);
    const threadId = this.#managedThreadId(session);
    await this.#callProvider(
      () => this.codex.sendMessage(threadId, text),
      "Codex could not send the message.",
    );
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.#requireCapability(sessionId, "interrupt");
    await this.#callProvider(
      () => this.codex.interrupt(this.#managedThreadId(session)),
      "Codex could not interrupt the turn.",
    );
  }

  async respondRequest(
    sessionId: string,
    requestId: string,
    input: RespondRequestInput,
  ): Promise<void> {
    const session = this.registry.requireSession(sessionId);
    const pendingRequest = session.pendingRequest;
    if (!pendingRequest || pendingRequest.requestId !== requestId) {
      throw new AppError(409, "REQUEST_STALE", "The pending request is no longer active.");
    }
    this.#assertCapability(session, pendingRequest.kind === "approval" ? "approve" : "answer");
    await this.#callProvider(
      () =>
        this.codex.respondRequest(
          this.#managedThreadId(session),
          pendingRequest.requestId,
          input,
        ),
      "Codex could not answer the request.",
    );
  }

  updateAttention(sessionId: string, input: UpdateAttentionInput): Promise<SessionSummary> {
    return this.registry.updateAttention(sessionId, input);
  }

  #requireCodexWritable(): void {
    const status = this.registry.snapshot().health.codex;
    if (status === "readonly") {
      throw new AppError(503, "CODEX_READ_ONLY", "Codex is in read-only compatibility mode.");
    }
    if (status !== "online") {
      throw new AppError(503, "CODEX_OFFLINE", "Codex is offline.");
    }
  }

  #managedThreadId(session: SessionSummary): string {
    if (session.provider !== "codex" || session.surface !== "managed") {
      throw new AppError(
        409,
        "SESSION_READ_ONLY",
        "Only dashboard-managed Codex sessions accept this action.",
      );
    }
    return session.conversationId ?? session.id;
  }

  #requireCapability(sessionId: string, action: SessionAction): SessionSummary {
    const session = this.registry.requireSession(sessionId);
    this.#assertCapability(session, action);
    return session;
  }

  #assertCapability(session: SessionSummary, action: SessionAction): void {
    if (!session.capabilities[action]) {
      throw new AppError(
        409,
        "CAPABILITY_UNAVAILABLE",
        `The session does not currently support ${action}.`,
      );
    }
  }

  async #handleCodexEvent(event: ProviderEvent): Promise<void> {
    switch (event.type) {
      case "session-upsert":
        if (event.session.surface === "managed") {
          await this.registry.upsert(event.session);
        } else if (this.registry.getSession(event.session.id)?.surface === "managed") {
          this.registry.remove(event.session.id);
        }
        break;
      case "session-remove":
        this.registry.remove(event.sessionId);
        break;
      case "health":
        this.registry.setCodexHealth(event.health);
        break;
    }
  }

  async #ingestItermSessions(
    sessions: readonly ItermSessionSnapshot[],
    generation: number,
  ): Promise<void> {
    const matches = await this.legacyCodexObserver.observeAll(sessions);
    if (!this.#started) return;
    for (const [conversationId, claim] of this.#autoResumeClaims) {
      if (generation <= claim.generation) continue;
      const ownerIndex = sessions.findIndex(
        (session) => session.sessionId === claim.terminalSessionId,
      );
      const owner = ownerIndex >= 0 ? sessions[ownerIndex] : undefined;
      const ownerMatch = ownerIndex >= 0 ? matches[ownerIndex] : undefined;
      const ownerChanged =
        ownerMatch?.status === "unlinked" ||
        (ownerMatch?.status === "linked" && ownerMatch.conversationId !== conversationId);
      if (!owner || (owner.autoResumeConversationId !== conversationId && ownerChanged)) {
        this.#autoResumeClaims.delete(conversationId);
      }
    }
    sessions.forEach((session, index) => {
      const match = matches[index];
      if (match?.status === "linked" && match.conversationId) {
        this.#continuationResumes.delete(match.conversationId);
        this.iterm.confirmThreadRestored?.(match.conversationId, session.sessionId);
        this.#autoResumeClaims.set(match.conversationId, {
          terminalSessionId: session.sessionId,
          generation,
        });
      }
    });
    const codexMatches = sessions.flatMap((session, index) =>
      isCodexCommand(`${session.jobName ?? ""} ${session.commandLine ?? ""}`) ||
      matches[index]?.status === "linked"
        ? [matches[index] ?? { status: "unlinked" as const }]
        : [],
    );
    if (this.iterm.getHealth().status === "online") {
      this.#recoveryObservation = this.registry.observeRecoveries(sessions, matches);
      await this.#recoveryObservation;
      const observedWindowIds = new Set(
        sessions.flatMap((session) => session.windowId ? [session.windowId] : []),
      );
      for (const [windowId, createdWindowId] of this.#windowRestoreReservations) {
        if (createdWindowId !== null && observedWindowIds.has(createdWindowId)) {
          this.#windowRestoreReservations.delete(windowId);
        }
      }
    }
    const autoResumeFailures = await this.#configureAutomaticRecovery(sessions, matches);
    await this.#reconcileSavedMarkers(sessions);
    const savedIds = new Set(this.registry.snapshot().recoveries
      .filter((record) => hasSavedHandoff(record.handoff)).map((record) => record.sessionId));
    for (const id of this.#registrationMarkerAttempts.keys()) {
      if (!savedIds.has(id)) this.#registrationMarkerAttempts.delete(id);
    }
    for (const id of savedIds) {
      if (this.#continuationBusy.has(id)) continue;
      const linked = sessions.filter((_, index) => matches[index]?.status === "linked" && matches[index]?.conversationId === id);
      if (linked.length === 1 && !linked[0]!.savedMarkerConversationId && !linked[0]!.buried) {
        const previous = this.#registrationMarkerAttempts.get(id);
        if (previous?.identity === inventoryOwnership(linked) && (previous.succeeded || previous.count >= 2)) continue;
        await this.#markRegisteredPane(id);
      }
    }
    this.registry.setRecoveryHealth(
      codexMatches.filter((match) => match.status !== "linked").length,
      codexMatches.filter((match) => match.status === "error").length,
      this.config.autoResumeEnabled,
      autoResumeFailures,
    );
    const normalized = await Promise.all(
      sessions.map((session, index) =>
        normalizeItermSession(session, matches[index] ?? { status: "unlinked" }),
      ),
    );
    if (!this.#started) {
      return;
    }
    await this.registry.replaceWhere(
      (session) => session.surface === "legacy" && Boolean(session.terminalSessionId),
      normalized,
    );
  }

  #refreshSavedMarkers(): void {
    if (this.#started && this.#hasAuthoritativeItermSnapshot && this.iterm.getHealth().status === "online"
      && this.iterm.getSessions().some((session) => session.savedMarkerConversationId)) {
      this.#onItermSnapshot(this.iterm.getSessions());
    }
  }

  async #reconcileSavedMarkers(sessions: readonly ItermSessionSnapshot[]): Promise<void> {
    if (!this.#started || !this.#hasAuthoritativeItermSnapshot || this.iterm.getHealth().status !== "online") return;
    const marked = sessions.filter((session) => session.savedMarkerConversationId);
    if (marked.length === 0) { this.#savedMarkerAttempts.clear(); return; }
    const ownership = inventoryOwnership(sessions);
    // A resume command can exist before the original thread is actually open.
    const matches = await this.#savedMarkerObserver.observeAll(sessions);
    const counts = new Map<string, number>();
    for (const match of matches) {
      if (match.status === "linked" && match.conversationId) {
        counts.set(match.conversationId, (counts.get(match.conversationId) ?? 0) + 1);
      }
    }
    const activeKeys = new Set<string>();
    for (const terminal of marked) {
      if (!this.#started || !this.#hasAuthoritativeItermSnapshot || this.iterm.getHealth().status !== "online"
        || inventoryOwnership(this.iterm.getSessions()) !== ownership) return;
      const current = this.iterm.getSessions().find((session) => session.sessionId === terminal.sessionId);
      if (!current || current.savedMarkerConversationId !== terminal.savedMarkerConversationId
        || current.savedMarkerOwnerSessionId !== terminal.savedMarkerOwnerSessionId
        || current.savedMarkerState !== terminal.savedMarkerState) continue;
      const conversationId = terminal.savedMarkerConversationId!;
      const match = matches[sessions.indexOf(terminal)];
      const forget = terminal.savedMarkerOwnerSessionId !== terminal.sessionId
        || !hasSavedHandoff(this.registry.getHandoff(conversationId))
        || (match?.status === "linked" && match.conversationId !== conversationId);
      const verified = !forget && match?.status === "linked" && match.conversationId === conversationId
        && counts.get(conversationId) === 1 && !terminal.buried;
      const configure = verified && terminal.savedMarkerState === "requested";
      const clear = forget || !verified;
      if ((!configure || !this.iterm.configureSavedMarker) && (!clear || !this.iterm.clearSavedMarker)) continue;
      const key = JSON.stringify([terminal.sessionId, terminal.jobPid, terminal.jobName, terminal.commandLine,
        terminal.cwd, terminal.tty, conversationId, terminal.savedMarkerOwnerSessionId,
        terminal.savedMarkerState, configure, forget]);
      activeKeys.add(key);
      const attempt = this.#savedMarkerAttempts.get(key) ?? { count: 0, succeeded: false };
      if (attempt.succeeded || attempt.count >= 2) continue;
      attempt.count += 1;
      this.#savedMarkerAttempts.set(key, attempt);
      try {
        if (configure) {
          const freshObserver = new LegacyCodexObserver({
            codexHome: this.legacyCodexObserver.codexHome,
            readCommand: this.legacyCodexObserver.readCommand,
            readSessionMeta: this.legacyCodexObserver.readSessionMeta,
            retryAfterMs: this.legacyCodexObserver.retryAfterMs,
            trustResumeCommand: false,
          });
          const fresh = await freshObserver.observeAll(sessions);
          const latest = this.iterm.getSessions().find((session) => session.sessionId === terminal.sessionId);
          if (!this.#started || !this.#hasAuthoritativeItermSnapshot || this.iterm.getHealth().status !== "online"
            || inventoryOwnership(this.iterm.getSessions()) !== ownership
            || latest?.savedMarkerConversationId !== conversationId
            || latest.savedMarkerOwnerSessionId !== terminal.savedMarkerOwnerSessionId
            || latest.savedMarkerState !== terminal.savedMarkerState) {
            attempt.count -= 1;
            return;
          }
          this.#savedMarkerObserver = freshObserver;
          const linked = fresh[sessions.indexOf(terminal)];
          const retained = hasSavedHandoff(this.registry.getHandoff(conversationId));
          if (!retained || linked?.status !== "linked" || linked.conversationId !== conversationId
            || fresh.filter((match) => match.status === "linked" && match.conversationId === conversationId).length !== 1) {
            await this.iterm.clearSavedMarker?.(terminal.sessionId, conversationId,
              !retained || (linked?.status === "linked" && linked.conversationId !== conversationId));
            // No profile application was attempted; a later proven identity may still apply it.
            attempt.count -= 1;
            continue;
          }
          await this.iterm.configureSavedMarker!(terminal, conversationId);
        } else await this.iterm.clearSavedMarker!(terminal.sessionId, conversationId, forget);
        attempt.succeeded = true;
      } catch { /* Keep failures bounded; the companion retains provenance for later recovery. */ }
    }
    for (const key of this.#savedMarkerAttempts.keys()) {
      if (!activeKeys.has(key)) this.#savedMarkerAttempts.delete(key);
    }
  }

  async #configureAutomaticRecovery(
    sessions: readonly ItermSessionSnapshot[],
    matches: readonly LegacyCodexMatch[],
  ): Promise<number> {
    if (
      !this.config.autoResumeEnabled ||
      this.#autoResumeDisarmed ||
      this.iterm.getHealth().status !== "online"
    ) {
      this.#autoResumeAttempts.clear();
      this.#autoResumeFailures.clear();
      this.#autoResumeClearAttempts.clear();
      this.#autoResumeClearFailures.clear();
      return 0;
    }

    const clearCandidates = sessions.flatMap((session, index) => {
      const conversationId = session.autoResumeConversationId;
      if (!conversationId) return [];
      const match = matches[index];
      const linkedToMarkedConversation =
        match?.status === "linked" &&
        match.conversationId === conversationId;
      if (linkedToMarkedConversation) return [];
      return [{ session, conversationId }];
    });
    const activeClearKeys = new Set(
      clearCandidates.map(
        ({ session, conversationId }) => `${session.sessionId}:${conversationId}`,
      ),
    );
    for (const key of this.#autoResumeClearAttempts.keys()) {
      if (!activeClearKeys.has(key)) this.#autoResumeClearAttempts.delete(key);
    }
    for (const key of this.#autoResumeClearFailures) {
      if (!activeClearKeys.has(key)) this.#autoResumeClearFailures.delete(key);
    }
    for (const { session, conversationId } of clearCandidates) {
      const key = `${session.sessionId}:${conversationId}`;
      const attempts = this.#autoResumeClearAttempts.get(key) ?? 0;
      if ((attempts > 0 && !this.#autoResumeClearFailures.has(key)) || attempts >= 2) continue;
      this.#autoResumeClearAttempts.set(key, attempts + 1);
      try {
        await this.iterm.clearAutoResume(session.sessionId, conversationId);
        this.#autoResumeClearFailures.delete(key);
      } catch {
        this.#autoResumeClearFailures.add(key);
      }
    }

    const candidates = sessions.flatMap((session, index) => {
      const match = matches[index];
      const conversationId =
        match?.status === "linked" && match.conversationId
          ? match.conversationId
          : undefined;
      if (
        session.buried ||
        !conversationId ||
        !session.cwd ||
        (match?.status !== "linked" &&
          !isCodexCommand(`${session.jobName ?? ""} ${session.commandLine ?? ""}`))
      ) {
        return [];
      }
      return [{ session, conversationId }];
    });
    const activeKeys = new Set(
      candidates.map(({ session, conversationId }) => `${session.sessionId}:${conversationId}`),
    );
    for (const key of this.#autoResumeAttempts.keys()) {
      if (!activeKeys.has(key)) this.#autoResumeAttempts.delete(key);
    }
    for (const key of this.#autoResumeFailures) {
      if (!activeKeys.has(key)) this.#autoResumeFailures.delete(key);
    }
    for (const key of this.#autoResumeMarkerRevalidations) {
      if (!activeKeys.has(key)) this.#autoResumeMarkerRevalidations.delete(key);
    }

    for (const { session, conversationId } of candidates) {
      const key = `${session.sessionId}:${conversationId}`;
      if (
        session.autoResumeConversationId === conversationId &&
        session.autoResumeKind === "helper" &&
        session.autoResumeControllerPort === this.config.port
      ) {
        this.#autoResumeMarkerRevalidations.delete(key);
        this.#autoResumeAttempts.delete(key);
        this.#autoResumeFailures.delete(key);
        continue;
      }
      if (session.autoResumeKind !== "marker") {
        this.#autoResumeMarkerRevalidations.delete(key);
      }
      if (
        session.autoResumeKind === "marker" &&
        !this.#autoResumeMarkerRevalidations.has(key) &&
        !this.#autoResumeFailures.has(key)
      ) {
        this.#autoResumeAttempts.delete(key);
        this.#autoResumeMarkerRevalidations.add(key);
      }
      const attempts = this.#autoResumeAttempts.get(key) ?? 0;
      if ((attempts > 0 && !this.#autoResumeFailures.has(key)) || attempts >= 2) continue;
      this.#autoResumeAttempts.set(key, attempts + 1);
      try {
        await this.iterm.configureAutoResume(session, conversationId, this.config.port);
        this.#autoResumeFailures.delete(key);
      } catch {
        this.#autoResumeFailures.add(key);
      }
    }
    const clearFailures = [...this.#autoResumeClearFailures].filter((key) =>
      activeClearKeys.has(key),
    ).length;
    const unarmedRunningSessions = sessions.filter((session, index) => {
      if (
        session.buried ||
        (matches[index]?.status !== "linked" &&
          !isCodexCommand(`${session.jobName ?? ""} ${session.commandLine ?? ""}`))
      ) {
        return false;
      }
      if (
        session.autoResumeConversationId &&
        session.autoResumeKind === "helper" &&
        session.autoResumeControllerPort === this.config.port
      ) {
        return false;
      }
      const match = matches[index];
      if (match?.status !== "linked" || !match.conversationId) return true;
      const key = `${session.sessionId}:${match.conversationId}`;
      return !this.#autoResumeAttempts.has(key) || this.#autoResumeFailures.has(key);
    }).length;
    return unarmedRunningSessions + clearFailures;
  }

  #scheduleItermIngest(): void {
    if (!this.#started || this.#itermIngestScheduled || !this.#pendingItermSnapshot) {
      return;
    }
    this.#itermIngestScheduled = true;
    void this.#enqueue(() => this.#drainPendingItermSnapshots())
      .catch(() => undefined)
      .finally(() => {
        this.#itermIngestScheduled = false;
        this.#scheduleItermIngest();
      });
  }

  async #drainPendingItermSnapshots(): Promise<void> {
    if (this.#pendingItermSnapshot) {
      const pending = this.#pendingItermSnapshot;
      this.#pendingItermSnapshot = undefined;
      await this.#ingestItermSessions(pending.sessions, pending.generation);
    }
  }

  async #enqueue(operation: () => Promise<void>): Promise<void> {
    const runIfStarted = (): Promise<void> => (this.#started ? operation() : Promise.resolve());
    const pending = this.#workQueue.then(runIfStarted, runIfStarted);
    this.#workQueue = pending.catch((error) => {
      this.registry.setControllerMessage(`Provider event failed: ${errorMessage(error)}`);
    });
    return pending;
  }

  async #callProvider<T>(operation: () => Promise<T>, fallbackMessage: string): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      const providerError = normalizeProviderError(error);
      if (providerError) {
        throw providerError;
      }
      throw new AppError(503, "PROVIDER_ERROR", fallbackMessage, { cause: error });
    }
  }
}

function normalizeProviderError(error: unknown): AppError | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const candidate = error as { code?: unknown; message?: unknown };
  if (typeof candidate.code !== "string" || typeof candidate.message !== "string") {
    return undefined;
  }
  const conflicts = new Set([
    "REQUEST_NOT_FOUND",
    "SESSION_NOT_MANAGED",
    "TURN_ID_UNKNOWN",
    "TURN_STATE_CONFLICT",
    "WINDOW_RESTORE_IN_PROGRESS",
    "WINDOW_RESTORE_PARTIAL",
  ]);
  const invalid = new Set(["INVALID_MESSAGE", "INVALID_REQUEST_RESPONSE"]);
  const unavailable = new Set(["CODEX_OFFLINE", "READ_ONLY_PROTOCOL_VERSION"]);
  if (candidate.code === "SESSION_NOT_FOUND") {
    return new AppError(404, candidate.code, candidate.message, { cause: error });
  }
  if (conflicts.has(candidate.code)) {
    return new AppError(409, candidate.code, candidate.message, { cause: error });
  }
  if (invalid.has(candidate.code)) {
    return new AppError(400, candidate.code, candidate.message, { cause: error });
  }
  if (unavailable.has(candidate.code)) {
    return new AppError(503, candidate.code, candidate.message, { cause: error });
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

const IDLE_SHELLS = new Set(["bash", "dash", "fish", "nu", "sh", "tcsh", "zsh"]);

function isIdleShell(jobName: string | undefined): boolean {
  return Boolean(jobName && IDLE_SHELLS.has(jobName.trim().toLowerCase()));
}
