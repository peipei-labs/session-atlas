import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { DaemonTitleClient } from "./daemon-titles.js";

interface Request {
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

const NO_RESPONSE = Symbol("no response");
const cleanups: Array<() => Promise<void>> = [];
const threadId = "saved-thread";
const errorMessage = "Codex daemon title request failed.";

async function daemon(
  handle: (request: Request, socket: WebSocket) => unknown | Promise<unknown>,
): Promise<{
  client: DaemonTitleClient;
  socketPath: string;
  requests: Request[];
  connectionCount: () => number;
  openConnectionCount: () => number;
}> {
  const directory = await mkdtemp(join(tmpdir(), "atlas-titles-"));
  const socketPath = join(directory, "daemon.sock");
  const http = createServer();
  const server = new WebSocketServer({ server: http });
  const requests: Request[] = [];
  let connections = 0;
  server.on("connection", (socket) => {
    connections += 1;
    socket.on("error", () => {});
    socket.on("message", async (data) => {
      const request = JSON.parse(data.toString()) as Request;
      requests.push(request);
      if (request.method === "initialized") return;
      const result = await handle(request, socket);
      if (result !== NO_RESPONSE && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ id: request.id, result }));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(socketPath, resolve);
  });
  cleanups.push(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  return {
    client: new DaemonTitleClient({ socketPath }),
    socketPath,
    requests,
    connectionCount: () => connections,
    openConnectionCount: () => server.clients.size,
  };
}

function normalResponse(request: Request, name: unknown = "Mobile logs"): unknown {
  if (request.method === "thread/read") return { thread: { id: threadId, name, status: { type: "notLoaded" } } };
  return {};
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("DaemonTitleClient", () => {
  it("reads and renames a notLoaded thread using only the title method allowlist", async () => {
    const fixture = await daemon((request) => normalResponse(request));

    await expect(fixture.client.readName(threadId)).resolves.toBe("Mobile logs");
    await expect(fixture.client.rename(threadId, "Mobile logs", "🔖 Mobile logs")).resolves.toBe(true);

    expect(fixture.connectionCount()).toBe(2);
    expect(fixture.requests.map((request) => request.method)).toEqual([
      "initialize", "initialized", "thread/read",
      "initialize", "initialized", "thread/read", "thread/name/set",
    ]);
    expect(fixture.requests[0]).toMatchObject({
      params: {
        clientInfo: { name: "session-atlas-bookmark-title", title: "Session Atlas", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      },
    });
    expect(fixture.requests[1]).toEqual({ method: "initialized" });
    expect(fixture.requests.filter((request) => request.method === "thread/read")).toEqual([
      { id: 2, method: "thread/read", params: { threadId, includeTurns: false } },
      { id: 2, method: "thread/read", params: { threadId, includeTurns: false } },
    ]);
    expect(fixture.requests.at(-1)).toMatchObject({
      method: "thread/name/set", params: { threadId, name: "🔖 Mobile logs" },
    });
    await expect.poll(fixture.openConnectionCount).toBe(0);
  });

  it.each([null, undefined, "", "   "])("does not invent a name for %s", async (name) => {
    const fixture = await daemon((request) => request.method === "thread/read"
      ? { thread: { id: threadId, name } }
      : normalResponse(request));

    await expect(fixture.client.readName(threadId)).resolves.toBeUndefined();
    await expect(fixture.client.rename(threadId, "Mobile logs", "🔖 Mobile logs")).resolves.toBe(false);
    expect(fixture.requests.some((request) => request.method === "thread/name/set")).toBe(false);
  });

  it("preserves a name changed after the caller read it", async () => {
    let name = "Mobile logs";
    const fixture = await daemon((request) => normalResponse(request, name));
    await expect(fixture.client.readName(threadId)).resolves.toBe(name);
    name = "User renamed this thread";

    await expect(fixture.client.rename(threadId, "Mobile logs", "🔖 Mobile logs")).resolves.toBe(false);
    expect(fixture.requests.some((request) => request.method === "thread/name/set")).toBe(false);
  });

  it("discards notifications, server requests, and unrelated responses", async () => {
    const fixture = await daemon((request, socket) => {
      socket.send(JSON.stringify({ method: "thread/name/updated", params: { privateContent: "fixture content" } }));
      socket.send(JSON.stringify({ id: request.id, method: "item/tool/requestUserInput", params: { privateContent: "fixture content" } }));
      socket.send(JSON.stringify({ id: 99_999, result: { privateContent: "fixture content" } }));
      return normalResponse(request);
    });

    await expect(fixture.client.rename(threadId, "Mobile logs", "🔖 Mobile logs")).resolves.toBe(true);
    expect(fixture.requests.map((request) => request.method)).toEqual([
      "initialize", "initialized", "thread/read", "thread/name/set",
    ]);
  });

  it("refuses a read response for a different thread", async () => {
    const fixture = await daemon((request) => request.method === "thread/read"
      ? { thread: { id: "different-thread", name: "Mobile logs" } }
      : normalResponse(request));

    await expect(fixture.client.rename(threadId, "Mobile logs", "🔖 Mobile logs")).rejects.toThrow(errorMessage);
    expect(fixture.requests.some((request) => request.method === "thread/name/set")).toBe(false);
  });

  it("sanitizes remote errors and closes the connection", async () => {
    const fixture = await daemon((request, socket) => {
      socket.send(JSON.stringify({ id: request.id, error: { code: -1, message: "fixture private diagnostic", data: "fixture private content" } }));
      return NO_RESPONSE;
    });

    await expect(fixture.client.readName(threadId)).rejects.toEqual(new Error(errorMessage));
    await expect.poll(fixture.openConnectionCount).toBe(0);
  });

  it("sanitizes connection failure without exposing the socket path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atlas-titles-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const client = new DaemonTitleClient({ socketPath: join(directory, "absent-private.sock") });

    await expect(client.readName(threadId)).rejects.toEqual(new Error(errorMessage));
  });

  it.each([
    { method: "thread/read", message: "Unknown thread: private fixture id" },
    { method: "thread/name/set", message: "Cannot rename archived thread: private fixture id" },
  ])("sanitizes unavailable-thread errors from $method", async ({ method, message }) => {
    const fixture = await daemon((request, socket) => {
      if (request.method !== method) return normalResponse(request);
      socket.send(JSON.stringify({ id: request.id, error: { code: -1, message } }));
      return NO_RESPONSE;
    });

    await expect(fixture.client.rename(threadId, "Mobile logs", "🔖 Mobile logs")).rejects.toEqual(new Error(errorMessage));
    expect(fixture.requests.map((request) => request.method)).toEqual(method === "thread/read"
      ? ["initialize", "initialized", "thread/read"]
      : ["initialize", "initialized", "thread/read", "thread/name/set"]);
    await expect.poll(fixture.openConnectionCount).toBe(0);
  });

  it("uses one absolute deadline across requests and never sends a late rename", async () => {
    const fixture = await daemon(async (request) => {
      await delay(70);
      return normalResponse(request);
    });
    const client = new DaemonTitleClient({ socketPath: fixture.socketPath, timeoutMs: 110 });

    await expect(client.rename(threadId, "Mobile logs", "🔖 Mobile logs")).rejects.toEqual(new Error(errorMessage));
    expect(fixture.requests.some((request) => request.method === "thread/name/set")).toBe(false);
    await expect.poll(fixture.openConnectionCount).toBe(0);
  });

  it("bounds waiting for a missing response", async () => {
    const fixture = await daemon(() => NO_RESPONSE);
    const client = new DaemonTitleClient({ socketPath: fixture.socketPath, timeoutMs: 50 });

    await expect(client.readName(threadId)).rejects.toEqual(new Error(errorMessage));
    await expect.poll(fixture.openConnectionCount).toBe(0);
  });

  it("bounds the Unix socket WebSocket handshake", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atlas-titles-"));
    const socketPath = join(directory, "daemon.sock");
    const http = createServer();
    const connections = new Set<Duplex>();
    http.on("upgrade", (_request, socket) => {
      connections.add(socket);
      socket.once("close", () => connections.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(socketPath, resolve);
    });
    cleanups.push(async () => {
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    });
    const client = new DaemonTitleClient({ socketPath, timeoutMs: 50 });

    await expect(client.readName(threadId)).rejects.toEqual(new Error(errorMessage));
  });

  it.each(["not-json", JSON.stringify({ method: "notification", params: "x".repeat(1024 * 1024) })])(
    "rejects malformed or oversized messages without exposing their contents",
    async (message) => {
      const fixture = await daemon((_request, socket) => {
        socket.send(message);
        return NO_RESPONSE;
      });

      await expect(fixture.client.readName(threadId)).rejects.toEqual(new Error(errorMessage));
      await expect.poll(fixture.openConnectionCount).toBe(0);
    },
  );
});
