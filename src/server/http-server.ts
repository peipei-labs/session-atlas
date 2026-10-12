import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, resolve } from "node:path";

import type {
  ApiError,
  AutoResumePreflightInput,
  CreateThreadInput,
  RecoveryPreviewsInput,
  RespondRequestInput,
  RestoreRecoveriesInput,
  SessionAtlasEvent,
  UpdateAttentionInput,
  UpdateThreadTagsInput,
} from "../shared/types.js";
import type { ServerConfig } from "./config.js";
import type { SessionAtlasController } from "./controller.js";
import { AppError, asAppError } from "./errors.js";
import { sampleMemory } from "./process-memory.js";
import { isPathInside } from "./project-path.js";
import { parseHandoffVersion, parseUpsertHandoffInput } from "./handoff.js";

interface FrontendHandler {
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
  close(): Promise<void>;
}

export interface SessionAtlasHttpApplication {
  server: Server;
  listen(): Promise<void>;
  close(): Promise<void>;
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const HANDOFF_MAX_JSON_BYTES = 256 * 1024;
const CONTINUATION_PREPARE_TIMEOUT_MS = 6_000;
const RESUME_PREPARE_TIMEOUT_MS = 12_000;
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new AppError(400, "VALIDATION_ERROR", "The request contains unsupported fields.");
  }
}

function requiredText(
  value: unknown,
  name: string,
  maxLength: number,
  allowEmpty = false,
): string {
  if (typeof value !== "string") {
    throw new AppError(400, "VALIDATION_ERROR", `${name} must be a string.`);
  }
  const normalized = value.trim();
  if (!allowEmpty && normalized.length === 0) {
    throw new AppError(400, "VALIDATION_ERROR", `${name} must not be empty.`);
  }
  if (value.length > maxLength) {
    throw new AppError(400, "VALIDATION_ERROR", `${name} is too long.`);
  }
  return allowEmpty ? value : normalized;
}

function optionalText(value: unknown, name: string, maxLength: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requiredText(value, name, maxLength);
}

function parseCreateThread(value: unknown): CreateThreadInput {
  if (!isRecord(value)) {
    throw new AppError(400, "VALIDATION_ERROR", "Request body must be a JSON object.");
  }
  assertOnlyKeys(value, ["cwd", "title", "prompt"]);
  return {
    cwd: requiredText(value.cwd, "cwd", 4_096),
    title: optionalText(value.title, "title", 120),
    prompt: optionalText(value.prompt, "prompt", 60_000),
  };
}

function parseMessage(value: unknown): { text: string } {
  if (!isRecord(value)) {
    throw new AppError(400, "VALIDATION_ERROR", "Request body must be a JSON object.");
  }
  assertOnlyKeys(value, ["text"]);
  return { text: requiredText(value.text, "text", 60_000) };
}

function parseResponse(value: unknown): RespondRequestInput {
  if (!isRecord(value)) {
    throw new AppError(400, "VALIDATION_ERROR", "Request body must be a JSON object.");
  }
  assertOnlyKeys(value, ["choiceId", "text"]);
  return {
    choiceId: requiredText(value.choiceId, "choiceId", 200),
    text: optionalText(value.text, "text", 60_000),
  };
}

function parseAttention(value: unknown): UpdateAttentionInput {
  if (!isRecord(value)) {
    throw new AppError(400, "VALIDATION_ERROR", "Request body must be a JSON object.");
  }
  assertOnlyKeys(value, ["pinned", "parked", "acknowledge", "title"]);
  if (Object.keys(value).length === 0) {
    throw new AppError(400, "VALIDATION_ERROR", "At least one attention field is required.");
  }
  for (const name of ["pinned", "parked", "acknowledge"] as const) {
    if (value[name] !== undefined && typeof value[name] !== "boolean") {
      throw new AppError(400, "VALIDATION_ERROR", `${name} must be a boolean.`);
    }
  }
  if (value.title !== undefined && typeof value.title !== "string") {
    throw new AppError(400, "VALIDATION_ERROR", "title must be a string.");
  }
  if (typeof value.title === "string" && value.title.length > 120) {
    throw new AppError(400, "VALIDATION_ERROR", "title is too long.");
  }
  return {
    pinned: value.pinned as boolean | undefined,
    parked: value.parked as boolean | undefined,
    acknowledge: value.acknowledge as boolean | undefined,
    title: value.title as string | undefined,
  };
}

