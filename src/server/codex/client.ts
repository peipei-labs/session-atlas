import { execFile, spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";

import type {
  CodexThread,
  InitializeResponse,
  RpcErrorBody,
  RpcId,
  RpcNotification,
  RpcServerRequest,
  ThreadListParams,
  ThreadListResponse,
  ThreadItemsListParams,
  ThreadItemsListResponse,
  ThreadLoadedListResponse,
  ThreadReadResponse,
  ThreadStartParams,
  ThreadStartResponse,
  ThreadTurnsListParams,
  ThreadTurnsListResponse,
  TurnStartResponse,
  TurnSteerResponse,
} from "./protocol.js";
import { rpcKey, textInput } from "./protocol.js";

const SUPPORTED_VERSION_MAJOR = 0;
const SUPPORTED_VERSION_MIN_MINOR = 148;
const SUPPORTED_VERSION_MAX_MINOR = 154;
const SUPPORTED_VERSION_LABEL = "0.148.x–0.154.x";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_PROTOCOL_LINE_BYTES = 8 * 1024 * 1024;

export type CodexClientState = "stopped" | "starting" | "running";

export type CodexClientEvent =
  | { type: "state"; state: CodexClientState; error?: Error }
  | { type: "notification"; notification: RpcNotification }
  | { type: "server-request"; request: RpcServerRequest }
  | { type: "protocol-error"; error: Error }
  | { type: "diagnostic"; message: string };

export type CodexClientListener = (event: CodexClientEvent) => void;

export interface CodexAppServerClientOptions {
  executable?: string;
  appServerArgs?: string[];
  versionArgs?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  clientVersion?: string;
  versionProbe?: () => Promise<string>;
}

export class CodexProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexProtocolError";
  }
}

export class CodexRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(error: RpcErrorBody) {
    super(error.message);
    this.name = "CodexRpcError";
    this.code = error.code;
    this.data = error.data;
  }
}

export class CodexReadOnlyError extends Error {
  readonly code = "READ_ONLY_PROTOCOL_VERSION";

  constructor(version: string | undefined) {
    super(
      version
        ? `Codex ${version} is outside the supported ${SUPPORTED_VERSION_LABEL} protocol range; writes are disabled.`
        : "The Codex protocol version could not be verified; writes are disabled.",
    );
    this.name = "CodexReadOnlyError";
  }
}

interface PendingClientRequest {
  id: RpcId;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface SpawnedProcess {
  child: ChildProcessWithoutNullStreams;
  lines: ReadLineInterface;
}

export interface CodexClientPort {
  readonly state: CodexClientState;
  readonly version: string | undefined;
  readonly writable: boolean;
  readonly processId?: number;
  readonly initializeResult: InitializeResponse | undefined;
  start(): Promise<void>;
  stop(): Promise<void>;
  subscribe(listener: CodexClientListener): () => void;
  threadStart(params: ThreadStartParams): Promise<ThreadStartResponse>;
  threadList(params?: ThreadListParams): Promise<ThreadListResponse>;
  threadRead(threadId: string, includeTurns?: boolean): Promise<ThreadReadResponse>;
  threadTurnsList?(params: ThreadTurnsListParams): Promise<ThreadTurnsListResponse>;
  threadItemsList?(params: ThreadItemsListParams): Promise<ThreadItemsListResponse>;
  threadLoadedList(params?: { cursor?: string | null; limit?: number | null }): Promise<ThreadLoadedListResponse>;
  turnStart(threadId: string, text: string): Promise<TurnStartResponse>;
  turnSteer(threadId: string, expectedTurnId: string, text: string): Promise<TurnSteerResponse>;
  turnInterrupt(threadId: string, turnId: string): Promise<void>;
  respondToServerRequest(id: RpcId, result: unknown): void;
  rejectServerRequest(id: RpcId, code: number, message: string): void;
  declineServerRequest(request: RpcServerRequest, message?: string): void;
}

export class CodexAppServerClient implements CodexClientPort {
  readonly #options: Required<
    Pick<
      CodexAppServerClientOptions,
      "executable" | "appServerArgs" | "versionArgs" | "requestTimeoutMs" | "clientVersion"
    >
  > &
    Omit<CodexAppServerClientOptions, "executable" | "appServerArgs" | "versionArgs" | "requestTimeoutMs" | "clientVersion">;

