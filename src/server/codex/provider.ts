import { basename } from "node:path";

import type {
  CreateThreadInput,
  PendingRequest,
  PendingRequestChoice,
  RespondRequestInput,
  SessionActivity,
  SessionAtlasHealth,
  SessionCapabilities,
  SessionExecution,
  SessionExecutionStep,
  SessionPlan,
  SessionSummary,
} from "../../shared/types.js";
import {
  CodexAppServerClient,
  CodexProtocolError,
  CodexRpcError,
  type CodexClientEvent,
  type CodexClientPort,
} from "./client.js";
import type {
  CodexThread,
  CodexThreadItem,
  CodexThreadStatus,
  CodexTurn,
  CommandApprovalDecision,
  CommandApprovalParams,
  FileChangeApprovalDecision,
  FileChangeApprovalParams,
  PermissionsApprovalParams,
  RpcId,
  RpcNotification,
  RpcServerRequest,
  ToolRequestUserInputParams,
  TurnPlanStep,
  UserInputQuestion,
} from "./protocol.js";
import { rpcKey } from "./protocol.js";

const SESSION_ID_PREFIX = "codex:";
const THREAD_PAGE_LIMIT = 200;
const MAX_PAGES = 20;
const MAX_ACTIVITIES = 20;
const MAX_EXECUTION_STEPS = 12;
const MAX_EXECUTION_SCAN_ITEMS = 50;
const DEFAULT_RESTART_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
const DEFAULT_RESTART_STABILITY_MS = 60_000;

export type CodexProviderEvent =
  | { type: "session-upsert"; session: SessionSummary }
  | { type: "session-remove"; sessionId: string }
  | { type: "health"; health: SessionAtlasHealth };

export type CodexProviderListener = (event: CodexProviderEvent) => void;

export interface CodexProviderOptions {
  client?: CodexClientPort;
  now?: () => Date;
  restartDelaysMs?: readonly number[];
  restartStabilityMs?: number;
}

interface ThreadRuntime {
  activeTurnId?: string;
  lastTurnStatus?: string;
  currentActivity?: string;
  attentionReason?: SessionSummary["attentionReason"];
  lastActivityAt?: string;
  plan?: SessionPlan;
  activities: SessionActivity[];
  title?: string;
}

interface BasePendingServerRequest {
  key: string;
  rpcId: RpcId;
  threadId: string;
  turnId: string;
  receivedAt: string;
  uiRequestId: string;
}

interface CommandPendingServerRequest extends BasePendingServerRequest {
  kind: "command-approval";
  params: CommandApprovalParams;
  decisions: CommandApprovalDecision[];
}

interface FilePendingServerRequest extends BasePendingServerRequest {
  kind: "file-approval";
  params: FileChangeApprovalParams;
  decisions: FileChangeApprovalDecision[];
}

interface PermissionPendingServerRequest extends BasePendingServerRequest {
  kind: "permission-approval";
  params: PermissionsApprovalParams;
}

interface QuestionPendingServerRequest extends BasePendingServerRequest {
  kind: "question";
  params: ToolRequestUserInputParams;
  questionIndex: number;
  answers: Record<string, { answers: string[] }>;
}

type PendingServerRequest =
  | CommandPendingServerRequest
  | FilePendingServerRequest
  | PermissionPendingServerRequest
  | QuestionPendingServerRequest;

export class CodexProviderError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CodexProviderError";
    this.code = code;
  }
}