function parseRestoreRecoveries(value: unknown): RestoreRecoveriesInput {
  if (!isRecord(value)) {
    throw new AppError(400, "VALIDATION_ERROR", "Request body must be a JSON object.");
  }
  assertOnlyKeys(value, ["sessionIds"]);
  if (!Array.isArray(value.sessionIds) || value.sessionIds.length === 0) {
    throw new AppError(400, "VALIDATION_ERROR", "sessionIds must contain at least one item.");
  }
  if (value.sessionIds.length > 32) {
    throw new AppError(400, "VALIDATION_ERROR", "At most 32 sessions can be restored at once.");
  }
  const sessionIds = value.sessionIds.map((sessionId) =>
    requiredText(sessionId, "sessionId", 64),
  );
  if (new Set(sessionIds).size !== sessionIds.length) {
    throw new AppError(400, "VALIDATION_ERROR", "sessionIds must be unique.");
  }
  return { sessionIds };
}

function parseRecoveryPreviews(value: unknown): RecoveryPreviewsInput {
  if (!isRecord(value)) {
    throw new AppError(400, "VALIDATION_ERROR", "Request body must be a JSON object.");
  }
  assertOnlyKeys(value, ["sessionIds"]);
  if (!Array.isArray(value.sessionIds) || value.sessionIds.length === 0) {
    throw new AppError(400, "VALIDATION_ERROR", "sessionIds must contain at least one item.");
  }
  if (value.sessionIds.length > 100) {
    throw new AppError(400, "VALIDATION_ERROR", "At most 100 session previews can be read at once.");
  }
  const sessionIds = value.sessionIds.map((sessionId) =>
    requiredText(sessionId, "sessionId", 64),
  );
  if (sessionIds.some((sessionId) => !SESSION_ID_PATTERN.test(sessionId))) {
    throw new AppError(400, "VALIDATION_ERROR", "Preview session IDs must be UUIDs.");
  }
  if (new Set(sessionIds).size !== sessionIds.length) {
    throw new AppError(400, "VALIDATION_ERROR", "sessionIds must be unique.");
  }
  return { sessionIds };
}

function parseAutoResumePreflight(value: unknown): AutoResumePreflightInput {
  if (!isRecord(value)) {
    throw new AppError(400, "VALIDATION_ERROR", "Request body must be a JSON object.");
  }
  assertOnlyKeys(value, ["conversationId", "terminalSessionId"]);
  const conversationId = requiredText(value.conversationId, "conversationId", 64);
  const terminalSessionId = requiredText(value.terminalSessionId, "terminalSessionId", 64);
  if (!SESSION_ID_PATTERN.test(conversationId) || !SESSION_ID_PATTERN.test(terminalSessionId)) {
    throw new AppError(400, "VALIDATION_ERROR", "Preflight session IDs must be UUIDs.");
  }
  return { conversationId, terminalSessionId };
}

function decodeSegment(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded || decoded.length > 500 || decoded.includes("/")) {
      throw new Error("invalid segment");
    }
    return decoded;
  } catch {
    throw new AppError(400, "INVALID_PATH", "The request path is invalid.");
  }
}

