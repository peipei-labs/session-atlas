import { EventEmitter } from "node:events";
import { mkdir, chmod, lstat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { randomUUID } from "node:crypto";

import {
  MAX_BRIDGE_LINE_BYTES,
  parseBridgeMessage,
  type BridgeCloseSessionCommand,
  type BridgeRestoreThreadCommand,
  type BridgeClearAutoResumeCommand,
  type BridgeConfigureAutoResumeCommand,
  type BridgeConfigureSavedMarkerCommand,
  type BridgeClearSavedMarkerCommand,
  type BridgeFocusCommand,
  type BridgeRestoreRecoveriesCommand,
  type BridgeRestoreLayoutCommand,
  type BridgeInboundMessage,
} from "./protocol.js";
import type { ItermWindowLayoutRecord } from "../../shared/types.js";
import type { ItermRecoveryTarget, ItermThreadRestoreTarget, ItermThreadRestoreResult, ContinuationCloseProof } from "../provider-ports.js";
import {
  ITERM_BRIDGE_VERSION,
  ITERM_BRIDGE_PROTOCOL_VERSION,
  type ItermBridgeAdapterOptions,
  type ItermBridgeHealth,
  type ItermRestoreUncertain,
  type ItermSessionSnapshot,
} from "./types.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_RESTORE_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_STALE_AFTER_MS = 45_000;
const CODEX_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

interface PendingRequestBase {
  windowId?: string;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  timedOut?: boolean;
}

interface VoidPendingRequest extends PendingRequestBase {
  kind: "focus" | "configure" | "close";
  resolve: () => void;
}

interface RestorePendingRequest extends PendingRequestBase {
  kind: "restore";
  resolve: (createdWindowId?: string) => void;
}

interface ThreadPendingRequest extends PendingRequestBase {
  kind: "thread";
  resolve: (result: ItermThreadRestoreResult) => void;
}

interface SavedMarkerPendingRequest extends PendingRequestBase {
  kind: "saved-marker";
  resultType: "configure-saved-marker-result" | "clear-saved-marker-result";
  resolve: () => void;
}

type PendingRequest = VoidPendingRequest | RestorePendingRequest | ThreadPendingRequest | SavedMarkerPendingRequest;

interface BoundSocketIdentity {
  dev: bigint;
  ino: bigint;
}

export class ItermRestoreInProgressError extends Error {
  readonly code = "WINDOW_RESTORE_IN_PROGRESS";

  constructor(windowId: string) {
    super(`An iTerm restore is already in progress for window ${windowId}`);
    this.name = "ItermRestoreInProgressError";
  }
}

export class ItermPartialRestoreError extends Error {
  readonly code = "WINDOW_RESTORE_PARTIAL";
  readonly createdWindowId: string | undefined;

  constructor(windowId: string, createdWindowId?: string) {
    super(
      `iTerm may have created part of window ${windowId}; inspect the created sessions before retrying.`,
    );
    this.name = "ItermPartialRestoreError";
    this.createdWindowId = createdWindowId;
  }
}

export function defaultItermBridgeSocketPath(): string {
  return join(homedir(), "Library", "Application Support", "SessionAtlas", "bridge.sock");
}

function offlineHealth(now: Date, message?: string): ItermBridgeHealth {
  return {
    status: "offline",
    observedAt: now.toISOString(),
    ...(message === undefined ? {} : { message }),
  };
}

async function isSocketActive(socketPath: string): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const probe = createConnection(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", (error: NodeJS.ErrnoException) => {
      probe.destroy();
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
        resolve(false);
      } else {
        reject(error);
      }
    });
  });
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  try {
    const stat = await lstat(socketPath, { bigint: true });
    if (!stat.isSocket()) {
      throw new Error(`Refusing to replace non-socket path: ${socketPath}`);
    }
    if (await isSocketActive(socketPath)) {
      throw new Error(`Another Session Atlas controller is already listening at ${socketPath}`);
    }
    await unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export class ItermBridgeAdapter extends EventEmitter {
  readonly socketPath: string;
  readonly requestTimeoutMs: number;
  readonly restoreRequestTimeoutMs: number;
  readonly staleAfterMs: number;

  #server: Server | undefined;
  #socket: Socket | undefined;
  #lineBuffer = Buffer.alloc(0);
  #sessions = new Map<string, ItermSessionSnapshot>();
  #health: ItermBridgeHealth;
  #helloReceived = false;
  #lastMessageAt = 0;
  #pendingRequests = new Map<string, PendingRequest>();
  #focusRequestId: string | undefined;
  #restoreRequestByWindow = new Map<string, string>();
  #uncertainRestoreWindows = new Map<string, string | undefined>();
  #staleTimer: NodeJS.Timeout | undefined;
  #boundIdentity: BoundSocketIdentity | undefined;
  #now: () => Date;

  constructor(options: ItermBridgeAdapterOptions = {}) {
    super();
    this.socketPath = options.socketPath ?? defaultItermBridgeSocketPath();
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.restoreRequestTimeoutMs =
      options.restoreRequestTimeoutMs ?? DEFAULT_RESTORE_REQUEST_TIMEOUT_MS;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.#now = options.now ?? (() => new Date());
    this.#health = offlineHealth(this.#now(), "Waiting for the iTerm2 bridge");
  }

  on(event: "snapshot", listener: (sessions: readonly ItermSessionSnapshot[]) => void): this;
  on(event: "health", listener: (health: ItermBridgeHealth) => void): this;
  on(event: "restore-uncertain", listener: (event: ItermRestoreUncertain) => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  async start(): Promise<void> {
    if (this.#server !== undefined) return;
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.socketPath), 0o700);
    await removeStaleSocket(this.socketPath);

    const server = createServer((socket) => this.#accept(socket));
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.socketPath);
    });

    try {
      await chmod(this.socketPath, 0o600);
      const stat = await lstat(this.socketPath, { bigint: true });
      if (!stat.isSocket()) throw new Error(`Bridge path is not a socket: ${this.socketPath}`);
      this.#boundIdentity = { dev: stat.dev, ino: stat.ino };
    } catch (error) {
      await this.stop();
      throw error;
    }

    this.#staleTimer = setInterval(
      () => this.#checkStaleness(),
      Math.max(250, Math.min(this.staleAfterMs / 3, 5_000)),
    );
    this.#staleTimer.unref();
  }

  async stop(): Promise<void> {
    if (this.#staleTimer !== undefined) clearInterval(this.#staleTimer);
    this.#staleTimer = undefined;
    this.#disconnect(new Error("iTerm bridge adapter stopped"));

    const server = this.#server;
    this.#server = undefined;
    if (server !== undefined) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await this.#removeOwnSocket();
    this.#setHealth(offlineHealth(this.#now(), "iTerm bridge adapter stopped"));
  }

  getSessions(): readonly ItermSessionSnapshot[] {
    return [...this.#sessions.values()].map((session) => ({ ...session }));
  }

  getHealth(): ItermBridgeHealth {
    return { ...this.#health };
  }

  async focus(sessionId: string): Promise<void> {
    if (!sessionId || sessionId.length > 512 || /[\r\n]/u.test(sessionId)) {
      throw new Error("Invalid iTerm session ID");
    }
    if (!this.#sessions.has(sessionId)) {
      throw new Error(`Unknown iTerm session: ${sessionId}`);
    }
    if (this.#socket === undefined || !this.#helloReceived || this.#health.status !== "online") {
      throw new Error("iTerm bridge is offline");
    }
    if (this.#focusRequestId !== undefined) {
      throw new Error("Another iTerm focus request is already in progress");
    }
    const requestId = randomUUID();
    const command: BridgeFocusCommand = {
      type: "focus",
      protocol: ITERM_BRIDGE_PROTOCOL_VERSION,
      requestId,
      sessionId,
      expiresAt: this.#now().getTime() + this.requestTimeoutMs,
    };

    const result = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pendingRequests.delete(requestId);
        if (this.#focusRequestId === requestId) this.#focusRequestId = undefined;
        reject(new Error("Timed out while focusing the iTerm session"));
      }, this.requestTimeoutMs);
      timeout.unref();
      this.#pendingRequests.set(requestId, { kind: "focus", resolve, reject, timeout });
      this.#focusRequestId = requestId;
    });

    this.#socket.write(`${JSON.stringify(command)}\n`, "utf8", (error) => {
      if (error === null || error === undefined) return;
      const pending = this.#takePending(requestId);
      if (pending === undefined) return;
      pending.reject(error);
    });
    return await result;
  }

  async closeSession(session: ItermSessionSnapshot, conversationId: string, proof: ContinuationCloseProof): Promise<void> {
    const { sessionId, cwd, jobPid, jobName, commandLine } = session;
    if (!sessionId || sessionId.length > 512 || /[\r\n\0]/u.test(sessionId)) throw new Error("Invalid iTerm session ID");
    if (!CODEX_SESSION_ID.test(conversationId)) throw new Error("Invalid Codex session ID");
    if (!isAbsolute(cwd) || /[\r\n\0]/u.test(cwd)) throw new Error("Invalid close working directory");
    if (!jobPid || !Number.isSafeInteger(jobPid) || jobPid < 1 || !jobName || !commandLine) {
      throw new Error("Closing requires an exact process identity");
    }
    if (!proof || !isAbsolute(proof.rolloutPath) || /[\r\n\0]/u.test(proof.rolloutPath) ||
        !Number.isSafeInteger(proof.size) || proof.size <= 0 || !/^[0-9]+$/u.test(proof.mtimeNs)) {
      throw new Error("Closing requires fresh rollout evidence");
    }
    const current = this.#sessions.get(sessionId);
    if (!current || current.cwd !== cwd || current.jobPid !== jobPid || current.jobName !== jobName || current.commandLine !== commandLine) {
      throw new Error("Close target process identity changed");
    }
    if (current.autoResumeConversationId && current.autoResumeConversationId !== conversationId) {
      throw new Error("Close target Codex identity changed");
    }
    if (this.#socket === undefined || !this.#helloReceived || this.#health.status !== "online") throw new Error("iTerm bridge is offline");
    const requestId = randomUUID();
    const command: BridgeCloseSessionCommand = {
      type: "close-session", protocol: ITERM_BRIDGE_PROTOCOL_VERSION, requestId,
      sessionId, cwd, conversationId, proof, expectedJobPid: jobPid, expectedJobName: jobName,
      expectedCommandLine: commandLine, expiresAt: this.#now().getTime() + this.requestTimeoutMs,
    };
    const result = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pendingRequests.delete(requestId);
        reject(new Error("Close result is uncertain; refresh the saved thread before retrying"));
      }, this.requestTimeoutMs);
      timeout.unref();
      this.#pendingRequests.set(requestId, { kind: "close", resolve, reject, timeout });
    });
    this.#socket.write(`${JSON.stringify(command)}\n`, "utf8", (error) => {
      if (error) this.#takePending(requestId)?.reject(error);
    });
    return await result;
  }

  confirmThreadRestored(conversationId: string, terminalSessionId: string): void {
    if (!CODEX_SESSION_ID.test(conversationId)) return;
    const terminal = this.#sessions.get(terminalSessionId);
    if (!terminal || (terminal.autoResumeConversationId && terminal.autoResumeConversationId !== conversationId)) return;
    const key = `thread:${conversationId}`;
    this.#uncertainRestoreWindows.delete(key);
    const requestId = this.#restoreRequestByWindow.get(key);
    if (requestId) {
      const pending = this.#pendingRequests.get(requestId);
      if (pending?.timedOut) this.#takePending(requestId);
      else if (!pending) this.#restoreRequestByWindow.delete(key);
    }
  }

  async restoreThread(target: ItermThreadRestoreTarget, controllerPort: number): Promise<ItermThreadRestoreResult> {
    if (!CODEX_SESSION_ID.test(target.conversationId)) throw new Error("Invalid Codex session ID");
    if (!isAbsolute(target.cwd) || /[\r\n\0]/u.test(target.cwd)) throw new Error("Invalid restore working directory");
    if (!target.title || target.title.length > 4096 || /[\r\n\0]/u.test(target.title)) throw new Error("Invalid thread title");
    if (target.savedCard !== undefined && typeof target.savedCard !== "boolean") throw new Error("Invalid saved-card marker request");
    if (!Number.isSafeInteger(controllerPort) || controllerPort < 1 || controllerPort > 65_535) throw new Error("Invalid Session Atlas controller port");
    if (this.#socket === undefined || !this.#helloReceived || this.#health.status !== "online") throw new Error("iTerm bridge is offline");
    const key = `thread:${target.conversationId}`;
    if (this.#uncertainRestoreWindows.has(key)) throw new ItermPartialRestoreError(key, this.#uncertainRestoreWindows.get(key));
    if (this.#restoreRequestByWindow.has(key)) throw new ItermRestoreInProgressError(key);
    const requestId = randomUUID();
    const command: BridgeRestoreThreadCommand = {
      type: "restore-thread", protocol: ITERM_BRIDGE_PROTOCOL_VERSION, requestId, target,
      controllerPort, expiresAt: this.#now().getTime() + this.restoreRequestTimeoutMs,
    };
    const result = new Promise<ItermThreadRestoreResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.#pendingRequests.get(requestId);
        if (!pending) return;
        pending.timedOut = true;
        this.#markRestoreUncertain(key);
        reject(new ItermPartialRestoreError(key));
      }, this.restoreRequestTimeoutMs);
      timeout.unref();
      this.#pendingRequests.set(requestId, { kind: "thread", windowId: key, resolve, reject, timeout });
      this.#restoreRequestByWindow.set(key, requestId);
    });
    this.#socket.write(`${JSON.stringify(command)}\n`, "utf8", (error) => {
      if (!error) return;
      const pending = this.#takePending(requestId);
      if (!pending) return;
      this.#markRestoreUncertain(key);
      if (!pending.timedOut) pending.reject(new ItermPartialRestoreError(key));
    });
    return await result;
  }

  async configureAutoResume(
    session: ItermSessionSnapshot,
    conversationId: string,
    controllerPort: number,
  ): Promise<void> {
    const { sessionId, cwd, jobPid, jobName, commandLine } = session;
    if (!sessionId || sessionId.length > 512 || /[\r\n]/u.test(sessionId)) {
      throw new Error("Invalid iTerm session ID");
    }
    if (!isAbsolute(cwd) || cwd.includes("\0") || /[\r\n]/u.test(cwd)) {
      throw new Error("Invalid automatic recovery working directory");
    }
    if (!CODEX_SESSION_ID.test(conversationId)) {
      throw new Error("Invalid Codex session ID");
    }
    if (!Number.isSafeInteger(controllerPort) || controllerPort < 1 || controllerPort > 65_535) {
      throw new Error("Invalid Session Atlas controller port");
    }
    if (!jobPid || !jobName || !commandLine) {
      throw new Error("Automatic recovery requires an exact process identity");
    }
    if (!this.#sessions.has(sessionId)) {
      throw new Error(`Unknown iTerm session: ${sessionId}`);
    }
    if (this.#socket === undefined || !this.#helloReceived || this.#health.status !== "online") {
      throw new Error("iTerm bridge is offline");
    }

    const requestId = randomUUID();
    const command: BridgeConfigureAutoResumeCommand = {
      type: "configure-auto-resume",
      protocol: ITERM_BRIDGE_PROTOCOL_VERSION,
      requestId,
      sessionId,
      cwd,
      conversationId,
      controllerPort,
      expectedJobPid: jobPid,
      expectedJobName: jobName,
      expectedCommandLine: commandLine,
    };
    const result = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pendingRequests.delete(requestId);
        reject(new Error("Timed out while configuring automatic Codex recovery"));
      }, this.requestTimeoutMs);
      timeout.unref();
      this.#pendingRequests.set(requestId, { kind: "configure", resolve, reject, timeout });
    });
    this.#socket.write(`${JSON.stringify(command)}\n`, "utf8", (error) => {
      if (error === null || error === undefined) return;
      const pending = this.#takePending(requestId);
      pending?.reject(error);
    });
    return await result;
  }

  async clearAutoResume(sessionId: string, conversationId: string): Promise<void> {
    if (!sessionId || sessionId.length > 512 || /[\r\n]/u.test(sessionId)) {
      throw new Error("Invalid iTerm session ID");
    }
    if (!CODEX_SESSION_ID.test(conversationId)) {
      throw new Error("Invalid Codex session ID");
    }
    if (!this.#sessions.has(sessionId)) {
      throw new Error(`Unknown iTerm session: ${sessionId}`);
    }
    if (this.#socket === undefined || !this.#helloReceived || this.#health.status !== "online") {
      throw new Error("iTerm bridge is offline");
    }

    const requestId = randomUUID();
    const command: BridgeClearAutoResumeCommand = {
      type: "clear-auto-resume",
      protocol: ITERM_BRIDGE_PROTOCOL_VERSION,
      requestId,
      sessionId,
      conversationId,
    };
    const result = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pendingRequests.delete(requestId);
        reject(new Error("Timed out while clearing automatic Codex recovery"));
      }, this.requestTimeoutMs);
      timeout.unref();
      this.#pendingRequests.set(requestId, { kind: "configure", resolve, reject, timeout });
    });
    this.#socket.write(`${JSON.stringify(command)}\n`, "utf8", (error) => {
      if (error === null || error === undefined) return;
      const pending = this.#takePending(requestId);
      pending?.reject(error);
    });
    return await result;
  }

  async configureSavedMarker(session: ItermSessionSnapshot, conversationId: string): Promise<void> {
    const { sessionId, cwd, jobPid, jobName, commandLine } = session;
    if (!sessionId || sessionId.length > 512 || /[\r\n\0]/u.test(sessionId)) throw new Error("Invalid iTerm session ID");
    if (!CODEX_SESSION_ID.test(conversationId)) throw new Error("Invalid Codex session ID");
    if (!isAbsolute(cwd) || /[\r\n\0]/u.test(cwd)) throw new Error("Invalid saved-marker working directory");
    if (!jobPid || !Number.isSafeInteger(jobPid) || jobPid < 1 || !jobName || !commandLine) {
      throw new Error("Saved markers require an exact process identity");
    }
    const current = this.#sessions.get(sessionId);
    if (!current || current.cwd !== cwd || current.jobPid !== jobPid || current.jobName !== jobName || current.commandLine !== commandLine) {
      throw new Error("Saved-marker target process identity changed");
    }
    if (current.autoResumeConversationId && current.autoResumeConversationId !== conversationId) {
      throw new Error("Saved-marker target Codex identity changed");
    }
    if (current.savedMarkerConversationId && (current.savedMarkerConversationId !== conversationId || current.savedMarkerOwnerSessionId !== sessionId)) {
      throw new Error("Saved-marker ownership changed");
    }
    const command: BridgeConfigureSavedMarkerCommand = {
      type: "configure-saved-marker", protocol: ITERM_BRIDGE_PROTOCOL_VERSION, requestId: randomUUID(),
      sessionId, conversationId, cwd, expectedJobPid: jobPid, expectedJobName: jobName,
      expectedCommandLine: commandLine, expiresAt: this.#now().getTime() + this.requestTimeoutMs,
    };
    await this.#sendSavedMarker(command, "configure-saved-marker-result");
  }

  async clearSavedMarker(sessionId: string, conversationId: string, forget = true): Promise<void> {
    if (!sessionId || sessionId.length > 512 || /[\r\n\0]/u.test(sessionId)) throw new Error("Invalid iTerm session ID");
    if (!CODEX_SESSION_ID.test(conversationId)) throw new Error("Invalid Codex session ID");
    if (typeof forget !== "boolean") throw new Error("Invalid saved-marker cleanup request");
    const current = this.#sessions.get(sessionId);
    if (!current) throw new Error(`Unknown iTerm session: ${sessionId}`);
    if (current.savedMarkerConversationId && current.savedMarkerConversationId !== conversationId) {
      throw new Error("Saved-marker ownership changed");
    }
    const command: BridgeClearSavedMarkerCommand = {
      type: "clear-saved-marker", protocol: ITERM_BRIDGE_PROTOCOL_VERSION, requestId: randomUUID(),
      sessionId, conversationId, forget, expiresAt: this.#now().getTime() + this.requestTimeoutMs,
    };
    await this.#sendSavedMarker(command, "clear-saved-marker-result");
  }

  async #sendSavedMarker(
    command: BridgeConfigureSavedMarkerCommand | BridgeClearSavedMarkerCommand,
    resultType: SavedMarkerPendingRequest["resultType"],
  ): Promise<void> {
    if (this.#socket === undefined || !this.#helloReceived || this.#health.status !== "online") throw new Error("iTerm bridge is offline");
    const result = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pendingRequests.delete(command.requestId);
        reject(new Error("Timed out while updating the saved-session marker"));
      }, this.requestTimeoutMs);
      timeout.unref();
      this.#pendingRequests.set(command.requestId, { kind: "saved-marker", resultType, resolve, reject, timeout });
    });
    this.#socket.write(`${JSON.stringify(command)}\n`, "utf8", (error) => {
      if (error) this.#takePending(command.requestId)?.reject(error);
    });
    await result;
  }

  async restoreLayout(
    layout: ItermWindowLayoutRecord,
    controllerPort: number,
  ): Promise<string | undefined> {
    if (!layout.windowId || layout.tabs.length === 0) {
      throw new Error("Invalid iTerm window layout");
    }
    if (!Number.isSafeInteger(controllerPort) || controllerPort < 1 || controllerPort > 65_535) {
      throw new Error("Invalid Session Atlas controller port");
    }
    if (this.#socket === undefined || !this.#helloReceived || this.#health.status !== "online") {
      throw new Error("iTerm bridge is offline");
    }
    if (this.#uncertainRestoreWindows.has(layout.windowId)) {
      throw new ItermPartialRestoreError(
        layout.windowId,
        this.#uncertainRestoreWindows.get(layout.windowId),
      );
    }
    if (this.#restoreRequestByWindow.has(layout.windowId)) {
      throw new ItermRestoreInProgressError(layout.windowId);
    }
    const requestId = randomUUID();
    const command: BridgeRestoreLayoutCommand = {
      type: "restore-layout",
      protocol: ITERM_BRIDGE_PROTOCOL_VERSION,
      requestId,
      layout,
      controllerPort,
    };
    const result = new Promise<string | undefined>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.#pendingRequests.get(requestId);
        if (pending === undefined) return;
        pending.timedOut = true;
        this.#markRestoreUncertain(layout.windowId);
        reject(new ItermPartialRestoreError(layout.windowId));
      }, this.restoreRequestTimeoutMs);
      timeout.unref();
      this.#pendingRequests.set(requestId, {
        kind: "restore",
        windowId: layout.windowId,
        resolve,
        reject,
        timeout,
      });
      this.#restoreRequestByWindow.set(layout.windowId, requestId);
    });
    this.#socket.write(`${JSON.stringify(command)}\n`, "utf8", (error) => {
      if (error === null || error === undefined) return;
      const pending = this.#takePending(requestId);
      if (pending === undefined) return;
      if ((pending.kind === "restore" || pending.kind === "thread") && pending.windowId) {
        this.#markRestoreUncertain(pending.windowId);
        if (!pending.timedOut) {
          pending.reject(new ItermPartialRestoreError(pending.windowId));
        }
      } else {
        pending.reject(error);
      }
    });
    return await result;
  }

  async restoreRecoveries(
    batchId: string,
    targets: readonly ItermRecoveryTarget[],
    controllerPort: number,
  ): Promise<void> {
    if (!batchId || targets.length === 0) {
      throw new Error("Invalid iTerm recovery batch");
    }
    if (!Number.isSafeInteger(controllerPort) || controllerPort < 1 || controllerPort > 65_535) {
      throw new Error("Invalid Session Atlas controller port");
    }
    if (this.#socket === undefined || !this.#helloReceived || this.#health.status !== "online") {
      throw new Error("iTerm bridge is offline");
    }
    if (this.#uncertainRestoreWindows.has(batchId)) {
      throw new ItermPartialRestoreError(batchId);
    }
    if (this.#restoreRequestByWindow.has(batchId)) {
      throw new ItermRestoreInProgressError(batchId);
    }
    const requestId = randomUUID();
    const command: BridgeRestoreRecoveriesCommand = {
      type: "restore-recoveries",
      protocol: ITERM_BRIDGE_PROTOCOL_VERSION,
      requestId,
      batchId,
      recoveries: targets,
      controllerPort,
    };
    const result = new Promise<string | undefined>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.#pendingRequests.get(requestId);
        if (pending === undefined) return;
        pending.timedOut = true;
        this.#markRestoreUncertain(batchId);
        reject(new ItermPartialRestoreError(batchId));
      }, this.restoreRequestTimeoutMs);
      timeout.unref();
      this.#pendingRequests.set(requestId, {
        kind: "restore",
        windowId: batchId,
        resolve,
        reject,
        timeout,
      });
      this.#restoreRequestByWindow.set(batchId, requestId);
    });
    this.#socket.write(`${JSON.stringify(command)}\n`, "utf8", (error) => {
      if (error === null || error === undefined) return;
      const pending = this.#takePending(requestId);
      if (pending === undefined) return;
      this.#markRestoreUncertain(batchId);
      if (!pending.timedOut) pending.reject(new ItermPartialRestoreError(batchId));
    });
    await result;
  }

  #accept(socket: Socket): void {
    if (this.#socket !== undefined) {
      socket.destroy();
      return;
    }
    this.#socket = socket;
    this.#lineBuffer = Buffer.alloc(0);
    this.#helloReceived = false;
    this.#lastMessageAt = Date.now();
    socket.on("data", (chunk: Buffer) => this.#receive(chunk));
    socket.once("close", () => {
      if (this.#socket === socket) {
        this.#disconnect(new Error("iTerm bridge disconnected"), false);
      }
    });
    socket.once("error", () => {
      if (this.#socket === socket) {
        this.#disconnect(new Error("iTerm bridge connection failed"));
      }
    });
  }

  #receive(chunk: Buffer): void {
    this.#lineBuffer = Buffer.concat([this.#lineBuffer, chunk]);
    if (this.#lineBuffer.length > MAX_BRIDGE_LINE_BYTES) {
      this.#disconnect(new Error("iTerm bridge message exceeded the protocol limit"));
      return;
    }

    let newline = this.#lineBuffer.indexOf(0x0a);
    while (newline >= 0) {
      const line = this.#lineBuffer.subarray(0, newline);
      this.#lineBuffer = this.#lineBuffer.subarray(newline + 1);
      if (line.length > 0) this.#receiveLine(line);
      newline = this.#lineBuffer.indexOf(0x0a);
    }
  }

  #receiveLine(line: Buffer): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line.toString("utf8"));
    } catch {
      this.#disconnect(new Error("iTerm bridge sent invalid JSON"));
      return;
    }
    const message = parseBridgeMessage(raw);
    if (message === null) {
      this.#disconnect(new Error("iTerm bridge protocol mismatch"));
      return;
    }
    if (!this.#helloReceived && message.type !== "hello") {
      this.#disconnect(new Error("iTerm bridge did not send a protocol hello"));
      return;
    }

    this.#lastMessageAt = Date.now();
    this.#handle(message);
  }

  #handle(message: BridgeInboundMessage): void {
    if ("requestId" in message && message.requestId) {
      const pending = this.#pendingRequests.get(message.requestId);
      if (pending?.kind === "saved-marker" && message.type !== pending.resultType && message.type !== "error") return;
    }
    switch (message.type) {
      case "hello": {
        if (message.bridgeVersion !== ITERM_BRIDGE_VERSION) {
          this.#disconnect(
            new Error(
              `Unsupported iTerm bridge version ${message.bridgeVersion}; expected ${ITERM_BRIDGE_VERSION}`,
            ),
          );
          break;
        }
        this.#helloReceived = true;
        const now = this.#now().toISOString();
        this.#setHealth({
          status: "online",
          connectedAt: now,
          observedAt: now,
          bridgeVersion: message.bridgeVersion,
        });
        break;
      }
      case "health":
        this.#setHealth({
          ...this.#health,
          status: "online",
          observedAt: message.sentAt,
          ...(message.message === undefined ? {} : { message: message.message }),
        });
        break;
      case "snapshot":
        this.#sessions = new Map(
          message.sessions.map((session) => [session.sessionId, { ...session }]),
        );
        this.emit("snapshot", this.getSessions());
        break;
      case "close-session-result": {
        const pending = this.#takePending(message.requestId);
        if (!pending || pending.timedOut || pending.kind !== "close") break;
        if (message.ok) pending.resolve();
        else pending.reject(new Error(message.error ?? "iTerm2 could not close the saved session"));
        break;
      }
      case "restore-thread-result": {
        const pending = this.#takePending(message.requestId);
        if (!pending || pending.kind !== "thread" || !pending.windowId) break;
        if (message.partial) {
          this.#markRestoreUncertain(pending.windowId, message.windowId);
          if (!pending.timedOut) pending.reject(new ItermPartialRestoreError(pending.windowId, message.windowId));
        } else if (!pending.timedOut) {
          if (message.ok && message.terminalSessionId) pending.resolve({
            terminalSessionId: message.terminalSessionId,
            ...(message.windowId ? { windowId: message.windowId } : {}),
          });
          else pending.reject(new Error(message.error ?? "iTerm2 could not restore the saved thread"));
        }
        break;
      }
      case "focus-result": {
        const pending = this.#takePending(message.requestId);
        if (pending === undefined) break;
        if (pending.timedOut) break;
        if (message.ok && pending.kind !== "thread") pending.resolve();
        else pending.reject(new Error(message.error ?? "iTerm2 could not focus the session"));
        break;
      }
      case "restore-layout-result": {
        const pending = this.#takePending(message.requestId);
        if (pending === undefined) break;
        if (message.partial && (pending.kind === "restore" || pending.kind === "thread") && pending.windowId) {
          this.#markRestoreUncertain(pending.windowId, message.createdWindowId);
          if (!pending.timedOut) {
            pending.reject(
              new ItermPartialRestoreError(pending.windowId, message.createdWindowId),
            );
          }
          break;
        }
        if (pending.timedOut) break;
        if (message.ok && pending.kind === "restore") {
          pending.resolve(message.createdWindowId);
        } else {
          pending.reject(new Error(message.error ?? "iTerm2 could not restore the window"));
        }
        break;
      }
      case "restore-recoveries-result": {
        const pending = this.#takePending(message.requestId);
        if (pending === undefined) break;
        if (message.partial && (pending.kind === "restore" || pending.kind === "thread") && pending.windowId) {
          this.#markRestoreUncertain(pending.windowId);
          if (!pending.timedOut) {
            pending.reject(new ItermPartialRestoreError(pending.windowId));
          }
          break;
        }
        if (pending.timedOut) break;
        if (message.ok && pending.kind === "restore") pending.resolve();
        else pending.reject(new Error(message.error ?? "iTerm2 could not restore the sessions"));
        break;
      }
      case "configure-auto-resume-result": {
        const pending = this.#takePending(message.requestId);
        if (pending === undefined || pending.timedOut) break;
        if (message.ok && pending.kind !== "thread") pending.resolve();
        else {
          pending.reject(
            new Error(message.error ?? "iTerm2 could not configure automatic Codex recovery"),
          );
        }
        break;
      }
      case "clear-auto-resume-result": {
        const pending = this.#takePending(message.requestId);
        if (pending === undefined || pending.timedOut) break;
        if (message.ok && pending.kind !== "thread") pending.resolve();
        else {
          pending.reject(
            new Error(message.error ?? "iTerm2 could not clear automatic Codex recovery"),
          );
        }
        break;
      }
      case "configure-saved-marker-result":
      case "clear-saved-marker-result": {
        const pending = this.#pendingRequests.get(message.requestId);
        if (pending?.kind !== "saved-marker" || pending.resultType !== message.type) break;
        this.#takePending(message.requestId);
        if (message.ok) pending.resolve();
        else pending.reject(new Error(message.error ?? "iTerm2 could not update the saved-session marker"));
        break;
      }
      case "error": {
        if (message.requestId === undefined) break;
        const pending = this.#takePending(message.requestId);
        if (pending === undefined) break;
        if (pending.timedOut) break;
        pending.reject(new Error(message.message));
        break;
      }
    }
  }

  #checkStaleness(): void {
    if (
      this.#socket !== undefined &&
      this.#lastMessageAt > 0 &&
      Date.now() - this.#lastMessageAt > this.staleAfterMs
    ) {
      this.#disconnect(new Error("iTerm bridge heartbeat expired"));
    }
  }

  #disconnect(error: Error, destroySocket = true): void {
    const socket = this.#socket;
    this.#socket = undefined;
    this.#helloReceived = false;
    this.#lineBuffer = Buffer.alloc(0);
    if (destroySocket) socket?.destroy();
    for (const pending of this.#pendingRequests.values()) {
      clearTimeout(pending.timeout);
      if ((pending.kind === "restore" || pending.kind === "thread") && pending.windowId) {
        this.#markRestoreUncertain(pending.windowId);
        if (!pending.timedOut) {
          pending.reject(new ItermPartialRestoreError(pending.windowId));
        }
      } else if (!pending.timedOut) {
        pending.reject(error);
      }
    }
    this.#pendingRequests.clear();
    this.#focusRequestId = undefined;
    this.#restoreRequestByWindow.clear();
    this.#setHealth(offlineHealth(this.#now(), error.message));
  }

  #takePending(requestId: string): PendingRequest | undefined {
    const pending = this.#pendingRequests.get(requestId);
    if (pending === undefined) return undefined;
    clearTimeout(pending.timeout);
    this.#pendingRequests.delete(requestId);
    if (pending.kind === "focus" && this.#focusRequestId === requestId) {
      this.#focusRequestId = undefined;
    }
    if (
      (pending.kind === "restore" || pending.kind === "thread") &&
      pending.windowId &&
      this.#restoreRequestByWindow.get(pending.windowId) === requestId
    ) {
      this.#restoreRequestByWindow.delete(pending.windowId);
    }
    return pending;
  }

  #markRestoreUncertain(windowId: string, createdWindowId?: string): void {
    const alreadyUncertain = this.#uncertainRestoreWindows.has(windowId);
    const previousCreatedWindowId = this.#uncertainRestoreWindows.get(windowId);
    if (
      alreadyUncertain &&
      (createdWindowId === undefined || createdWindowId === previousCreatedWindowId)
    ) {
      return;
    }
    this.#uncertainRestoreWindows.set(windowId, createdWindowId);
    this.emit("restore-uncertain", {
      windowId,
      ...(createdWindowId ? { createdWindowId } : {}),
    } satisfies ItermRestoreUncertain);
  }

  #setHealth(health: ItermBridgeHealth): void {
    this.#health = health;
    this.emit("health", this.getHealth());
  }

  async #removeOwnSocket(): Promise<void> {
    const identity = this.#boundIdentity;
    this.#boundIdentity = undefined;
    if (identity === undefined) return;
    try {
      const stat = await lstat(this.socketPath, { bigint: true });
      if (stat.isSocket() && stat.dev === identity.dev && stat.ino === identity.ino) {
        await unlink(this.socketPath);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