export class CodexProvider {
  readonly #client: CodexClientPort;
  readonly #now: () => Date;
  readonly #restartDelaysMs: readonly number[];
  readonly #restartStabilityMs: number;
  readonly #listeners = new Set<CodexProviderListener>();
  readonly #threads = new Map<string, CodexThread>();
  readonly #summaries = new Map<string, SessionSummary>();
  readonly #loadedThreadIds = new Set<string>();
  readonly #ownedThreadIds = new Set<string>();
  readonly #runtime = new Map<string, ThreadRuntime>();
  readonly #pendingByKey = new Map<string, PendingServerRequest>();
  readonly #pendingOrderByThread = new Map<string, string[]>();
  readonly #pendingByUiId = new Map<string, PendingServerRequest>();
  #health: SessionAtlasHealth = {
    controller: "online",
    codex: "offline",
    iterm: "offline",
    message: "Codex App Server has not started.",
  };
  #unsubscribeClient: (() => void) | undefined;
  #nextActivityId = 1;
  #nextUiRequestId = 1;
  #restartTimer: NodeJS.Timeout | undefined;
  #restartStabilityTimer: NodeJS.Timeout | undefined;
  #restartAttempt = 0;
  #stopping = false;

  constructor(options: CodexProviderOptions = {}) {
    this.#client = options.client ?? new CodexAppServerClient();
    this.#now = options.now ?? (() => new Date());
    this.#restartDelaysMs =
      options.restartDelaysMs && options.restartDelaysMs.length > 0
        ? [...options.restartDelaysMs]
        : DEFAULT_RESTART_DELAYS_MS;
    this.#restartStabilityMs =
      options.restartStabilityMs ?? DEFAULT_RESTART_STABILITY_MS;
  }

  subscribe(listener: CodexProviderListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  getHealth(): SessionAtlasHealth {
    return { ...this.#health };
  }

  async start(): Promise<void> {
    this.#stopping = false;
    if (!this.#unsubscribeClient) {
      this.#unsubscribeClient = this.#client.subscribe((event) => this.#handleClientEvent(event));
    }
    try {
      await this.#client.start();
    } catch (error) {
      this.#setHealth({
        codex: "offline",
        message: safeErrorMessage(error, "Codex App Server could not start."),
      });
      return;
    }

    this.#syncHealthFromClient();
    try {
      await this.refresh();
    } catch (error) {
      this.#setHealth({
        codex: this.#client.writable ? "online" : "readonly",
        message: safeErrorMessage(error, "Codex inventory could not be refreshed."),
      });
    }
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#restartTimer = undefined;
    if (this.#restartStabilityTimer) clearTimeout(this.#restartStabilityTimer);
    this.#restartStabilityTimer = undefined;
    await this.#client.stop();
    this.#unsubscribeClient?.();
    this.#unsubscribeClient = undefined;
    this.#ownedThreadIds.clear();
    this.#loadedThreadIds.clear();
    this.#markAllOffline();
    this.#setHealth({ codex: "offline", message: "Codex App Server is stopped." });
  }

  async list(): Promise<SessionSummary[]> {
    return [...this.#summaries.values()].map(cloneSummary);
  }

  async refresh(): Promise<SessionSummary[]> {
    this.#ensureOnline();
    const [threads, loadedIds] = await Promise.all([this.#listAllThreads(), this.#listLoadedThreadIds()]);
    const nextIds = new Set(threads.map((thread) => thread.id));

    this.#loadedThreadIds.clear();
    for (const id of loadedIds) {
      this.#loadedThreadIds.add(id);
    }
    this.#ownedThreadIds.clear();
    for (const thread of threads) {
      if (loadedIds.has(thread.id)) {
        // thread/list is deliberately filtered to this App Server's inventory.
        this.#ownedThreadIds.add(thread.id);
      }
    }

    for (const existingId of [...this.#threads.keys()]) {
      if (!nextIds.has(existingId)) {
        this.#removeThread(existingId);
      }
    }

    for (const thread of threads) {
      this.#assertThread(thread);
      this.#threads.set(thread.id, thread);
      this.#seedRuntimeFromThread(thread);
      this.#emitThread(thread.id);
    }
    return this.list();
  }

  async read(threadOrSessionId: string, includeTurns = true): Promise<SessionSummary> {
    this.#ensureOnline();
    const threadId = decodeSessionId(threadOrSessionId);
    const response = await this.#client.threadRead(threadId, includeTurns);
    this.#assertThread(response.thread);
    this.#threads.set(threadId, response.thread);
    this.#seedRuntimeFromThread(response.thread);
    return this.#emitThread(threadId);
  }

  async readExecution(threadOrSessionId: string): Promise<SessionExecution> {
    this.#ensureOnline();
    const threadId = decodeSessionId(threadOrSessionId);
    if (this.#client.threadTurnsList) {
      try {
        const turns = await this.#client.threadTurnsList({
          threadId,
          limit: 1,
          sortDirection: "desc",
          itemsView: "notLoaded",
        });
        const latest = turns.data[0];
        if (!latest) return emptyExecution(this.#nowIso());
        if (this.#client.threadItemsList) {
          try {
            const items = await this.#client.threadItemsList({
              threadId,
              turnId: latest.id,
              limit: MAX_EXECUTION_SCAN_ITEMS,
              sortDirection: "desc",
            });
            return normalizeTurnExecution(
              { ...latest, items: items.data.map((entry) => entry.item).reverse() },
              this.#nowIso(),
              items.nextCursor !== null,
            );
          } catch (error) {
            if (!(error instanceof CodexRpcError) || error.code !== -32601) throw error;
          }
        }
        const full = await this.#client.threadTurnsList({
          threadId,
          limit: 1,
          sortDirection: "desc",
          itemsView: "full",
        });
        return full.data[0]
          ? normalizeTurnExecution(full.data[0], this.#nowIso())
          : emptyExecution(this.#nowIso());
      } catch (error) {
        if (
          error instanceof CodexRpcError &&
          error.code === -32600 &&
          error.message === `thread ${threadId} is not materialized yet; thread/turns/list is unavailable before first user message`
        ) {
          return emptyExecution(this.#nowIso());
        }
        if (!(error instanceof CodexRpcError) || error.code !== -32601) throw error;
      }
    }
    throw new CodexProviderError(
      "EXECUTION_DETAIL_UNAVAILABLE",
      "This Codex version cannot read a bounded execution record.",
    );
  }

  async createThread(input: CreateThreadInput): Promise<SessionSummary> {
    this.#ensureWritable();
    const response = await this.#client.threadStart({ cwd: input.cwd });
    this.#assertThread(response.thread);
    const thread = response.thread;
    this.#threads.set(thread.id, thread);
    this.#loadedThreadIds.add(thread.id);
    this.#ownedThreadIds.add(thread.id);
    const runtime = this.#getRuntime(thread.id);
    if (input.title?.trim()) {
      runtime.title = input.title.trim();
    }
    runtime.lastActivityAt = this.#nowIso();
    this.#pushActivity(thread.id, "已创建托管会话", "success");
    let summary = this.#emitThread(thread.id);

    if (input.prompt?.trim()) {
      await this.#startTurn(thread.id, input.prompt.trim());
      summary = this.#emitThread(thread.id);
    }
    return cloneSummary(summary);
  }

  async sendMessage(threadOrSessionId: string, text: string): Promise<void> {
    this.#ensureWritable();
    const threadId = decodeSessionId(threadOrSessionId);
    const thread = this.#requireManagedThread(threadId);
    const message = requireText(text);

    if (thread.status.type === "idle") {
      await this.#startTurn(threadId, message);
      return;
    }
    if (thread.status.type !== "active" || thread.status.activeFlags.length > 0) {
      throw new CodexProviderError(
        "TURN_STATE_CONFLICT",
        "This session cannot accept a message in its current state.",
      );
    }
    const turnId = this.#runtime.get(threadId)?.activeTurnId;
    if (!turnId) {
      throw new CodexProviderError(
        "TURN_ID_UNKNOWN",
        "The active turn id is unknown; refresh the session instead of guessing.",
      );
    }
    await this.#steerKnownTurn(threadId, turnId, message);
  }

  async steer(threadOrSessionId: string, expectedTurnId: string, text: string): Promise<void> {
    this.#ensureWritable();
    const threadId = decodeSessionId(threadOrSessionId);
    const thread = this.#requireManagedThread(threadId);
    const runtime = this.#getRuntime(threadId);
    if (
      thread.status.type !== "active" ||
      thread.status.activeFlags.length > 0 ||
      !runtime.activeTurnId ||
      runtime.activeTurnId !== expectedTurnId
    ) {
      throw new CodexProviderError(
        "TURN_STATE_CONFLICT",
        "The expected turn is no longer the active turn.",
      );
    }
    await this.#steerKnownTurn(threadId, expectedTurnId, requireText(text));
  }

  async #steerKnownTurn(threadId: string, expectedTurnId: string, text: string): Promise<void> {
    await this.#client.turnSteer(threadId, expectedTurnId, text);
    const runtime = this.#getRuntime(threadId);
    runtime.currentActivity = "已追加新的任务说明";
    runtime.lastActivityAt = this.#nowIso();
    this.#pushActivity(threadId, "已向当前任务追加消息");
    this.#emitThread(threadId);
  }

  async interrupt(threadOrSessionId: string): Promise<void> {
    this.#ensureWritable();
    const threadId = decodeSessionId(threadOrSessionId);
    const thread = this.#requireManagedThread(threadId);
    const turnId = this.#runtime.get(threadId)?.activeTurnId;
    if (thread.status.type !== "active" || !turnId) {
      throw new CodexProviderError("TURN_STATE_CONFLICT", "There is no known active turn to interrupt.");
    }
    await this.#client.turnInterrupt(threadId, turnId);
    this.#pushActivity(threadId, "已请求中断当前任务", "warning");
    this.#emitThread(threadId);
  }

  async respondRequest(
    threadOrSessionId: string,
    requestId: string,
    input: RespondRequestInput,
  ): Promise<void> {
    this.#ensureWritable();
    const threadId = decodeSessionId(threadOrSessionId);
    this.#requireManagedThread(threadId);
    const record = this.#pendingByUiId.get(requestId);
    if (!record || record.threadId !== threadId) {
      throw new CodexProviderError("REQUEST_NOT_FOUND", "The request is no longer pending.");
    }

    if (record.kind === "permission-approval") {
      if (input.choiceId !== "grantTurn" && input.choiceId !== "decline") {
        throw new CodexProviderError("INVALID_REQUEST_RESPONSE", "That approval choice is not available.");
      }
      this.#client.respondToServerRequest(
        record.rpcId,
        input.choiceId === "grantTurn"
          ? { permissions: requestedPermissionGrant(record.params), scope: "turn" }
          : { permissions: {}, scope: "turn" },
      );
      this.#removePendingRecord(record);
      this.#pushActivity(
        threadId,
        input.choiceId === "grantTurn" ? "已允许本次任务使用请求的权限" : "已拒绝权限请求",
        input.choiceId === "grantTurn" ? "success" : "warning",
      );
      this.#emitThread(threadId);
      return;
    }

    if (record.kind === "command-approval" || record.kind === "file-approval") {
      const availableDecisions: readonly string[] = record.decisions;
      if (!availableDecisions.includes(input.choiceId)) {
        throw new CodexProviderError("INVALID_REQUEST_RESPONSE", "That approval choice is not available.");
      }
      this.#client.respondToServerRequest(record.rpcId, { decision: input.choiceId });
      this.#removePendingRecord(record);
      this.#pushActivity(
        threadId,
        input.choiceId === "accept" || input.choiceId === "acceptForSession"
          ? "已允许请求"
          : "已拒绝请求",
        input.choiceId === "accept" || input.choiceId === "acceptForSession" ? "success" : "warning",
      );
      this.#emitThread(threadId);
      return;
    }

    const question = record.params.questions[record.questionIndex];
    if (!question) {
      this.#removePendingRecord(record);
      throw new CodexProviderError("REQUEST_NOT_FOUND", "The question is no longer pending.");
    }
    const answer = resolveQuestionAnswer(question, input);
    record.answers[question.id] = { answers: [answer] };
    this.#pendingByUiId.delete(record.uiRequestId);

    if (record.questionIndex + 1 < record.params.questions.length) {
      record.questionIndex += 1;
      record.uiRequestId = this.#newUiRequestId();
      this.#pendingByUiId.set(record.uiRequestId, record);
      this.#pushActivity(threadId, "已回答一个问题，等待下一项");
      this.#emitThread(threadId);
      return;
    }

    this.#client.respondToServerRequest(record.rpcId, { answers: record.answers });
    this.#removePendingRecord(record);
    this.#pushActivity(threadId, "已回答问题", "success");
    this.#emitThread(threadId);
  }

  #handleClientEvent(event: CodexClientEvent): void {
    if (event.type === "state") {
      if (event.state === "running") {
        this.#scheduleRestartAttemptReset();
        this.#syncHealthFromClient();
      } else if (event.state === "stopped") {
        if (this.#restartStabilityTimer) clearTimeout(this.#restartStabilityTimer);
        this.#restartStabilityTimer = undefined;
        this.#ownedThreadIds.clear();
        this.#loadedThreadIds.clear();
        this.#clearTransportPending();
        this.#markAllOffline();
        this.#setHealth({
          codex: "offline",
          message: event.error?.message ?? "Codex App Server is stopped.",
        });
        if (event.error && !this.#stopping) {
          this.#scheduleRestart();
        }
      }
      return;
    }
    if (event.type === "protocol-error") {
      this.#setHealth({
        codex: "readonly",
        message: "Codex protocol drift was detected; writes are disabled.",
      });
      this.#refreshCapabilities();
      return;
    }
    if (event.type === "server-request") {
      this.#handleServerRequest(event.request);
      return;
    }
    if (event.type === "notification") {
      this.#handleNotification(event.notification);
    }
  }

  #scheduleRestart(): void {
    if (this.#restartTimer || this.#stopping) return;
    const delay =
      this.#restartDelaysMs[
        Math.min(this.#restartAttempt, this.#restartDelaysMs.length - 1)
      ] ?? 30_000;
    this.#restartAttempt += 1;
    this.#setHealth({
      codex: "offline",
      message: `Codex App Server stopped unexpectedly; retrying in ${delay}ms.`,
    });
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = undefined;
      if (this.#stopping) return;
      void this.start();
    }, delay);
    this.#restartTimer.unref();
  }

  #scheduleRestartAttemptReset(): void {
    if (this.#restartStabilityTimer) clearTimeout(this.#restartStabilityTimer);
    this.#restartStabilityTimer = setTimeout(() => {
      this.#restartStabilityTimer = undefined;
      this.#restartAttempt = 0;
    }, this.#restartStabilityMs);
    this.#restartStabilityTimer.unref();
  }

  #handleServerRequest(request: RpcServerRequest): void {
    if (!this.#client.writable) {
      this.#client.declineServerRequest(
        request,
        "Session Atlas is in read-only mode because protocol compatibility is unverified.",
      );
      return;
    }

    const params = request.params;
    if (request.method === "item/commandExecution/requestApproval" && isCommandApprovalParams(params)) {
      const decisions = commandDecisions(params.availableDecisions);
      if (decisions.length === 0) {
        this.#client.declineServerRequest(request);
        return;
      }
      this.#queuePending({
        kind: "command-approval",
        key: rpcKey(request.id),
        rpcId: request.id,
        threadId: params.threadId,
        turnId: params.turnId,
        receivedAt: isoFromMilliseconds(params.startedAtMs, this.#now),
        uiRequestId: this.#newUiRequestId(),
        params,
        decisions,
      });
      return;
    }

    if (request.method === "item/fileChange/requestApproval" && isFileApprovalParams(params)) {
      this.#queuePending({
        kind: "file-approval",
        key: rpcKey(request.id),
        rpcId: request.id,
        threadId: params.threadId,
        turnId: params.turnId,
        receivedAt: isoFromMilliseconds(params.startedAtMs, this.#now),
        uiRequestId: this.#newUiRequestId(),
        params,
        decisions: ["accept", "decline", "cancel"],
      });
      return;
    }

    if (request.method === "item/permissions/requestApproval" && isPermissionsApprovalParams(params)) {
      this.#queuePending({
        kind: "permission-approval",
        key: rpcKey(request.id),
        rpcId: request.id,
        threadId: params.threadId,
        turnId: params.turnId,
        receivedAt: isoFromMilliseconds(params.startedAtMs, this.#now),
        uiRequestId: this.#newUiRequestId(),
        params,
      });
      return;
    }

    if (request.method === "item/tool/requestUserInput" && isToolRequestUserInputParams(params)) {
      if (params.questions.length === 0 || params.questions.some((question) => question.isSecret)) {
        this.#client.rejectServerRequest(
          request.id,
          -32002,
          "Session Atlas does not collect secret or empty user-input requests.",
        );
        return;
      }
      this.#queuePending({
        kind: "question",
        key: rpcKey(request.id),
        rpcId: request.id,
        threadId: params.threadId,
        turnId: params.turnId,
        receivedAt: this.#nowIso(),
        uiRequestId: this.#newUiRequestId(),
        params,
        questionIndex: 0,
        answers: {},
      });
      return;
    }

    this.#client.rejectServerRequest(request.id, -32601, "Session Atlas does not implement this request.");
  }

  #handleNotification(notification: RpcNotification): void {
    const params = notification.params;
    if (notification.method === "thread/started" && isRecord(params) && isCodexThread(params.thread)) {
      this.#threads.set(params.thread.id, params.thread);
      this.#seedRuntimeFromThread(params.thread);
      this.#emitThread(params.thread.id);
      return;
    }
    if (notification.method === "thread/status/changed" && isThreadStatusChanged(params)) {
      const thread = this.#threads.get(params.threadId);
      if (thread) {
        thread.status = params.status;
        this.#emitThread(thread.id);
      }
      return;
    }
    if (notification.method === "turn/started" && isTurnLifecycle(params)) {
      const thread = this.#threads.get(params.threadId);
      if (!thread) return;
      upsertTurn(thread, params.turn);
      thread.status = { type: "active", activeFlags: [] };
      const runtime = this.#getRuntime(thread.id);
      runtime.activeTurnId = params.turn.id;
      runtime.lastTurnStatus = params.turn.status;
      runtime.currentActivity = "正在处理任务";
      runtime.attentionReason = null;
      runtime.plan = undefined;
      runtime.lastActivityAt = timestampFromSeconds(params.turn.startedAt) ?? this.#nowIso();
      this.#pushActivity(thread.id, "任务已开始");
      this.#emitThread(thread.id);
      return;
    }
    if (notification.method === "turn/completed" && isTurnLifecycle(params)) {
      const thread = this.#threads.get(params.threadId);
      if (!thread) return;
      upsertTurn(thread, params.turn);
      thread.status = params.turn.status === "failed" ? { type: "systemError" } : { type: "idle" };
      const runtime = this.#getRuntime(thread.id);
      runtime.activeTurnId = undefined;
      runtime.lastTurnStatus = params.turn.status;
      runtime.currentActivity =
        params.turn.status === "failed"
          ? params.turn.error?.message ?? "任务失败"
          : params.turn.status === "interrupted"
            ? "任务已中断"
            : "任务已完成";
      runtime.attentionReason =
        params.turn.status === "failed"
          ? "failed"
          : params.turn.status === "completed"
            ? "newly_completed"
            : null;
      runtime.lastActivityAt = timestampFromSeconds(params.turn.completedAt) ?? this.#nowIso();
      this.#pushActivity(
        thread.id,
        runtime.currentActivity,
        params.turn.status === "failed"
          ? "danger"
          : params.turn.status === "completed"
            ? "success"
            : "warning",
      );
      this.#emitThread(thread.id);
      return;
    }
    if (notification.method === "turn/plan/updated" && isTurnPlanUpdated(params)) {
      const runtime = this.#getRuntime(params.threadId);
      runtime.plan = normalizePlan(params.turnId, params.plan);
      runtime.currentActivity = params.explanation?.trim() || "计划已更新";
      runtime.lastActivityAt = this.#nowIso();
      this.#pushActivity(params.threadId, "计划已更新");
      this.#emitThread(params.threadId);
      return;
    }
    if (notification.method === "turn/diff/updated" && hasThreadAndTurn(params)) {
      const runtime = this.#getRuntime(params.threadId);
      runtime.lastActivityAt = this.#nowIso();
      this.#pushActivity(params.threadId, "代码差异已更新");
      this.#emitThread(params.threadId);
      return;
    }
    if (notification.method === "item/started" && isItemLifecycle(params)) {
      const runtime = this.#getRuntime(params.threadId);
      runtime.activeTurnId = params.turnId;
      runtime.currentActivity = itemActivityLabel(params.item);
      runtime.lastActivityAt = isoFromMilliseconds(params.startedAtMs, this.#now);
      this.#pushActivity(params.threadId, runtime.currentActivity);
      this.#emitThread(params.threadId);
      return;
    }
    if (notification.method === "item/completed" && isItemLifecycle(params)) {
      const runtime = this.#getRuntime(params.threadId);
      runtime.lastActivityAt = isoFromMilliseconds(params.completedAtMs, this.#now);
      this.#pushActivity(params.threadId, `${itemActivityLabel(params.item)}完成`, "success");
      this.#emitThread(params.threadId);
      return;
    }
    if (notification.method === "item/agentMessage/delta" && hasThreadAndTurn(params)) {
      const runtime = this.#getRuntime(params.threadId);
      runtime.activeTurnId = params.turnId;
      runtime.currentActivity = "正在回复";
      runtime.lastActivityAt = this.#nowIso();
      this.#emitThread(params.threadId);
      return;
    }
    if (notification.method === "error" && isErrorNotification(params)) {
      const thread = this.#threads.get(params.threadId);
      if (!thread) return;
      const runtime = this.#getRuntime(thread.id);
      runtime.activeTurnId = params.turnId;
      runtime.currentActivity = params.willRetry ? "发生错误，正在重试" : params.error.message;
      runtime.attentionReason = params.willRetry ? null : "failed";
      runtime.lastActivityAt = this.#nowIso();
      if (!params.willRetry) thread.status = { type: "systemError" };
      this.#pushActivity(
        thread.id,
        runtime.currentActivity,
        params.willRetry ? "warning" : "danger",
      );
      this.#emitThread(thread.id);
      return;
    }
    if (notification.method === "serverRequest/resolved" && isServerRequestResolved(params)) {
      const record = this.#pendingByKey.get(rpcKey(params.requestId));
      if (record) {
        this.#removePendingRecord(record);
        this.#emitThread(record.threadId);
      }
      return;
    }
    if (notification.method === "thread/name/updated" && isRecord(params) && typeof params.threadId === "string") {
      const runtime = this.#getRuntime(params.threadId);
      runtime.title = typeof params.threadName === "string" ? params.threadName : undefined;
      this.#emitThread(params.threadId);
      return;
    }
    if (
      (notification.method === "thread/deleted" || notification.method === "thread/archived") &&
      isRecord(params) &&
      typeof params.threadId === "string"
    ) {
      this.#removeThread(params.threadId);
      return;
    }
    if (notification.method === "thread/closed" && isRecord(params) && typeof params.threadId === "string") {
      const thread = this.#threads.get(params.threadId);
      if (thread) {
        this.#loadedThreadIds.delete(thread.id);
        this.#ownedThreadIds.delete(thread.id);
        thread.status = { type: "notLoaded" };
        this.#declinePendingForThread(thread.id, "The Codex thread was closed.");
        this.#emitThread(thread.id);
      }
    }
  }

  async #startTurn(threadId: string, text: string): Promise<void> {
    const response = await this.#client.turnStart(threadId, text);
    const thread = this.#threads.get(threadId);
    if (!thread) {
      throw new CodexProviderError("SESSION_NOT_FOUND", "The managed Codex session disappeared.");
    }
    thread.status = { type: "active", activeFlags: [] };
    upsertTurn(thread, response.turn);
    const runtime = this.#getRuntime(threadId);
    runtime.activeTurnId = response.turn.id;
    runtime.lastTurnStatus = response.turn.status;
    runtime.currentActivity = "正在处理任务";
    runtime.attentionReason = null;
    runtime.plan = undefined;
    runtime.lastActivityAt = this.#nowIso();
    this.#pushActivity(threadId, "已发送新任务");
    this.#emitThread(threadId);
  }

  #queuePending(record: PendingServerRequest): void {
    const thread = this.#threads.get(record.threadId);
    if (
      !thread ||
      !this.#ownedThreadIds.has(record.threadId) ||
      !this.#loadedThreadIds.has(record.threadId) ||
      thread.canAcceptDirectInput === false
    ) {
      this.#client.declineServerRequest(
        { id: record.rpcId, method: pendingMethod(record), params: record.params },
        "Session Atlas does not own the thread that issued this request.",
      );
      return;
    }
    if (this.#pendingByKey.has(record.key)) {
      this.#client.rejectServerRequest(record.rpcId, -32600, "Duplicate server request id.");
      return;
    }
    this.#pendingByKey.set(record.key, record);
    this.#pendingByUiId.set(record.uiRequestId, record);
    const order = this.#pendingOrderByThread.get(record.threadId) ?? [];
    order.push(record.key);
    this.#pendingOrderByThread.set(record.threadId, order);
    const runtime = this.#getRuntime(record.threadId);
    runtime.currentActivity = record.kind === "question" ? "等待你的回答" : "等待你的批准";
    runtime.attentionReason = record.kind === "question" ? "needs_input" : "needs_approval";
    runtime.lastActivityAt = record.receivedAt;
    this.#pushActivity(record.threadId, runtime.currentActivity, "warning", record.receivedAt);
    this.#emitThread(record.threadId);
  }

  #removePendingRecord(record: PendingServerRequest): void {
    this.#pendingByKey.delete(record.key);
    this.#pendingByUiId.delete(record.uiRequestId);
    const order = this.#pendingOrderByThread.get(record.threadId);
    if (order) {
      const next = order.filter((key) => key !== record.key);
      if (next.length > 0) this.#pendingOrderByThread.set(record.threadId, next);
      else this.#pendingOrderByThread.delete(record.threadId);
    }
    const runtime = this.#getRuntime(record.threadId);
    const visible = this.#visiblePending(record.threadId);
    if (!visible) {
      runtime.attentionReason = null;
      const thread = this.#threads.get(record.threadId);
      runtime.currentActivity = thread?.status.type === "active" ? "正在处理任务" : runtime.currentActivity;
    }
  }

  #clearTransportPending(): void {
    const threadIds = new Set(
      [...this.#pendingByKey.values()].map((record) => record.threadId),
    );
    this.#pendingByKey.clear();
    this.#pendingByUiId.clear();
    this.#pendingOrderByThread.clear();
    for (const threadId of threadIds) {
      const runtime = this.#runtime.get(threadId);
      if (!runtime) continue;
      if (runtime.attentionReason === "needs_approval" || runtime.attentionReason === "needs_input") {
        runtime.attentionReason = null;
      }
      if (runtime.currentActivity === "等待你的批准" || runtime.currentActivity === "等待你的回答") {
        runtime.currentActivity = undefined;
      }
    }
  }

  #visiblePending(threadId: string): PendingServerRequest | undefined {
    const order = this.#pendingOrderByThread.get(threadId);
    if (!order) return undefined;
    for (const key of order) {
      const record = this.#pendingByKey.get(key);
      if (record) return record;
    }
    return undefined;
  }

  #emitThread(threadId: string): SessionSummary {
    const thread = this.#threads.get(threadId);
    if (!thread) {
      throw new CodexProviderError("SESSION_NOT_FOUND", `Codex thread ${threadId} was not found.`);
    }
    const summary = this.#normalizeThread(thread);
    this.#summaries.set(threadId, summary);
    this.#emit({ type: "session-upsert", session: cloneSummary(summary) });
    return summary;
  }

  #normalizeThread(thread: CodexThread): SessionSummary {
    const runtime = this.#getRuntime(thread.id);
    const pendingRecord = this.#visiblePending(thread.id);
    const pendingRequest = pendingRecord ? this.#normalizePending(pendingRecord) : undefined;
    const source = threadSourceName(thread);
    const managed = source === "appServer" || this.#ownedThreadIds.has(thread.id);
    const loaded =
      this.#ownedThreadIds.has(thread.id) &&
      this.#loadedThreadIds.has(thread.id) &&
      thread.canAcceptDirectInput !== false;
    const state = normalizeActivityState(thread.status, pendingRequest);
    const writable = this.#client.writable && managed && loaded;
    const capabilities: SessionCapabilities = {
      open: managed,
      focus: false,
      send: writable && state === "idle",
      steer: writable && state === "running" && Boolean(runtime.activeTurnId),
      interrupt:
        writable &&
        (state === "running" || state === "awaiting_approval" || state === "awaiting_input") &&
        Boolean(runtime.activeTurnId),
      approve: writable && pendingRequest?.kind === "approval",
      answer: writable && pendingRequest?.kind === "question",
    };
    const updatedAt = timestampFromSeconds(thread.recencyAt ?? thread.updatedAt) ?? this.#nowIso();
    const cwd = thread.cwd || "";

    return {
      id: encodeSessionId(thread.id),
      provider: "codex",
      conversationId: thread.id,
      runtimeId: runtime.activeTurnId,
      surface: managed ? "managed" : "legacy",
      title: runtime.title || thread.name || thread.preview || basename(cwd) || "Codex session",
      cwd,
      projectKey: cwd,
      projectName: basename(cwd) || cwd || "Unknown project",
      ...(thread.gitInfo?.branch ? { branch: thread.gitInfo.branch } : {}),
      activityState: state,
      attentionReason: pendingRequest
        ? pendingRequest.kind === "approval"
          ? "needs_approval"
          : "needs_input"
        : runtime.attentionReason ?? (state === "failed" ? "failed" : null),
      rawState: thread.status.type,
      ...(runtime.currentActivity ? { currentActivity: runtime.currentActivity } : {}),
      ...(runtime.lastTurnStatus ? { lastTurnStatus: runtime.lastTurnStatus } : {}),
      lastActivityAt: runtime.lastActivityAt ?? updatedAt,
      observedAt: this.#nowIso(),
      stale: thread.status.type === "notLoaded" || this.#client.state !== "running",
      ...(runtime.plan ? { plan: clonePlan(runtime.plan) } : {}),
      activities: runtime.activities.map((activity) => ({ ...activity })),
      ...(pendingRequest ? { pendingRequest } : {}),
      capabilities,
      pinned: false,
      parked: false,
    };
  }

  #normalizePending(record: PendingServerRequest): PendingRequest {
    if (record.kind === "command-approval") {
      return {
        requestId: record.uiRequestId,
        threadId: encodeSessionId(record.threadId),
        turnId: record.turnId,
        kind: "approval",
        title: "命令执行需要确认",
        ...(record.params.reason ? { detail: record.params.reason } : {}),
        ...(record.params.command ? { command: record.params.command } : {}),
        ...(record.params.cwd ? { cwd: record.params.cwd } : {}),
        choices: approvalChoices(record.decisions),
        receivedAt: record.receivedAt,
      };
    }
    if (record.kind === "file-approval") {
      return {
        requestId: record.uiRequestId,
        threadId: encodeSessionId(record.threadId),
        turnId: record.turnId,
        kind: "approval",
        title: "文件修改需要确认",
        ...(record.params.reason || record.params.grantRoot
          ? { detail: record.params.reason ?? `请求写入 ${record.params.grantRoot}` }
          : {}),
        choices: approvalChoices(record.decisions),
        receivedAt: record.receivedAt,
      };
    }
    if (record.kind === "permission-approval") {
      return {
        requestId: record.uiRequestId,
        threadId: encodeSessionId(record.threadId),
        turnId: record.turnId,
        kind: "approval",
        title: "运行权限需要确认",
        detail: permissionRequestDetail(record.params),
        cwd: record.params.cwd,
        choices: [
          { id: "grantTurn", label: "允许本次任务" },
          { id: "decline", label: "拒绝" },
        ],
        receivedAt: record.receivedAt,
      };
    }

    const question = record.params.questions[record.questionIndex];
    if (!question) {
      throw new CodexProtocolError("A pending user-input request has no current question.");
    }
    return {
      requestId: record.uiRequestId,
      threadId: encodeSessionId(record.threadId),
      turnId: record.turnId,
      kind: "question",
      title: question.header || "需要你的回答",
      detail: question.question,
      choices: questionChoices(question),
      receivedAt: record.receivedAt,
    };
  }

  #removeThread(threadId: string): void {
    const summary = this.#summaries.get(threadId);
    this.#declinePendingForThread(threadId, "The Codex thread was removed.");
    this.#threads.delete(threadId);
    this.#summaries.delete(threadId);
    this.#loadedThreadIds.delete(threadId);
    this.#ownedThreadIds.delete(threadId);
    this.#runtime.delete(threadId);
    if (summary) this.#emit({ type: "session-remove", sessionId: summary.id });
  }

  #declinePendingForThread(threadId: string, message: string): void {
    const pendingKeys = this.#pendingOrderByThread.get(threadId) ?? [];
    for (const key of pendingKeys) {
      const record = this.#pendingByKey.get(key);
      if (record) {
        this.#client.declineServerRequest(
          { id: record.rpcId, method: pendingMethod(record), params: record.params },
          message,
        );
        this.#pendingByKey.delete(key);
        this.#pendingByUiId.delete(record.uiRequestId);
      }
    }
    this.#pendingOrderByThread.delete(threadId);
    if (pendingKeys.length > 0) {
      const runtime = this.#runtime.get(threadId);
      if (runtime) {
        runtime.attentionReason = null;
        runtime.currentActivity = "会话已关闭";
      }
    }
  }

  #requireManagedThread(threadId: string): CodexThread {
    const thread = this.#threads.get(threadId);
    if (!thread) {
      throw new CodexProviderError("SESSION_NOT_FOUND", "The Codex session was not found.");
    }
    if (
      !this.#ownedThreadIds.has(threadId) ||
      !this.#loadedThreadIds.has(threadId) ||
      thread.canAcceptDirectInput === false
    ) {
      throw new CodexProviderError(
        "SESSION_NOT_MANAGED",
        "This Codex session is read-only because it is not managed by this App Server.",
      );
    }
    return thread;
  }

  #seedRuntimeFromThread(thread: CodexThread): void {
    const runtime = this.#getRuntime(thread.id);
    const latest = [...thread.turns].sort(
      (left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0),
    )[0];
    if (!latest) return;
    runtime.lastTurnStatus ??= latest.status;
    if (latest.status === "inProgress") runtime.activeTurnId ??= latest.id;
    runtime.lastActivityAt ??=
      timestampFromSeconds(latest.completedAt ?? latest.startedAt) ??
      timestampFromSeconds(thread.recencyAt ?? thread.updatedAt);
  }

  #getRuntime(threadId: string): ThreadRuntime {
    let runtime = this.#runtime.get(threadId);
    if (!runtime) {
      runtime = { activities: [] };
      this.#runtime.set(threadId, runtime);
    }
    return runtime;
  }

  #pushActivity(
    threadId: string,
    label: string,
    tone: SessionActivity["tone"] = "default",
    at = this.#nowIso(),
  ): void {
    const runtime = this.#getRuntime(threadId);
    runtime.activities.unshift({
      id: `codex-activity-${this.#nextActivityId++}`,
      at,
      label,
      tone,
    });
    runtime.activities.splice(MAX_ACTIVITIES);
  }

  #newUiRequestId(): string {
    return `codex-request-${this.#nextUiRequestId++}`;
  }

  #markAllOffline(): void {
    for (const [threadId, previous] of this.#summaries) {
      const thread = this.#threads.get(threadId);
      const summary = thread ? this.#normalizeThread(thread) : previous;
      const offline: SessionSummary = {
        ...summary,
        activityState: "offline",
        stale: true,
        observedAt: this.#nowIso(),
        capabilities: disableCapabilities(summary.capabilities),
      };
      this.#summaries.set(threadId, offline);
      this.#emit({ type: "session-upsert", session: cloneSummary(offline) });
    }
  }

  #refreshCapabilities(): void {
    for (const threadId of this.#threads.keys()) {
      this.#emitThread(threadId);
    }
  }

  #syncHealthFromClient(): void {
    if (this.#client.state !== "running") {
      this.#setHealth({ codex: "offline", message: "Codex App Server is stopped." });
      return;
    }
    if (this.#client.writable) {
      this.#setHealth({ codex: "online", message: undefined });
    } else {
      this.#setHealth({
        codex: "readonly",
        message: this.#client.compatibilityReason ?? "Codex protocol compatibility has not been verified; writes are disabled.",
      });
    }
  }

  #setHealth(update: Pick<SessionAtlasHealth, "codex"> & { message?: string }): void {
    this.#health = {
      ...this.#health,
      codex: update.codex,
      ...(this.#client.version ? { codexVersion: this.#client.version } : {}),
      ...(update.message ? { message: update.message } : { message: undefined }),
    };
    this.#emit({ type: "health", health: { ...this.#health } });
  }

  #ensureOnline(): void {
    if (this.#client.state !== "running") {
      throw new CodexProviderError("CODEX_OFFLINE", "Codex App Server is offline.");
    }
  }

  #ensureWritable(): void {
    this.#ensureOnline();
    if (!this.#client.writable) {
      throw new CodexProviderError(
        "READ_ONLY_PROTOCOL_VERSION",
        this.#client.compatibilityReason ?? "Codex writes are disabled because protocol compatibility has not been verified.",
      );
    }
  }

  #nowIso(): string {
    return this.#now().toISOString();
  }

  async #listAllThreads(): Promise<CodexThread[]> {
    const threads: CodexThread[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await this.#client.threadList({
        cursor,
        limit: THREAD_PAGE_LIMIT,
        sortKey: "recency_at",
        sortDirection: "desc",
        sourceKinds: ["appServer"],
        archived: false,
        useStateDbOnly: true,
      });
      if (!Array.isArray(response.data)) {
        throw new CodexProtocolError("thread/list returned invalid data.");
      }
      threads.push(...response.data);
      if (!response.nextCursor) return threads;
      if (seenCursors.has(response.nextCursor)) {
        throw new CodexProtocolError("thread/list returned a repeated cursor.");
      }
      seenCursors.add(response.nextCursor);
      cursor = response.nextCursor;
    }
    throw new CodexProtocolError(`thread/list exceeded ${MAX_PAGES} pages.`);
  }

  async #listLoadedThreadIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await this.#client.threadLoadedList({ cursor, limit: THREAD_PAGE_LIMIT });
      if (!Array.isArray(response.data) || response.data.some((id) => typeof id !== "string")) {
        throw new CodexProtocolError("thread/loaded/list returned invalid data.");
      }
      for (const id of response.data) ids.add(id);
      if (!response.nextCursor) return ids;
      if (seenCursors.has(response.nextCursor)) {
        throw new CodexProtocolError("thread/loaded/list returned a repeated cursor.");
      }
      seenCursors.add(response.nextCursor);
      cursor = response.nextCursor;
    }
    throw new CodexProtocolError(`thread/loaded/list exceeded ${MAX_PAGES} pages.`);
  }

  #assertThread(thread: CodexThread): void {
    if (
      !isRecord(thread) ||
      typeof thread.id !== "string" ||
      typeof thread.cwd !== "string" ||
      !isThreadStatus(thread.status)
    ) {
      throw new CodexProtocolError("Codex App Server returned an invalid thread.");
    }
  }

  #emit(event: CodexProviderEvent): void {
    for (const listener of [...this.#listeners]) listener(event);
  }
}