  #state: CodexClientState = "stopped";
  #version: string | undefined;
  #versionSupported = false;
  #protocolHealthy = true;
  #initializeResult: InitializeResponse | undefined;
  #spawned: SpawnedProcess | undefined;
  #nextRequestId = 1;
  #pendingClientRequests = new Map<string, PendingClientRequest>();
  #pendingServerRequests = new Set<string>();
  #listeners = new Set<CodexClientListener>();
  #startPromise: Promise<void> | undefined;
  #stopRequested = false;
  #stderrNotified = false;

  constructor(options: CodexAppServerClientOptions = {}) {
    this.#options = {
      executable: options.executable ?? "codex",
      appServerArgs: options.appServerArgs ?? ["app-server", "--stdio"],
      versionArgs: options.versionArgs ?? ["--version"],
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      clientVersion: options.clientVersion ?? "0.1.0",
      cwd: options.cwd,
      env: options.env,
      versionProbe: options.versionProbe,
    };
  }

  get state(): CodexClientState {
    return this.#state;
  }

  get version(): string | undefined {
    return this.#version;
  }

  get writable(): boolean {
    return this.#state === "running" && this.#versionSupported && this.#protocolHealthy;
  }

  get processId(): number | undefined {
    return this.#spawned?.child.pid;
  }

  get initializeResult(): InitializeResponse | undefined {
    return this.#initializeResult;
  }

  subscribe(listener: CodexClientListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.#state === "running") {
      return;
    }
    if (this.#startPromise) {
      return this.#startPromise;
    }