function localHostHeader(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  try {
    const parsed = new URL(`http://${value}`);
    return !parsed.username && !parsed.password && LOCAL_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

function requestPort(request: IncomingMessage): string {
  try {
    return new URL(`http://${request.headers.host}`).port;
  } catch {
    return "";
  }
}

function validateRequestSource(request: IncomingMessage): void {
  if (!localHostHeader(request.headers.host)) {
    throw new AppError(403, "INVALID_HOST", "Requests must use a loopback Host header.");
  }
  const isTopLevelNavigation =
    request.method === "GET" &&
    request.headers["sec-fetch-mode"] === "navigate" &&
    request.headers["sec-fetch-dest"] === "document";
  if (request.headers["sec-fetch-site"] === "cross-site" && !isTopLevelNavigation) {
    throw new AppError(403, "FORBIDDEN_ORIGIN", "Cross-site requests are not accepted.");
  }
  const origin = request.headers.origin;
  if (!origin) {
    return;
  }
  try {
    const parsed = new URL(origin);
    if (
      parsed.protocol !== "http:" ||
      !LOCAL_HOSTS.has(parsed.hostname) ||
      parsed.port !== requestPort(request)
    ) {
      throw new Error("origin mismatch");
    }
  } catch {
    throw new AppError(403, "FORBIDDEN_ORIGIN", "The request Origin is not trusted.");
  }
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new AppError(415, "JSON_REQUIRED", "Mutating requests require application/json.");
  }
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new AppError(413, "PAYLOAD_TOO_LARGE", "The JSON request body is too large.");
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) {
      throw new AppError(413, "PAYLOAD_TOO_LARGE", "The JSON request body is too large.");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    throw new AppError(400, "INVALID_JSON", "A JSON request body is required.");
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw new AppError(400, "INVALID_JSON", "The request body is not valid JSON.", {
      cause: error,
    });
  }
}

function apiHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  apiHeaders(response);
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}

function sendError(response: ServerResponse, error: unknown): void {
  const appError = asAppError(error);
  const body: ApiError = { error: { code: appError.code, message: appError.message } };
  sendJson(response, appError.status, body);
}

async function continuationAction<T>(response: ServerResponse, action: (signal: AbortSignal) => Promise<T>, timeoutMs = CONTINUATION_PREPARE_TIMEOUT_MS): Promise<T> {
  const disconnected = new AbortController();
  const onClose = () => { if (!response.writableEnded) disconnected.abort(); };
  response.on("close", onClose);
  if (response.destroyed) disconnected.abort();
  const timer = setTimeout(() => disconnected.abort(), timeoutMs);
  timer.unref();
  try { return await action(disconnected.signal); }
  finally {
    clearTimeout(timer);
    response.off("close", onClose);
  }
}

class ApiRouter {
  readonly controller: SessionAtlasController;
  readonly config: ServerConfig;
  #streams = new Set<ServerResponse>();

  constructor(controller: SessionAtlasController, config: ServerConfig) {
    this.controller = controller;
    this.config = config;
  }