export function encodeSessionId(threadId: string): string {
  return `${SESSION_ID_PREFIX}${threadId}`;
}

export function decodeSessionId(sessionId: string): string {
  return sessionId.startsWith(SESSION_ID_PREFIX) ? sessionId.slice(SESSION_ID_PREFIX.length) : sessionId;
}

function normalizeActivityState(
  status: CodexThreadStatus,
  pendingRequest?: PendingRequest,
): SessionSummary["activityState"] {
  if (pendingRequest?.kind === "approval") return "awaiting_approval";
  if (pendingRequest?.kind === "question") return "awaiting_input";
  if (status.type === "idle") return "idle";
  if (status.type === "systemError") return "failed";
  if (status.type === "notLoaded") return "unknown";
  if (status.activeFlags.includes("waitingOnApproval")) return "awaiting_approval";
  if (status.activeFlags.includes("waitingOnUserInput")) return "awaiting_input";
  return "running";
}

function normalizePlan(turnId: string, steps: TurnPlanStep[]): SessionPlan {
  const normalized = steps.map((step, index) => ({
    id: `${turnId}:plan:${index}`,
    label: step.step,
    status:
      step.status === "inProgress"
        ? ("in_progress" as const)
        : step.status === "completed"
          ? ("completed" as const)
          : ("pending" as const),
  }));
  return {
    steps: normalized,
    done: normalized.filter((step) => step.status === "completed").length,
    total: normalized.length,
  };
}

