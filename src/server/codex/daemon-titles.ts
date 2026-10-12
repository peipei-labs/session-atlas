import { homedir } from "node:os";
import { join } from "node:path";

import WebSocket, { type RawData } from "ws";

export interface BookmarkTitleClient {
  readName(threadId: string): Promise<string | undefined>;
  rename(threadId: string, expectedName: string, name: string): Promise<boolean>;
}

interface DaemonTitleClientOptions {
  socketPath?: string;
  timeoutMs?: number;
}

type TitleMethod = "initialize" | "thread/read" | "thread/name/set";

const FAILURE_MESSAGE = "Codex daemon title request failed.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function failure(): Error {
  return new Error(FAILURE_MESSAGE);
}

class TitleConnection {
  readonly #socket: WebSocket;
  readonly #opened: Promise<void>;
  readonly #timer: NodeJS.Timeout;
  readonly #deadline: number;
  #rejectOpen: (error: Error) => void = () => {};
  #failure: Error | undefined;
  #nextId = 0;
  #pending:
    | { id: number; resolve: (value: unknown) => void; reject: (error: Error) => void }
    | undefined;

  constructor(socketPath: string, timeoutMs: number) {
    this.#deadline = Date.now() + timeoutMs;
    this.#socket = new WebSocket(`ws+unix://${socketPath}:/`, {
      handshakeTimeout: timeoutMs,
      maxPayload: 1024 * 1024,
      perMessageDeflate: false,
    });
    this.#opened = new Promise<void>((resolve, reject) => {
      this.#rejectOpen = reject;
      this.#socket.once("open", resolve);
    });
    this.#socket.on("error", () => this.#fail());
    this.#socket.once("close", () => this.#fail());
    this.#socket.on("message", (data, isBinary) => this.#onMessage(data, isBinary));
    // The same deadline covers connecting, initialization, reading, and the final write.
    this.#timer = setTimeout(() => {
      this.#fail();
      this.close();
    }, timeoutMs);
  }

  async initialize(): Promise<void> {
    await this.#opened;
    const result = await this.request("initialize", {
      clientInfo: { name: "session-atlas-bookmark-title", title: "Session Atlas", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    if (!isRecord(result)) throw failure();
    if (this.#failure || this.#socket.readyState !== WebSocket.OPEN) throw failure();
    this.#socket.send(JSON.stringify({ method: "initialized" }), (error) => {
      if (error) this.#fail();
    });
  }

  request(method: TitleMethod, params: Record<string, unknown>): Promise<unknown> {
    if (this.#failure || this.#pending || Date.now() >= this.#deadline || this.#socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(failure());
    }
    return new Promise((resolve, reject) => {
      const id = ++this.#nextId;
      this.#pending = { id, resolve, reject };
      this.#socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (error) this.#fail();
      });
    });
  }

  close(): void {
    clearTimeout(this.#timer);
    if (this.#socket.readyState !== WebSocket.CLOSED) this.#socket.terminate();
  }

  #fail(): void {
    if (this.#failure) return;
    this.#failure = failure();
    this.#rejectOpen(this.#failure);
    this.#pending?.reject(this.#failure);
    this.#pending = undefined;
  }

  #onMessage(data: RawData, isBinary: boolean): void {
    try {
      if (Date.now() >= this.#deadline) throw failure();
      if (isBinary) throw failure();
      const message: unknown = JSON.parse(data.toString());
      if (!isRecord(message)) throw failure();
      // Notifications and server requests never become Atlas events or stored content.
      if ("method" in message || message.id !== this.#pending?.id) return;
      const pending = this.#pending;
      if (!pending) return;
      if ("error" in message || !("result" in message)) throw failure();
      this.#pending = undefined;
      pending.resolve(message.result);
    } catch {
      this.#fail();
    }
  }
}

export class DaemonTitleClient implements BookmarkTitleClient {
  readonly #socketPath: string;
  readonly #timeoutMs: number;

  constructor(options: DaemonTitleClientOptions = {}) {
    this.#socketPath = options.socketPath ?? join(homedir(), ".codex/app-server-control/app-server-control.sock");
    this.#timeoutMs = options.timeoutMs ?? 3_000;
    if (!Number.isFinite(this.#timeoutMs) || this.#timeoutMs <= 0) throw failure();
  }

  async readName(threadId: string): Promise<string | undefined> {
    if (!threadId.trim()) return undefined;
    return this.#withConnection((connection) => this.#readName(connection, threadId));
  }

  async rename(threadId: string, expectedName: string, name: string): Promise<boolean> {
    if (!threadId.trim() || !expectedName.trim() || !name.trim()) return false;
    return this.#withConnection(async (connection) => {
      const currentName = await this.#readName(connection, threadId);
      if (currentName !== expectedName) return false;
      const result = await connection.request("thread/name/set", { threadId, name });
      if (!isRecord(result)) throw failure();
      return true;
    });
  }

  async #withConnection<T>(operation: (connection: TitleConnection) => Promise<T>): Promise<T> {
    let connection: TitleConnection | undefined;
    try {
      connection = new TitleConnection(this.#socketPath, this.#timeoutMs);
      await connection.initialize();
      return await operation(connection);
    } catch {
      throw failure();
    } finally {
      connection?.close();
    }
  }

  async #readName(connection: TitleConnection, threadId: string): Promise<string | undefined> {
    const result = await connection.request("thread/read", { threadId, includeTurns: false });
    if (!isRecord(result) || !isRecord(result.thread) || result.thread.id !== threadId) throw failure();
    const name = result.thread.name;
    if (name === null || name === undefined) return undefined;
    if (typeof name !== "string") throw failure();
    return name.trim() ? name : undefined;
  }
}