  async handle(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> {
    if (!pathname.startsWith("/api/")) {
      return false;
    }

    try {
      validateRequestSource(request);
      if (request.method === "GET" && pathname === "/api/memory") {
        sendJson(response, 200, await sampleMemory(this.controller.snapshot().sessions));
        return true;
      }
      if (request.method === "GET" && pathname === "/api/sessions") {
        sendJson(response, 200, this.controller.snapshot());
        return true;
      }
      if (request.method === "GET" && pathname === "/api/events") {
        this.#openEventStream(request, response);
        return true;
      }
      const handoffMatch = /^\/api\/handoffs\/([^/]+)$/.exec(pathname);
      if (handoffMatch?.[1]) {
        const id = decodeSegment(handoffMatch[1]);
        if (request.method === "GET") {
          sendJson(response, 200, this.controller.readHandoff(id));
          return true;
        }
        if (request.method === "PUT") {
          const record = await this.controller.upsertHandoff(id, parseUpsertHandoffInput(await readJson(request, Math.max(this.config.maxJsonBytes, HANDOFF_MAX_JSON_BYTES))));
          sendJson(response, 200, record);
          return true;
        }
        if (request.method === "DELETE") {
          const body = await readJson(request, this.config.maxJsonBytes);
          if (!isRecord(body)) throw new AppError(400, "VALIDATION_ERROR", "Request body must be an object.");
          assertOnlyKeys(body, ["expectedVersion"]);
          await this.controller.removeHandoff(id, parseHandoffVersion(body.expectedVersion));
          apiHeaders(response);
          response.writeHead(204).end();
          return true;
        }
      }
      const threadTagsMatch = /^\/api\/threads\/([^/]+)\/tags$/.exec(pathname);
      if (threadTagsMatch?.[1]) {
        const id = decodeSegment(threadTagsMatch[1]);
        if (request.method === "GET") {
          sendJson(response, 200, await this.controller.readThreadTags(id));
          return true;
        }
        if (request.method === "PATCH") {
          const body = await readJson(request, this.config.maxJsonBytes);
          sendJson(response, 200, await this.controller.updateThreadTags(id, body as UpdateThreadTagsInput));
          return true;
        }
      }
      const titleMarkerMatch = /^\/api\/handoffs\/([^/]+)\/title-marker$/.exec(pathname);
      if (request.method === "POST" && titleMarkerMatch?.[1]) {
        const body = await readJson(request, this.config.maxJsonBytes);
        if (!isRecord(body)) throw new AppError(400, "VALIDATION_ERROR", "Request body must be an object.");
        assertOnlyKeys(body, []);
        sendJson(response, 200, await this.controller.syncBookmarkTitleMarker(decodeSegment(titleMarkerMatch[1])));
        return true;
      }
      const handoffActionMatch = /^\/api\/handoffs\/([^/]+)\/(close|resume)$/.exec(pathname);
      if (request.method === "POST" && handoffActionMatch?.[1]) {
        const body = await readJson(request, this.config.maxJsonBytes);
        if (!isRecord(body)) throw new AppError(400, "VALIDATION_ERROR", "Request body must be an object.");
        assertOnlyKeys(body, handoffActionMatch[2] === "close" ? ["terminalSessionId"] : ["cwd"]);
        const id = decodeSegment(handoffActionMatch[1]);
        const result = await continuationAction(response, async (signal) => handoffActionMatch[2] === "close"
          ? await this.controller.closeHandoff(id, optionalText(body.terminalSessionId, "terminalSessionId", 512), signal)
          : await this.controller.resumeHandoff(id, signal, optionalText(body.cwd, "cwd", 4096)),
          handoffActionMatch[2] === "resume" ? RESUME_PREPARE_TIMEOUT_MS : CONTINUATION_PREPARE_TIMEOUT_MS);
        sendJson(response, 200, result);
        return true;
      }
      const parkMatch = /^\/api\/terminals\/([^/]+)\/park$/.exec(pathname);
      if (request.method === "POST" && parkMatch?.[1]) {
        const body = await readJson(request, this.config.maxJsonBytes);
        if (!isRecord(body) || Object.keys(body).length !== 0) throw new AppError(400, "VALIDATION_ERROR", "park expects an empty object.");
        sendJson(response, 200, await continuationAction(response, (signal) => this.controller.parkTerminal(decodeSegment(parkMatch[1]!), signal)));
        return true;
      }
      const recoveryOpenMatch = /^\/api\/recoveries\/([^/]+)\/open$/.exec(pathname);
      if (request.method === "POST" && recoveryOpenMatch?.[1]) {
        const body = await readJson(request, this.config.maxJsonBytes);
        if (!isRecord(body)) throw new AppError(400, "VALIDATION_ERROR", "Request body must be an object.");
        assertOnlyKeys(body, ["cwd"]);
        const id = decodeSegment(recoveryOpenMatch[1]);
        const result = await continuationAction(response, (signal) => this.controller.openRecovery(id, signal, optionalText(body.cwd, "cwd", 4096)), RESUME_PREPARE_TIMEOUT_MS);
        sendJson(response, 200, result);
        return true;
      }
      if (request.method === "POST" && pathname === "/api/threads") {
        const created = await this.controller.createThread(
          parseCreateThread(await readJson(request, this.config.maxJsonBytes)),
        );
        sendJson(response, 201, created);
        return true;
      }
      if (request.method === "POST" && pathname === "/api/recoveries/preflight") {
        const result = await this.controller.preflightAutoResume(
          parseAutoResumePreflight(await readJson(request, this.config.maxJsonBytes)),
        );
        sendJson(response, 200, result);
        return true;
      }
      if (request.method === "POST" && pathname === "/api/recoveries/disarm") {
        await readJson(request, this.config.maxJsonBytes).then((body) => {
          if (!isRecord(body) || Object.keys(body).length !== 0) {
            throw new AppError(400, "VALIDATION_ERROR", "disarm expects an empty JSON object.");
          }
        });
        sendJson(response, 200, await this.controller.disarmAutoResume());
        return true;
      }
      if (request.method === "POST" && pathname === "/api/recoveries/previews") {
        const abortController = new AbortController();
        const abortOnDisconnect = () => {
          if (!response.writableEnded) abortController.abort();
        };
        request.once("aborted", abortOnDisconnect);
        response.once("close", abortOnDisconnect);
        try {
          const result = await this.controller.readRecoveryPreviews(
            parseRecoveryPreviews(await readJson(request, this.config.maxJsonBytes)),
            abortController.signal,
          );
          sendJson(response, 200, result);
        } finally {
          request.off("aborted", abortOnDisconnect);
          response.off("close", abortOnDisconnect);
        }
        return true;
      }
      if (request.method === "POST" && pathname === "/api/recoveries/restore") {
        const restored = await this.controller.restoreRecoveries(
          parseRestoreRecoveries(await readJson(request, this.config.maxJsonBytes)),
        );
        sendJson(response, 202, restored);
        return true;
      }

      const detailMatch = /^\/api\/sessions\/([^/]+)\/detail$/.exec(pathname);
      if (request.method === "GET" && detailMatch?.[1]) {
        const detail = await this.controller.readSessionDetail(decodeSegment(detailMatch[1]));
        sendJson(response, 200, detail);
        return true;
      }

      const focusMatch = /^\/api\/sessions\/([^/]+)\/focus$/.exec(pathname);
      if (request.method === "POST" && focusMatch?.[1]) {
        await readJson(request, this.config.maxJsonBytes).then((body) => {
          if (!isRecord(body) || Object.keys(body).length !== 0) {
            throw new AppError(400, "VALIDATION_ERROR", "focus expects an empty JSON object.");
          }
        });
        await this.controller.focus(decodeSegment(focusMatch[1]));
        sendJson(response, 200, { ok: true });
        return true;
      }

      const restoreLayoutMatch = /^\/api\/layouts\/([^/]+)\/restore$/.exec(pathname);
      if (request.method === "POST" && restoreLayoutMatch?.[1]) {
        await readJson(request, this.config.maxJsonBytes).then((body) => {
          if (!isRecord(body) || Object.keys(body).length !== 0) {
            throw new AppError(400, "VALIDATION_ERROR", "restore expects an empty JSON object.");
          }
        });
        await this.controller.restoreWindowLayout(decodeSegment(restoreLayoutMatch[1]));
        sendJson(response, 202, { ok: true });
        return true;
      }

      const messageMatch = /^\/api\/sessions\/([^/]+)\/messages$/.exec(pathname);
      if (request.method === "POST" && messageMatch?.[1]) {
        const input = parseMessage(await readJson(request, this.config.maxJsonBytes));
        await this.controller.sendMessage(decodeSegment(messageMatch[1]), input.text);
        sendJson(response, 202, { ok: true });
        return true;
      }

      const interruptMatch = /^\/api\/sessions\/([^/]+)\/interrupt$/.exec(pathname);
      if (request.method === "POST" && interruptMatch?.[1]) {
        await readJson(request, this.config.maxJsonBytes).then((body) => {
          if (!isRecord(body) || Object.keys(body).length !== 0) {
            throw new AppError(400, "VALIDATION_ERROR", "interrupt expects an empty JSON object.");
          }
        });
        await this.controller.interrupt(decodeSegment(interruptMatch[1]));
        sendJson(response, 202, { ok: true });
        return true;
      }

      const requestMatch =
        /^\/api\/sessions\/([^/]+)\/requests\/([^/]+)\/respond$/.exec(pathname);
      if (request.method === "POST" && requestMatch?.[1] && requestMatch[2]) {
        const input = parseResponse(await readJson(request, this.config.maxJsonBytes));
        await this.controller.respondRequest(
          decodeSegment(requestMatch[1]),
          decodeSegment(requestMatch[2]),
          input,
        );
        sendJson(response, 202, { ok: true });
        return true;
      }

      const attentionMatch = /^\/api\/sessions\/([^/]+)\/attention$/.exec(pathname);
      if (request.method === "PATCH" && attentionMatch?.[1]) {
        const input = parseAttention(await readJson(request, this.config.maxJsonBytes));
        const session = await this.controller.updateAttention(
          decodeSegment(attentionMatch[1]),
          input,
        );
        sendJson(response, 200, session);
        return true;
      }

      const knownPath =
        pathname === "/api/memory" ||
        pathname === "/api/sessions" ||
        pathname === "/api/events" ||
        pathname === "/api/threads" ||
        pathname === "/api/recoveries/preflight" ||
        pathname === "/api/recoveries/disarm" ||
        pathname === "/api/recoveries/previews" ||
        pathname === "/api/recoveries/restore" ||
        handoffMatch || handoffActionMatch || titleMarkerMatch || parkMatch || recoveryOpenMatch || threadTagsMatch ||
        detailMatch ||
        focusMatch ||
        restoreLayoutMatch ||
        messageMatch ||
        interruptMatch ||
        requestMatch ||
        attentionMatch;
      if (knownPath) {
        response.setHeader("Allow", allowedMethods(pathname));
        throw new AppError(405, "METHOD_NOT_ALLOWED", "The HTTP method is not allowed here.");
      }
      throw new AppError(404, "API_NOT_FOUND", "The API endpoint was not found.");
    } catch (error) {
      if (!response.headersSent) {
        sendError(response, error);
      } else {
        response.end();
      }
      return true;
    }
  }

  close(): void {
    for (const stream of this.#streams) {
      stream.end();
    }
    this.#streams.clear();
  }

  #openEventStream(request: IncomingMessage, response: ServerResponse): void {
    apiHeaders(response);
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders();
    this.#streams.add(response);
    let backpressured = false;
    let snapshotPending = false;

    const write = (event: SessionAtlasEvent): void => {
      if (response.destroyed) return;
      if (backpressured) {
        snapshotPending = true;
        return;
      }
      backpressured = !response.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const onDrain = (): void => {
      backpressured = false;
      if (!snapshotPending || response.destroyed) return;
      snapshotPending = false;
      write({ type: "snapshot", snapshot: this.controller.snapshot() });
    };
    response.on("drain", onDrain);
    write({ type: "snapshot", snapshot: this.controller.snapshot() });
    const unsubscribe = this.controller.registry.subscribe(write);
    const heartbeat = setInterval(() => {
      if (!response.destroyed && !backpressured) {
        response.write(": heartbeat\n\n");
      }
    }, 15_000);
    heartbeat.unref();

    response.once("close", () => {
      clearInterval(heartbeat);
      response.off("drain", onDrain);
      unsubscribe();
      this.#streams.delete(response);
    });
  }
}

function allowedMethods(pathname: string): string {
  if (/^\/api\/threads\/[^/]+\/tags$/.test(pathname)) return "GET, PATCH";
  if (/^\/api\/handoffs\/[^/]+$/.test(pathname)) return "GET, PUT, DELETE";
  if (/^\/api\/recoveries\/[^/]+\/open$/.test(pathname)) return "POST";
  if (
    pathname === "/api/memory" ||
    pathname === "/api/sessions" ||
    pathname === "/api/events" ||
    pathname.endsWith("/detail")
  ) {
    return "GET";
  }
  if (pathname.endsWith("/attention")) {
    return "PATCH";
  }
  return "POST";
}

function mimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

async function createStaticFrontend(config: ServerConfig): Promise<FrontendHandler> {
  return {
    async handle(request, response) {
      validateRequestSource(request);
      if (request.method !== "GET" && request.method !== "HEAD") {
        throw new AppError(405, "METHOD_NOT_ALLOWED", "Only GET and HEAD are supported.");
      }
      const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
      let pathname: string;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        throw new AppError(400, "INVALID_PATH", "The request path is invalid.");
      }
      const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      let filePath = resolve(config.staticDir, relativePath);
      if (!isPathInside(filePath, config.staticDir)) {
        throw new AppError(403, "INVALID_PATH", "The request path is invalid.");
      }

      let details;
      try {
        details = await stat(filePath);
      } catch {
        filePath = resolve(config.staticDir, "index.html");
        details = await stat(filePath).catch(() => undefined);
      }
      if (!details?.isFile()) {
        throw new AppError(404, "ASSET_NOT_FOUND", "The frontend asset was not found.");
      }

      response.statusCode = 200;
      response.setHeader("Content-Type", mimeType(filePath));
      response.setHeader("Content-Length", details.size);
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'",
      );
      response.setHeader(
        "Cache-Control",
        filePath.endsWith("index.html") ? "no-store" : "public, max-age=3600",
      );
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      await new Promise<void>((resolveStream, rejectStream) => {
        const stream = createReadStream(filePath);
        stream.once("error", rejectStream);
        response.once("finish", resolveStream);
        stream.pipe(response);
      });
    },
    async close() {},
  };
}