export function normalizeThreadExecution(
  thread: CodexThread,
  fallbackObservedAt: string,
): SessionExecution {
  const latest = [...thread.turns].sort(
    (left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0),
  )[0];
  if (!latest) {
    return emptyExecution(
      timestampFromSeconds(thread.recencyAt ?? thread.updatedAt) ?? fallbackObservedAt,
    );
  }

  return normalizeTurnExecution(
    latest,
    timestampFromSeconds(thread.recencyAt ?? thread.updatedAt) ?? fallbackObservedAt,
  );
}

function normalizeTurnExecution(
  latest: CodexTurn,
  fallbackObservedAt: string,
  sourceTruncated = false,
): SessionExecution {

  const steps: SessionExecutionStep[] = [];
  let userMessageCount = 0;
  for (const [index, item] of latest.items.entries()) {
    const normalized = normalizeExecutionItem(item, latest.id, index, userMessageCount);
    if (!normalized) continue;
    if (item.type === "userMessage") userMessageCount += 1;
    const previous = steps.at(-1);
    if (previous && previous.label === normalized.label && previous.status === normalized.status) {
      previous.count = (previous.count ?? 1) + (normalized.count ?? 1);
      continue;
    }
    steps.push(normalized);
  }

  const turnStatus = normalizeExecutionTurnStatus(latest.status);
  const hasInProgress = steps.some((step) => step.status === "in_progress");
  if (turnStatus === "in_progress" && !hasInProgress) {
    steps.push({
      id: `${latest.id}:current`,
      label: "正在处理下一步",
      status: "in_progress",
    });
  } else if (turnStatus === "completed") {
    steps.push({
      id: `${latest.id}:completed`,
      label: "本轮任务完成",
      status: "completed",
    });
  } else if (turnStatus === "interrupted") {
    steps.push({
      id: `${latest.id}:interrupted`,
      label: "本轮任务已中断",
      status: "failed",
    });
  } else if (turnStatus === "failed") {
    steps.push({
      id: `${latest.id}:failed`,
      label: "本轮执行失败",
      status: "failed",
    });
  }

  const truncated = sourceTruncated || steps.length > MAX_EXECUTION_STEPS;
  const visibleSteps = truncated
    ? summarizeEarlierExecutionSteps(steps, sourceTruncated)
    : steps;
  return {
    turnId: latest.id,
    turnStatus,
    observedAt:
      timestampFromSeconds(latest.completedAt ?? latest.startedAt) ?? fallbackObservedAt,
    steps: visibleSteps,
    truncated,
  };
}