    this.#startPromise = this.#start().finally(() => {
      this.#startPromise = undefined;
    });
    return this.#startPromise;
  }

  async #start(): Promise<void> {
    this.#stopRequested = false;
    this.#protocolHealthy = true;
    this.#stderrNotified = false;
    this.#setState("starting");

    try {
      const versionOutput = await this.#probeVersion().catch(() => "");
      this.#setVersion(versionOutput);

      const child = nodeSpawn(this.#options.executable, this.#options.appServerArgs, {
        cwd: this.#options.cwd,
        env: { ...process.env, ...this.#options.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
      this.#spawned = { child, lines };

      lines.on("line", (line) => this.#handleLine(line));
      child.stderr.on("data", (chunk: Buffer | string) => {
        if (!this.#stderrNotified && String(chunk).trim()) {
          this.#stderrNotified = true;
          this.#emit({
            type: "diagnostic",
            message: "Codex App Server produced diagnostic output on stderr.",
          });
        }
      });
      child.once("error", (error) => this.#handleTransportFailure(child, error));
      child.once("close", (code, signal) => {
        const detail = signal ? `signal ${signal}` : `exit code ${String(code)}`;
        this.#handleTransportFailure(
          child,
          this.#stopRequested
            ? undefined
            : new CodexProtocolError(`Codex App Server closed unexpectedly (${detail}).`),
        );
      });

      const initialized = await this.#requestRaw<InitializeResponse>(
        "initialize",
        {
          clientInfo: {
            name: "session-atlas",
            title: "Session Atlas",
            version: this.#options.clientVersion,
          },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
          },
        },
        true,
      );
      this.#assertInitializeResponse(initialized);
      this.#initializeResult = initialized;
      if (!this.#version) {
        this.#setVersion(initialized.userAgent);
      }
      this.#writeMessage({ method: "initialized" });
      this.#setState("running");
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      await this.stop();
      this.#emit({ type: "state", state: "stopped", error: normalized });
      throw normalized;
    }
  }

  async stop(): Promise<void> {
    this.#stopRequested = true;
    const spawned = this.#spawned;
    if (!spawned) {
      this.#rejectPending(new CodexProtocolError("Codex App Server stopped."));
      this.#setState("stopped");
      return;
    }

    spawned.child.stdin.end();
    await this.#waitForClose(spawned.child, 750);
    if (this.#spawned?.child === spawned.child && childIsRunning(spawned.child)) {
      spawned.child.kill("SIGTERM");
      await this.#waitForClose(spawned.child, 750);
    }
    if (this.#spawned?.child === spawned.child && childIsRunning(spawned.child)) {
      // This is the exact child created above, never a process discovered by PID scanning.
      spawned.child.kill("SIGKILL");
      await this.#waitForClose(spawned.child, 1_000);
    }
    const failedToStop = this.#spawned?.child === spawned.child && childIsRunning(spawned.child);
    if (this.#spawned?.child === spawned.child) {
      spawned.lines.close();
      spawned.child.stdout.destroy();
      spawned.child.stderr.destroy();
      this.#spawned = undefined;
    }
    this.#rejectPending(new CodexProtocolError("Codex App Server stopped."));
    this.#pendingServerRequests.clear();
    this.#initializeResult = undefined;
    this.#setState("stopped");
    if (failedToStop) {
      throw new CodexProtocolError("The owned Codex App Server child did not stop.");
    }
  }

  async threadStart(params: ThreadStartParams): Promise<ThreadStartResponse> {
    this.#ensureWritable();
    return this.#requestRaw<ThreadStartResponse>("thread/start", params);
  }

  async threadList(params: ThreadListParams = {}): Promise<ThreadListResponse> {
    this.#ensureRunning();
    return this.#requestRaw<ThreadListResponse>("thread/list", params);
  }

  async threadRead(threadId: string, includeTurns = false): Promise<ThreadReadResponse> {
    this.#ensureRunning();
    return this.#requestRaw<ThreadReadResponse>("thread/read", { threadId, includeTurns });
  }

  async threadTurnsList(params: ThreadTurnsListParams): Promise<ThreadTurnsListResponse> {
    this.#ensureRunning();
    return this.#requestRaw<ThreadTurnsListResponse>("thread/turns/list", params);
  }

  async threadItemsList(params: ThreadItemsListParams): Promise<ThreadItemsListResponse> {
    this.#ensureRunning();
    return this.#requestRaw<ThreadItemsListResponse>("thread/items/list", params);
  }

  async threadLoadedList(
    params: { cursor?: string | null; limit?: number | null } = {},
  ): Promise<ThreadLoadedListResponse> {
    this.#ensureRunning();
    // Supported versions require an explicit object even though both fields are optional.
    return this.#requestRaw<ThreadLoadedListResponse>("thread/loaded/list", params);
  }

  async turnStart(threadId: string, text: string): Promise<TurnStartResponse> {
    this.#ensureWritable();
    return this.#requestRaw<TurnStartResponse>("turn/start", {
      threadId,
      input: [textInput(text)],
    });
  }

  async turnSteer(
    threadId: string,
    expectedTurnId: string,
    text: string,
  ): Promise<TurnSteerResponse> {
    this.#ensureWritable();
    return this.#requestRaw<TurnSteerResponse>("turn/steer", {
      threadId,
      expectedTurnId,
      input: [textInput(text)],
    });
  }

  async turnInterrupt(threadId: string, turnId: string): Promise<void> {
    this.#ensureWritable();
    await this.#requestRaw<Record<string, never>>("turn/interrupt", { threadId, turnId });
  }

  respondToServerRequest(id: RpcId, result: unknown): void {
    this.#ensureWritable();
    const key = rpcKey(id);
    if (!this.#pendingServerRequests.has(key)) {
      throw new CodexProtocolError(`Server request ${String(id)} is no longer pending.`);
    }
    this.#writeMessage({ id, result });
    this.#pendingServerRequests.delete(key);
  }

  rejectServerRequest(id: RpcId, code: number, message: string): void {
    const key = rpcKey(id);
    if (!this.#pendingServerRequests.has(key)) {
      return;
    }
    this.#writeMessage({ id, error: { code, message } });
    this.#pendingServerRequests.delete(key);
  }

  declineServerRequest(request: RpcServerRequest, message = "Session Atlas declined the request."): void {
    if (request.method === "item/commandExecution/requestApproval") {
      this.#respondFailClosed(request.id, { decision: "decline" });
      return;
    }
    if (request.method === "item/fileChange/requestApproval") {
      this.#respondFailClosed(request.id, { decision: "decline" });
      return;
    }
    if (request.method === "item/permissions/requestApproval") {
      this.#respondFailClosed(request.id, { permissions: {}, scope: "turn" });
      return;
    }
    this.rejectServerRequest(request.id, -32001, message);
  }

  #respondFailClosed(id: RpcId, result: unknown): void {
    const key = rpcKey(id);
    if (!this.#pendingServerRequests.has(key)) {
      return;
    }
    this.#writeMessage({ id, result });
    this.#pendingServerRequests.delete(key);
  }

  async #requestRaw<T>(method: string, params: unknown, allowStarting = false): Promise<T> {
    if (!allowStarting) {
      this.#ensureRunning();
    }
    const spawned = this.#spawned;
    if (!spawned || (this.#state !== "running" && this.#state !== "starting")) {
      throw new CodexProtocolError("Codex App Server is not running.");
    }

    const id = this.#nextRequestId++;
    const key = rpcKey(id);
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingClientRequests.delete(key);
        reject(new CodexProtocolError(`${method} timed out after ${this.#options.requestTimeoutMs}ms.`));
      }, this.#options.requestTimeoutMs);
      timer.unref();
      this.#pendingClientRequests.set(key, {
        id,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
    });

    try {
      this.#writeMessage({ method, id, params });
    } catch (error) {
      const pending = this.#pendingClientRequests.get(key);
      if (pending) {
        clearTimeout(pending.timer);
        this.#pendingClientRequests.delete(key);
      }
      throw error;
    }
    return promise;
  }

  #writeMessage(message: unknown): void {
    const child = this.#spawned?.child;
    if (!child || child.stdin.destroyed || !child.stdin.writable) {
      throw new CodexProtocolError("Codex App Server stdin is unavailable.");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }
    if (Buffer.byteLength(line, "utf8") > MAX_PROTOCOL_LINE_BYTES) {
      this.#markProtocolUnhealthy(new CodexProtocolError("Codex protocol line exceeded 8 MiB."));
      return;
    }

    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      this.#markProtocolUnhealthy(
        new CodexProtocolError("Codex App Server emitted malformed JSON.", { cause: error }),
      );
      return;
    }

    if (!isRecord(value)) {
      this.#markProtocolUnhealthy(new CodexProtocolError("Codex App Server emitted a non-object message."));
      return;
    }

    if (typeof value.method === "string" && isRpcId(value.id)) {
      const request: RpcServerRequest = {
        method: value.method,
        id: value.id,
        ...(Object.hasOwn(value, "params") ? { params: value.params } : {}),
      };
      this.#pendingServerRequests.add(rpcKey(request.id));
      this.#emit({ type: "server-request", request });
      return;
    }

    if (typeof value.method === "string") {
      const notification: RpcNotification = {
        method: value.method,
        ...(Object.hasOwn(value, "params") ? { params: value.params } : {}),
      };
      if (
        notification.method === "serverRequest/resolved" &&
        isRecord(notification.params) &&
        isRpcId(notification.params.requestId)
      ) {
        this.#pendingServerRequests.delete(rpcKey(notification.params.requestId));
      }
      this.#emit({ type: "notification", notification });
      return;
    }

    if (isRpcId(value.id) && (Object.hasOwn(value, "result") || Object.hasOwn(value, "error"))) {
      this.#handleResponse(value);
      return;
    }

    this.#markProtocolUnhealthy(new CodexProtocolError("Codex App Server emitted an unknown message shape."));
  }

  #handleResponse(value: Record<string, unknown>): void {
    const id = value.id;
    if (!isRpcId(id)) {
      return;
    }
    const key = rpcKey(id);
    const pending = this.#pendingClientRequests.get(key);
    if (!pending) {
      this.#emit({
        type: "protocol-error",
        error: new CodexProtocolError(`Received a response for unknown request ${String(id)}.`),
      });
      return;
    }
    clearTimeout(pending.timer);
    this.#pendingClientRequests.delete(key);

    if (isRpcError(value.error)) {
      pending.reject(new CodexRpcError(value.error));
      return;
    }
    pending.resolve(value.result);
  }

  #handleTransportFailure(child: ChildProcessWithoutNullStreams, error?: Error): void {
    if (this.#spawned?.child !== child) {
      return;
    }
    this.#spawned.lines.close();
    this.#spawned = undefined;
    const reason = error ?? new CodexProtocolError("Codex App Server stopped.");
    this.#rejectPending(reason);
    this.#pendingServerRequests.clear();
    this.#initializeResult = undefined;
    this.#setState("stopped", error);
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pendingClientRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pendingClientRequests.clear();
  }

  #markProtocolUnhealthy(error: Error): void {
    this.#protocolHealthy = false;
    this.#emit({ type: "protocol-error", error });
  }

  #ensureRunning(): void {
    if (this.#state !== "running") {
      throw new CodexProtocolError("Codex App Server is not running.");
    }
  }

  #ensureWritable(): void {
    this.#ensureRunning();
    if (!this.writable) {
      throw new CodexReadOnlyError(this.#version);
    }
  }

  #assertInitializeResponse(value: unknown): asserts value is InitializeResponse {
    if (
      !isRecord(value) ||
      typeof value.userAgent !== "string" ||
      typeof value.codexHome !== "string" ||
      typeof value.platformFamily !== "string" ||
      typeof value.platformOs !== "string"
    ) {
      throw new CodexProtocolError("Codex App Server returned an invalid initialize response.");
    }
  }

  async #probeVersion(): Promise<string> {
    if (this.#options.versionProbe) {
      return this.#options.versionProbe();
    }
    return new Promise<string>((resolve, reject) => {
      execFile(
        this.#options.executable,
        this.#options.versionArgs,
        {
          cwd: this.#options.cwd,
          env: { ...process.env, ...this.#options.env },
          timeout: 5_000,
          maxBuffer: 64 * 1024,
          encoding: "utf8",
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(`${stdout}\n${stderr}`);
        },
      );
    });
  }

  #setVersion(output: string): void {
    const match = /(?:^|[^\d])(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?(?:$|[^\d])/.exec(output);
    if (!match) {
      this.#version = undefined;
      this.#versionSupported = false;
      return;
    }
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3]);
    this.#version = `${major}.${minor}.${patch}`;
    this.#versionSupported =
      major === SUPPORTED_VERSION_MAJOR &&
      minor >= SUPPORTED_VERSION_MIN_MINOR &&
      minor <= SUPPORTED_VERSION_MAX_MINOR;
  }

  #setState(state: CodexClientState, error?: Error): void {
    if (this.#state === state && !error) {
      return;
    }
    this.#state = state;
    this.#emit({ type: "state", state, ...(error ? { error } : {}) });
  }

  #emit(event: CodexClientEvent): void {
    for (const listener of [...this.#listeners]) {
      listener(event);
    }
  }

  #waitForClose(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref();
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRpcId(value: unknown): value is RpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function isRpcError(value: unknown): value is RpcErrorBody {
  return isRecord(value) && typeof value.code === "number" && typeof value.message === "string";
}

function childIsRunning(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode === null && child.signalCode === null;
}

export function assertThread(value: unknown): asserts value is CodexThread {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.cwd !== "string" ||
    !isRecord(value.status) ||
    typeof value.status.type !== "string"
  ) {
    throw new CodexProtocolError("Codex App Server returned an invalid thread.");
  }
}