async function createViteFrontend(config: ServerConfig): Promise<FrontendHandler> {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    root: resolve(config.staticDir, "../.."),
    appType: "spa",
    server: { middlewareMode: true },
  });
  return {
    handle(request, response) {
      validateRequestSource(request);
      return new Promise((resolveRequest, rejectRequest) => {
        vite.middlewares(request, response, (error?: unknown) => {
          if (error) {
            rejectRequest(error);
          } else if (!response.writableEnded) {
            sendError(response, new AppError(404, "ASSET_NOT_FOUND", "The page was not found."));
            resolveRequest();
          } else {
            resolveRequest();
          }
        });
        response.once("finish", resolveRequest);
      });
    },
    async close() {
      await vite.close();
    },
  };
}

export async function createSessionAtlasHttpApplication(
  controller: SessionAtlasController,
  config: ServerConfig,
): Promise<SessionAtlasHttpApplication> {
  const api = new ApiRouter(controller, config);
  const frontend = config.development
    ? await createViteFrontend(config)
    : await createStaticFrontend(config);
  const server = createServer((request, response) => {
    void (async () => {
      try {
        validateRequestSource(request);
        if (!request.url?.startsWith("/")) {
          throw new AppError(400, "INVALID_PATH", "The request path is invalid.");
        }
        const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "invalid"}`);
        if (await api.handle(request, response, url.pathname)) {
          return;
        }
        await frontend.handle(request, response);
      } catch (error) {
        if (!response.headersSent) {
          sendError(response, error);
        } else {
          response.end();
        }
      }
    })();
  });

  return {
    server,
    listen() {
      return new Promise((resolveListen, rejectListen) => {
        const onError = (error: Error): void => rejectListen(error);
        server.once("error", onError);
        server.listen(config.port, config.host, () => {
          server.off("error", onError);
          resolveListen();
        });
      });
    },
    async close() {
      api.close();
      await frontend.close();
      if (!server.listening) {
        return;
      }
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
    },
  };
}