function emptyExecution(observedAt: string): SessionExecution {
  return {
    turnId: "",
    turnStatus: "completed",
    observedAt,
    steps: [],
    truncated: false,
  };
}

function normalizeExecutionItem(
  item: CodexThreadItem,
  turnId: string,
  index: number,
  userMessageCount: number,
): SessionExecutionStep | undefined {
  const status = normalizeExecutionItemStatus(item.status);
  const id = item.id || `${turnId}:item:${index}`;
  switch (item.type) {
    case "userMessage":
      return {
        id,
        label: userMessageCount === 0 ? "收到本轮任务" : "收到补充要求",
        status: "completed",
      };
    case "commandExecution":
      return { id, label: "执行命令", status };
    case "fileChange": {
      const changeCount = Array.isArray(item.changes) ? item.changes.length : 0;
      return {
        id,
        label: changeCount > 0 ? `修改文件（${changeCount} 项）` : "修改文件",
        status,
      };
    }
    case "mcpToolCall":
    case "dynamicToolCall":
      return { id, label: "调用工具", status };
    case "collabToolCall":
    case "collabAgentToolCall":
    case "subAgentActivity":
      return { id, label: "协作代理处理任务", status };
    case "webSearch":
      return { id, label: "搜索网络资料", status };
    case "imageView":
      return { id, label: "查看图片", status };
    case "imageGeneration":
      return { id, label: "生成图片", status };
    case "contextCompaction":
      return { id, label: "整理会话上下文", status };
    case "sleep":
      return { id, label: "等待后继续", status };
    case "plan":
      return { id, label: "生成计划", status };
    case "enteredReviewMode":
      return { id, label: "开始代码审查", status };
    case "exitedReviewMode":
      return { id, label: "完成代码审查", status };
    default:
      return undefined;
  }
}

