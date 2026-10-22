import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { CodexAppServerClient, CodexReadOnlyError, type CodexClientEvent, type CodexAppServerClientOptions } from "./client.js";

const fixture = fileURLToPath(new URL("./__fixtures__/fake-codex.mjs", import.meta.url));
const clients: CodexAppServerClient[] = [];

function createClient(env: NodeJS.ProcessEnv = {}, options: Partial<CodexAppServerClientOptions> = {}): CodexAppServerClient {
  const client = new CodexAppServerClient({
    executable: process.execPath,
    compatibilityProbe: async () => ({
      executable: process.execPath,
      version: env.FAKE_CODEX_VERSION ?? "0.148.7",
      compatible: env.FAKE_COMPATIBLE !== "0",
      ...(env.FAKE_COMPATIBLE === "0" ? { reason: "Changed contract: turn/start.input" } : {}),
    }),
    appServerArgs: [fixture],
    env,
    requestTimeoutMs: 2_000,
    ...options,
  });
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.stop()));
});

describe("CodexAppServerClient", () => {
  it("handshakes, correlates concurrent requests, and sends supported turn methods", async () => {
    const client = createClient();
    await client.start();

    expect(client.state).toBe("running");
    expect(client.version).toBe("0.148.7");
    expect(client.writable).toBe(true);
    expect(client.initializeResult?.platformOs).toBe("macos");

    const [listed, read] = await Promise.all([client.threadList(), client.threadRead("thread-1", true)]);
    expect(listed.data[0]?.id).toBe("thread-1");
    expect(read.thread.id).toBe("thread-1");
    expect(
      (
        await client.threadTurnsList({
          threadId: "thread-1",
          limit: 1,
          sortDirection: "desc",
          itemsView: "full",
        })
      ).data[0]?.id,
    ).toBe("turn-1");
    expect(
      (
        await client.threadItemsList({
          threadId: "thread-1",
          turnId: "turn-1",
          limit: 50,
          sortDirection: "desc",
        })
      ).data[0]?.turnId,
    ).toBe("turn-1");
    expect((await client.threadLoadedList()).data).toEqual(["thread-1"]);
    expect((await client.threadStart({ cwd: "/tmp/fixture-project" })).thread.id).toBe("thread-1");
    expect((await client.turnStart("thread-1", "do work")).turn.id).toBe("turn-1");
    expect((await client.turnSteer("thread-1", "turn-1", "add this")).turnId).toBe("turn-1");
    await expect(client.turnInterrupt("thread-1", "turn-1")).resolves.toBeUndefined();
  });

  it("keeps 0.149.x writable after the additive protocol update", async () => {
    const client = createClient({ FAKE_CODEX_VERSION: "0.149.0" });
    await client.start();

    expect(client.version).toBe("0.149.0");
    expect(client.writable).toBe(true);
    await expect(client.turnStart("thread-1", "supported write")).resolves.toMatchObject({
      turn: { id: "turn-1" },
    });
  });

  it("accepts a compatible contract on 0.150.x writable", async () => {
    const client = createClient({ FAKE_CODEX_VERSION: "0.150.1" });
    await client.start();

    expect(client.version).toBe("0.150.1");
    expect(client.writable).toBe(true);
    await expect(client.turnStart("thread-1", "supported write")).resolves.toMatchObject({
      turn: { id: "turn-1" },
    });
  });

  it("accepts a compatible contract on 0.152.x writable", async () => {
    const client = createClient({ FAKE_CODEX_VERSION: "0.152.0" });
    await client.start();

    expect(client.version).toBe("0.152.0");
    expect(client.writable).toBe(true);
    await expect(client.turnStart("thread-1", "supported write")).resolves.toMatchObject({
      turn: { id: "turn-1" },
    });
  });

  it("accepts a compatible contract on 0.153.x writable", async () => {
    const client = createClient({ FAKE_CODEX_VERSION: "0.153.2" });
    await client.start();

    expect(client.version).toBe("0.153.2");
    expect(client.writable).toBe(true);
    await expect(client.turnStart("thread-1", "supported write")).resolves.toMatchObject({
      turn: { id: "turn-1" },
    });
  });

  it("accepts a compatible contract on 0.154.x writable", async () => {
    const client = createClient({ FAKE_CODEX_VERSION: "0.154.0" });
    await client.start();

    expect(client.version).toBe("0.154.0");
    expect(client.writable).toBe(true);
    await expect(client.turnStart("thread-1", "supported write")).resolves.toMatchObject({
      turn: { id: "turn-1" },
    });
  });

  it("allows inventory reads but fails closed for an incompatible contract", async () => {
    const client = createClient({ FAKE_CODEX_VERSION: "0.999.0", FAKE_COMPATIBLE: "0" });
    await client.start();

    expect(client.writable).toBe(false);
    await expect(client.threadList()).resolves.toMatchObject({ data: [{ id: "thread-1" }] });
    await expect(client.turnStart("thread-1", "must not be sent")).rejects.toBeInstanceOf(
      CodexReadOnlyError,
    );
  });

  it("automatically accepts an unknown future version when its contract and handshake pass", async () => {
    const client = createClient({ FAKE_CODEX_VERSION: "1.999.42" });
    await client.start();
    expect(client.writable).toBe(true);
    await expect(client.turnStart("thread-1", "fixture only")).resolves.toMatchObject({ turn: { id: "turn-1" } });
  });

  it("keeps writes disabled when the checked and running versions differ", async () => {
    const client = createClient({}, {
      compatibilityProbe: async () => ({ executable: process.execPath, version: "0.163.0", compatible: true }),
    });
    await client.start();
    expect(client.writable).toBe(false);
    expect(client.compatibilityReason).toContain("differs");
  });

  it("retries failed compatibility checks on reconnect", async () => {
    let attempts = 0;
    const client = createClient({}, {
      compatibilityProbe: async () => ({ executable: process.execPath, version: "0.148.7", compatible: ++attempts > 1 }),
    });
    await client.start();
    expect(client.writable).toBe(false);
    await client.stop();
    await client.start();
    expect(client.writable).toBe(true);
    expect(attempts).toBe(2);
  });

  it("keeps reads available when the compatibility probe throws", async () => {
    const client = createClient({}, { compatibilityProbe: async () => { throw new Error("probe failure"); } });
    await client.start();
    expect(client.writable).toBe(false);
    await expect(client.threadList()).resolves.toMatchObject({ data: [{ id: "thread-1" }] });
  });

  it("surfaces server requests and writes a correlated response", async () => {
    const client = createClient({ FAKE_SERVER_REQUEST: "question" });
    const serverRequest = waitForEvent(client, (event) => event.type === "server-request");
    const responseSeen = waitForEvent(
      client,
      (event) =>
        event.type === "notification" && event.notification.method === "test/serverResponse",
    );
    await client.start();

    const event = await serverRequest;
    expect(event.type).toBe("server-request");
    if (event.type !== "server-request") throw new Error("unreachable");
    client.respondToServerRequest(event.request.id, {
      answers: { q1: { answers: ["A"] } },
    });

    const responseEvent = await responseSeen;
    expect(responseEvent.type).toBe("notification");
    if (responseEvent.type !== "notification") throw new Error("unreachable");
    expect(responseEvent.notification.params).toEqual({ answers: { q1: { answers: ["A"] } } });
    expect(() => client.respondToServerRequest(event.request.id, {})).toThrow(/no longer pending/);
  });

  it("declines a permission request with an empty turn-scoped grant", async () => {
    const client = createClient({ FAKE_SERVER_REQUEST: "permission" });
    const serverRequest = waitForEvent(client, (event) => event.type === "server-request");
    const responseSeen = waitForEvent(
      client,
      (event) =>
        event.type === "notification" && event.notification.method === "test/serverResponse",
    );
    await client.start();

    const event = await serverRequest;
    expect(event.type).toBe("server-request");
    if (event.type !== "server-request") throw new Error("unreachable");
    client.declineServerRequest(event.request);

    const responseEvent = await responseSeen;
    expect(responseEvent.type).toBe("notification");
    if (responseEvent.type !== "notification") throw new Error("unreachable");
    expect(responseEvent.notification.params).toEqual({ permissions: {}, scope: "turn" });
  });

  it("disables writes after malformed protocol input without killing the child", async () => {
    const client = createClient({ FAKE_MALFORMED: "1" });
    const protocolError = waitForEvent(client, (event) => event.type === "protocol-error");
    await client.start();
    await protocolError;

    expect(client.state).toBe("running");
    expect(client.writable).toBe(false);
    await expect(client.threadList()).resolves.toMatchObject({ data: [{ id: "thread-1" }] });
    await expect(client.turnStart("thread-1", "blocked")).rejects.toBeInstanceOf(CodexReadOnlyError);
  });

  it("waits for and reaps only its exact owned child", async () => {
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], {
      stdio: "ignore",
    });
    await new Promise<void>((resolve, reject) => {
      unrelated.once("spawn", resolve);
      unrelated.once("error", reject);
    });
    const unrelatedPid = unrelated.pid;
    const client = createClient({ FAKE_STUBBORN: "1" });

    try {
      await client.start();
      const ownedPid = client.processId;
      expect(ownedPid).toBeTypeOf("number");
      expect(isProcessAlive(ownedPid)).toBe(true);

      await client.stop();

      expect(isProcessAlive(ownedPid)).toBe(false);
      expect(isProcessAlive(unrelatedPid)).toBe(true);
    } finally {
      unrelated.kill("SIGTERM");
      await new Promise<void>((resolve) => unrelated.once("close", () => resolve()));
    }
  });
});

function waitForEvent(
  client: CodexAppServerClient,
  predicate: (event: CodexClientEvent) => boolean,
): Promise<CodexClientEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for Codex client event."));
    }, 2_000);
    const unsubscribe = client.subscribe((event) => {
      if (!predicate(event)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(event);
    });
  });
}

function isProcessAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