function normalizeExecutionItemStatus(status: unknown): SessionExecutionStep["status"] {
  if (status === "inProgress" || status === "running") return "in_progress";
  if (status === "failed" || status === "declined" || status === "error") return "failed";
  return "completed";
}

function normalizeExecutionTurnStatus(
  status: CodexTurn["status"],
): SessionExecution["turnStatus"] {
  return status === "inProgress" ? "in_progress" : status;
}

function summarizeEarlierExecutionSteps(
  steps: SessionExecutionStep[],
  sourceTruncated = false,
): SessionExecutionStep[] {
  const recent = steps.slice(-(MAX_EXECUTION_STEPS - 1));
  const earlier = steps.slice(0, steps.length - recent.length);
  const count = earlier.reduce((total, step) => total + (step.count ?? 1), 0);
  return [
    {
      id: `${steps[0]?.id ?? "execution"}:earlier`,
      label: "较早执行记录",
      status: earlier.some((step) => step.status === "failed") ? "failed" : "completed",
      ...(!sourceTruncated && count > 0 ? { count } : {}),
    },
    ...recent,
  ];
}

function commandDecisions(
  available: CommandApprovalParams["availableDecisions"],
): CommandApprovalDecision[] {
  if (!available) return ["accept", "decline"];
  return available.filter(
    (decision): decision is CommandApprovalDecision =>
      decision === "accept" ||
      decision === "acceptForSession" ||
      decision === "decline" ||
      decision === "cancel",
  );
}

function approvalChoices(
  decisions: Array<CommandApprovalDecision | FileChangeApprovalDecision>,
): PendingRequestChoice[] {
  const labels: Record<CommandApprovalDecision, string> = {
    accept: "允许一次",
    acceptForSession: "本次会话允许",
    decline: "拒绝",
    cancel: "取消任务",
  };
  return decisions.map((decision) => ({ id: decision, label: labels[decision] }));
}

function questionChoices(question: UserInputQuestion): PendingRequestChoice[] {
  const choices = (question.options ?? []).map((option, index) => ({
    id: `option:${index}`,
    label: option.label,
    ...(option.description ? { description: option.description } : {}),
  }));
  if (question.isOther) choices.push({ id: "other", label: "其他" });
  if (choices.length === 0) choices.push({ id: "text", label: "填写回答" });
  return choices;
}

function resolveQuestionAnswer(question: UserInputQuestion, input: RespondRequestInput): string {
  if (input.choiceId.startsWith("option:")) {
    const index = Number(input.choiceId.slice("option:".length));
    const option = Number.isInteger(index) ? question.options?.[index] : undefined;
    if (!option) {
      throw new CodexProviderError("INVALID_REQUEST_RESPONSE", "That answer choice is not available.");
    }
    return option.label;
  }
  if (input.choiceId === "other" && question.isOther) {
    return requireText(input.text ?? "");
  }
  if (input.choiceId === "text" && (!question.options || question.options.length === 0)) {
    return requireText(input.text ?? "");
  }
  throw new CodexProviderError("INVALID_REQUEST_RESPONSE", "That answer choice is not available.");
}

function requestedPermissionGrant(params: PermissionsApprovalParams): Record<string, unknown> {
  return {
    ...(params.permissions.network !== null
      ? { network: structuredClone(params.permissions.network) }
      : {}),
    ...(params.permissions.fileSystem !== null
      ? { fileSystem: structuredClone(params.permissions.fileSystem) }
      : {}),
  };
}

function permissionRequestDetail(params: PermissionsApprovalParams): string {
  const details: string[] = [];
  if (params.reason?.trim()) details.push(params.reason.trim());
  if (params.permissions.network !== null) {
    details.push(
      params.permissions.network.enabled === false
        ? "网络：保持禁用"
        : params.permissions.network.enabled === true
          ? "网络：请求启用"
          : "网络：使用请求的运行时设置",
    );
  }
  const fileSystem = params.permissions.fileSystem;
  if (fileSystem !== null) {
    const reads = new Set(fileSystem.read ?? []);
    const writes = new Set(fileSystem.write ?? []);
    const denies = new Set<string>();
    const entries = fileSystem.entries ?? [];
    for (const entry of entries) {
      const label = permissionPathLabel(entry.path);
      if (entry.access === "read") reads.add(label);
      if (entry.access === "write") writes.add(label);
      if (entry.access === "deny") denies.add(label);
    }
    if (reads.size) details.push(`文件读取：${summarizeList([...reads])}`);
    if (writes.size) details.push(`文件写入：${summarizeList([...writes])}`);
    if (denies.size) details.push(`继续禁止：${summarizeList([...denies])}`);
  }
  return details.length > 0 ? details.join("；") : "请求的权限范围为空";
}

function permissionPathLabel(
  path:
    | { type: "path"; path: string }
    | { type: "glob_pattern"; pattern: string }
    | { type: "special"; value: string },
): string {
  if (path.type === "path") return path.path;
  if (path.type === "glob_pattern") return path.pattern;
  return path.value;
}

function summarizeList(values: string[]): string {
  const visible = values.slice(0, 8);
  return values.length > visible.length
    ? `${visible.join(", ")}（另有 ${values.length - visible.length} 项）`
    : visible.join(", ");
}

function threadSourceName(thread: CodexThread): string {
  return typeof thread.source === "string" ? thread.source : "unknown";
}

function itemActivityLabel(item: CodexThreadItem): string {
  switch (item.type) {
    case "agentMessage":
      return "正在回复";
    case "reasoning":
      return "正在思考";
    case "commandExecution":
      return "正在执行命令";
    case "fileChange":
      return "正在修改文件";
    case "mcpToolCall":
      return item.server && item.tool
        ? `正在调用 ${item.server}/${item.tool}`
        : "正在调用外部工具";
    case "webSearch":
      return "正在搜索网络";
    case "plan":
      return "正在更新计划";
    default:
      return "正在处理任务";
  }
}

function upsertTurn(thread: CodexThread, turn: CodexTurn): void {
  const index = thread.turns.findIndex((candidate) => candidate.id === turn.id);
  if (index >= 0) thread.turns[index] = turn;
  else thread.turns.push(turn);
}

function timestampFromSeconds(value: number | null | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return new Date(value * 1_000).toISOString();
}

function isoFromMilliseconds(value: unknown, now: () => Date): string {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value).toISOString()
    : now().toISOString();
}

function cloneSummary(summary: SessionSummary): SessionSummary {
  return {
    ...summary,
    activities: summary.activities.map((activity) => ({ ...activity })),
    ...(summary.plan ? { plan: clonePlan(summary.plan) } : {}),
    ...(summary.pendingRequest
      ? {
          pendingRequest: {
            ...summary.pendingRequest,
            choices: summary.pendingRequest.choices.map((choice) => ({ ...choice })),
          },
        }
      : {}),
    capabilities: { ...summary.capabilities },
  };
}

function clonePlan(plan: SessionPlan): SessionPlan {
  return { ...plan, steps: plan.steps.map((step) => ({ ...step })) };
}

function disableCapabilities(capabilities: SessionCapabilities): SessionCapabilities {
  return {
    ...capabilities,
    send: false,
    steer: false,
    interrupt: false,
    approve: false,
    answer: false,
  };
}

function pendingMethod(record: PendingServerRequest): string {
  if (record.kind === "command-approval") return "item/commandExecution/requestApproval";
  if (record.kind === "file-approval") return "item/fileChange/requestApproval";
  if (record.kind === "permission-approval") return "item/permissions/requestApproval";
  return "item/tool/requestUserInput";
}

function requireText(value: string): string {
  const text = value.trim();
  if (!text) {
    throw new CodexProviderError("INVALID_MESSAGE", "Message text cannot be empty.");
  }
  return text;
}

function safeErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCodexThread(value: unknown): value is CodexThread {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.cwd === "string" &&
    isThreadStatus(value.status) &&
    Array.isArray(value.turns)
  );
}

function isThreadStatus(value: unknown): value is CodexThreadStatus {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "notLoaded" || value.type === "idle" || value.type === "systemError") return true;
  return (
    value.type === "active" &&
    Array.isArray(value.activeFlags) &&
    value.activeFlags.every(
      (flag) => flag === "waitingOnApproval" || flag === "waitingOnUserInput",
    )
  );
}

function isTurn(value: unknown): value is CodexTurn {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (value.status === "completed" ||
      value.status === "interrupted" ||
      value.status === "failed" ||
      value.status === "inProgress") &&
    Array.isArray(value.items)
  );
}

function isThreadStatusChanged(
  value: unknown,
): value is { threadId: string; status: CodexThreadStatus } {
  return isRecord(value) && typeof value.threadId === "string" && isThreadStatus(value.status);
}

function isTurnLifecycle(value: unknown): value is { threadId: string; turn: CodexTurn } {
  return isRecord(value) && typeof value.threadId === "string" && isTurn(value.turn);
}

function isTurnPlanUpdated(
  value: unknown,
): value is { threadId: string; turnId: string; explanation: string | null; plan: TurnPlanStep[] } {
  return (
    isRecord(value) &&
    typeof value.threadId === "string" &&
    typeof value.turnId === "string" &&
    (typeof value.explanation === "string" || value.explanation === null) &&
    Array.isArray(value.plan) &&
    value.plan.every(
      (step) =>
        isRecord(step) &&
        typeof step.step === "string" &&
        (step.status === "pending" || step.status === "inProgress" || step.status === "completed"),
    )
  );
}

function hasThreadAndTurn(
  value: unknown,
): value is Record<string, unknown> & { threadId: string; turnId: string } {
  return isRecord(value) && typeof value.threadId === "string" && typeof value.turnId === "string";
}

function isItemLifecycle(
  value: unknown,
): value is {
  threadId: string;
  turnId: string;
  item: CodexThreadItem;
  startedAtMs?: number;
  completedAtMs?: number;
} {
  return (
    hasThreadAndTurn(value) &&
    isRecord(value.item) &&
    typeof value.item.type === "string" &&
    (value.startedAtMs === undefined || typeof value.startedAtMs === "number") &&
    (value.completedAtMs === undefined || typeof value.completedAtMs === "number")
  );
}

function isErrorNotification(
  value: unknown,
): value is { threadId: string; turnId: string; willRetry: boolean; error: { message: string } } {
  return (
    hasThreadAndTurn(value) &&
    typeof value.willRetry === "boolean" &&
    isRecord(value.error) &&
    typeof value.error.message === "string"
  );
}

function isServerRequestResolved(
  value: unknown,
): value is { threadId: string; requestId: RpcId } {
  return (
    isRecord(value) &&
    typeof value.threadId === "string" &&
    (typeof value.requestId === "string" || typeof value.requestId === "number")
  );
}

function isCommandApprovalParams(value: unknown): value is CommandApprovalParams {
  return (
    hasThreadAndTurn(value) &&
    typeof value.itemId === "string" &&
    typeof value.startedAtMs === "number"
  );
}

function isFileApprovalParams(value: unknown): value is FileChangeApprovalParams {
  return (
    hasThreadAndTurn(value) &&
    typeof value.itemId === "string" &&
    typeof value.startedAtMs === "number"
  );
}

function isPermissionsApprovalParams(value: unknown): value is PermissionsApprovalParams {
  return (
    hasThreadAndTurn(value) &&
    typeof value.itemId === "string" &&
    typeof value.startedAtMs === "number" &&
    typeof value.cwd === "string" &&
    (typeof value.environmentId === "string" || value.environmentId === null) &&
    (typeof value.reason === "string" || value.reason === null) &&
    isRecord(value.permissions) &&
    isNetworkPermissions(value.permissions.network) &&
    isFileSystemPermissions(value.permissions.fileSystem)
  );
}

function isNetworkPermissions(value: unknown): boolean {
  return (
    value === null ||
    (isRecord(value) &&
      (typeof value.enabled === "boolean" || value.enabled === null))
  );
}

function isFileSystemPermissions(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  if (!isNullableStringArray(value.read) || !isNullableStringArray(value.write)) return false;
  if (value.globScanMaxDepth !== undefined && typeof value.globScanMaxDepth !== "number") return false;
  return (
    value.entries === undefined ||
    (Array.isArray(value.entries) && value.entries.every(isFileSystemPermissionEntry))
  );
}

function isNullableStringArray(value: unknown): boolean {
  return value === null || (Array.isArray(value) && value.every((entry) => typeof entry === "string"));
}

function isFileSystemPermissionEntry(value: unknown): boolean {
  if (
    !isRecord(value) ||
    (value.access !== "read" && value.access !== "write" && value.access !== "deny") ||
    !isRecord(value.path)
  ) {
    return false;
  }
  return (
    (value.path.type === "path" && typeof value.path.path === "string") ||
    (value.path.type === "glob_pattern" && typeof value.path.pattern === "string") ||
    (value.path.type === "special" && typeof value.path.value === "string")
  );
}

function isToolRequestUserInputParams(value: unknown): value is ToolRequestUserInputParams {
  return (
    hasThreadAndTurn(value) &&
    typeof value.itemId === "string" &&
    typeof value.isBlocking === "boolean" &&
    Array.isArray(value.questions) &&
    value.questions.every(
      (question) =>
        isRecord(question) &&
        typeof question.id === "string" &&
        typeof question.header === "string" &&
        typeof question.question === "string" &&
        typeof question.isOther === "boolean" &&
        typeof question.isSecret === "boolean" &&
        (question.options === null ||
          (Array.isArray(question.options) &&
            question.options.every(
              (option) =>
                isRecord(option) &&
                typeof option.label === "string" &&
                typeof option.description === "string",
            ))),
    )
  );
}
