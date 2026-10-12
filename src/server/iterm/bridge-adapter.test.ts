import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import type { ItermWindowLayoutRecord } from "../../shared/types.js";
import { ItermBridgeAdapter } from "./bridge-adapter.js";
import { ITERM_BRIDGE_PROTOCOL_VERSION, ITERM_BRIDGE_VERSION, type ItermSessionSnapshot } from "./types.js";
import { parseBridgeMessage } from "./protocol.js";

const activeAdapters: ItermBridgeAdapter[] = [];
const temporaryDirectories: string[] = [];

function timestamp(): string {
  return "2026-08-20T03:00:00.000Z";
}

async function makeAdapter(
  options: {
    requestTimeoutMs?: number;
    restoreRequestTimeoutMs?: number;
    staleAfterMs?: number;
  } = {},
): Promise<{ adapter: ItermBridgeAdapter; socketPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "session-atlas-iterm-"));
  temporaryDirectories.push(directory);
  const socketPath = join(directory, "bridge.sock");
  const adapter = new ItermBridgeAdapter({ socketPath, ...options });
  activeAdapters.push(adapter);
  await adapter.start();
  return { adapter, socketPath };
}

async function connect(socketPath: string): Promise<Socket> {
  return await new Promise<Socket>((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function send(socket: Socket, value: unknown): void {
  socket.write(`${JSON.stringify(value)}\n`);
}

function hello(socket: Socket, bridgeVersion: string = ITERM_BRIDGE_VERSION): void {
  send(socket, {
    type: "hello",
    protocol: ITERM_BRIDGE_PROTOCOL_VERSION,
    bridgeVersion,
    sentAt: timestamp(),
  });
}

function snapshot(socket: Socket, overrides: Partial<ItermSessionSnapshot> = {}): void {
  send(socket, {
    type: "snapshot",
    protocol: ITERM_BRIDGE_PROTOCOL_VERSION,
    observedAt: timestamp(),
    sessions: [
      {
        sessionId: "w0t0p0:ABC",
        name: "session-atlas",
        cwd: "/Users/demo/Code/Workstation/session-atlas",
        tty: "/dev/ttys001",
        jobName: "codex",
        jobPid: 4242,
        commandLine: "codex",
        autoResumeConversationId: "01234567-89ab-cdef-8123-456789abcdef",
        autoResumeKind: "helper",
        autoResumeControllerPort: 4_317,
        focused: true,
        buried: false,
        windowId: "window-1",
        tabId: "tab-1",
        observedAt: timestamp(),
        ...overrides,
      },
    ],
  });
}

function hierarchySnapshot(socket: Socket): void {
  const visibleSession = (
    sessionId: string,
    windowId: string,
    tabId: string,
    windowIndex: number,
    tabIndex: number,
    paneIndex: number,
    tabCount: number,
    paneCount: number,
    currentWindow: boolean,
  ) => ({
    sessionId,
    name: sessionId,
    cwd: "/tmp/example",
    focused: sessionId === "w1t1p2",
    buried: false,
    windowId,
    tabId,
    windowIndex,
    tabIndex,
    paneIndex,
    tabCount,
    paneCount,
    currentWindow,
    observedAt: timestamp(),
  });

  send(socket, {
    type: "snapshot",
    protocol: ITERM_BRIDGE_PROTOCOL_VERSION,
    observedAt: timestamp(),
    sessions: [
      visibleSession("w1t1p1", "window-1", "tab-1", 1, 1, 1, 2, 2, true),
      visibleSession("w1t1p2", "window-1", "tab-1", 1, 1, 2, 2, 2, true),
      visibleSession("w1t2p1", "window-1", "tab-2", 1, 2, 1, 2, 1, true),
      visibleSession("w2t1p1", "window-2", "tab-3", 2, 1, 1, 1, 1, false),
      {
        sessionId: "buried",
        name: "buried",
        cwd: "/tmp/example",
        focused: false,
        buried: true,
        observedAt: timestamp(),
      },
    ],
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(async () => {
  await Promise.all(activeAdapters.splice(0).map((adapter) => adapter.stop()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("ItermBridgeAdapter", () => {
  it("creates a private Unix socket and exposes validated snapshots", async () => {
    const { adapter, socketPath } = await makeAdapter();
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);

    const socket = await connect(socketPath);
    hello(socket);
    snapshot(socket);
    await waitFor(() => adapter.getSessions().length === 1);

    expect(adapter.getHealth()).toMatchObject({
      status: "online",
      bridgeVersion: ITERM_BRIDGE_VERSION,
    });
    expect(adapter.getSessions()[0]).toMatchObject({
      sessionId: "w0t0p0:ABC",
      tty: "/dev/ttys001",
      jobPid: 4242,
      focused: true,
      buried: false,
      autoResumeConversationId: "01234567-89ab-cdef-8123-456789abcdef",
      autoResumeKind: "helper",
      autoResumeControllerPort: 4_317,
    });
    socket.destroy();
  });

  it.each([
    { protocol: 13, message: "protocol mismatch" },
    { protocol: ITERM_BRIDGE_PROTOCOL_VERSION, message: `expected ${ITERM_BRIDGE_VERSION}` },
  ])("rejects a stale bridge hello with protocol $protocol and accepts the current bridge afterwards", async ({ protocol, message }) => {
    const { adapter, socketPath } = await makeAdapter();
    const staleSocket = await connect(socketPath);
    const staleSocketClosed = new Promise<void>((resolve) => {
      staleSocket.once("close", () => resolve());
    });
    send(staleSocket, { type: "hello", protocol, bridgeVersion: "0.15.0", sentAt: timestamp() });

    await waitFor(
      () => adapter.getHealth().message?.includes(message) === true,
    );
    await staleSocketClosed;
    expect(adapter.getHealth()).toMatchObject({ status: "offline" });
    expect(adapter.getSessions()).toHaveLength(0);

    const currentSocket = await connect(socketPath);
    hello(currentSocket);
    snapshot(currentSocket);
    await waitFor(() => adapter.getSessions().length === 1);

    expect(adapter.getHealth()).toMatchObject({
      status: "online",
      bridgeVersion: ITERM_BRIDGE_VERSION,
    });
    expect(adapter.getSessions()[0]).toMatchObject({
      windowId: "window-1",
      tabId: "tab-1",
    });
    staleSocket.destroy();
    currentSocket.destroy();
  });

  it("preserves window, tab, and split-pane order with current-window metadata", async () => {
    const { adapter, socketPath } = await makeAdapter();
    const socket = await connect(socketPath);
    hello(socket);
    hierarchySnapshot(socket);
    await waitFor(() => adapter.getSessions().length === 5);

    const sessions = adapter.getSessions();
    expect(sessions.map(({ sessionId }) => sessionId)).toEqual([
      "w1t1p1",
      "w1t1p2",
      "w1t2p1",
      "w2t1p1",
      "buried",
    ]);
    expect(sessions.slice(0, 4)).toMatchObject([
      {
        windowIndex: 1,
        tabIndex: 1,
        paneIndex: 1,
        tabCount: 2,
        paneCount: 2,
        currentWindow: true,
      },
      {
        windowIndex: 1,
        tabIndex: 1,
        paneIndex: 2,
        tabCount: 2,
        paneCount: 2,
        currentWindow: true,
      },
      {
        windowIndex: 1,
        tabIndex: 2,
        paneIndex: 1,
        tabCount: 2,
        paneCount: 1,
        currentWindow: true,
      },
      {
        windowIndex: 2,
        tabIndex: 1,
        paneIndex: 1,
        tabCount: 1,
        paneCount: 1,
        currentWindow: false,
      },
    ]);
    expect(sessions[4]).not.toHaveProperty("windowIndex");
    expect(sessions[4]).not.toHaveProperty("tabIndex");
    expect(sessions[4]).not.toHaveProperty("paneIndex");
    expect(sessions[4]).not.toHaveProperty("currentWindow");
    socket.destroy();
  });

  it("sends only the exact known session id in a focus request", async () => {
    const { adapter, socketPath } = await makeAdapter();
    const socket = await connect(socketPath);
    hello(socket);
    snapshot(socket);
    await waitFor(() => adapter.getSessions().length === 1);

    const received = new Promise<Record<string, unknown>>((resolve) => {
      let buffer = "";
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
      });
    });
    const focusing = adapter.focus("w0t0p0:ABC");
    const command = await received;
    expect(command).toMatchObject({
      type: "focus",
      protocol: ITERM_BRIDGE_PROTOCOL_VERSION,
      sessionId: "w0t0p0:ABC",
    });
    expect(typeof command.expiresAt).toBe("number");
    send(socket, {
      type: "focus-result",
      protocol: ITERM_BRIDGE_PROTOCOL_VERSION,
      requestId: command.requestId,
      ok: true,
    });
    await expect(focusing).resolves.toBeUndefined();
    socket.destroy();
  });

  it("rejects overlapping focus requests until the current request finishes", async () => {
    const { adapter, socketPath } = await makeAdapter();
    const socket = await connect(socketPath);
    hello(socket);
    snapshot(socket);
    await waitFor(() => adapter.getSessions().length === 1);

    const received = new Promise<Record<string, unknown>>((resolve) => {
      socket.once("data", (chunk: Buffer) => {
        resolve(JSON.parse(chunk.toString("utf8").trim()) as Record<string, unknown>);
      });
    });
    const firstFocus = adapter.focus("w0t0p0:ABC");
    const command = await received;

    await expect(adapter.focus("w0t0p0:ABC")).rejects.toThrow(
      "Another iTerm focus request is already in progress",
    );

    send(socket, {
      type: "focus-result",
      protocol: ITERM_BRIDGE_PROTOCOL_VERSION,
      requestId: command.requestId,
      ok: true,
    });
    await expect(firstFocus).resolves.toBeUndefined();
    socket.destroy();
  });

  it("allows a new focus request after the previous request times out", async () => {
    const { adapter, socketPath } = await makeAdapter({ requestTimeoutMs: 20 });
    const socket = await connect(socketPath);
    hello(socket);
    snapshot(socket);
    await waitFor(() => adapter.getSessions().length === 1);

    const firstCommand = new Promise<void>((resolve) => socket.once("data", () => resolve()));
    const firstFocus = adapter.focus("w0t0p0:ABC");
    await firstCommand;
    await expect(firstFocus).rejects.toThrow("Timed out while focusing the iTerm session");

    const received = new Promise<Record<string, unknown>>((resolve) => {
      socket.once("data", (chunk: Buffer) => {
        resolve(JSON.parse(chunk.toString("utf8").trim()) as Record<string, unknown>);
      });
    });
    const secondFocus = adapter.focus("w0t0p0:ABC");
    const command = await received;
    send(socket, {
      type: "focus-result",
      protocol: ITERM_BRIDGE_PROTOCOL_VERSION,
      requestId: command.requestId,
      ok: true,
    });

    await expect(secondFocus).resolves.toBeUndefined();
    socket.destroy();
  });

  it("configures only the exact known session and Codex recovery identity", async () => {
    const { adapter, socketPath } = await makeAdapter();
    const socket = await connect(socketPath);
    hello(socket);
    snapshot(socket);
    await waitFor(() => adapter.getSessions().length === 1);

    const received = new Promise<Record<string, unknown>>((resolve) => {
      socket.once("data", (chunk: Buffer) => {
        resolve(JSON.parse(chunk.toString("utf8").trim()) as Record<string, unknown>);
      });
    });
    const configuring = adapter.configureAutoResume(
      adapter.getSessions()[0]!,
      "01234567-89ab-cdef-8123-456789abcdef",
      4_317,
    );
    const command = await received;
    expect(command).toMatchObject({
      type: "configure-auto-resume",
      protocol: ITERM_BRIDGE_PROTOCOL_VERSION,
      sessionId: "w0t0p0:ABC",
      cwd: "/Users/demo/Code/Workstation/session-atlas",
      conversationId: "01234567-89ab-cdef-8123-456789abcdef",
      controllerPort: 4_317,
      expectedJobPid: 4242,
      expectedJobName: "codex",
      expectedCommandLine: "codex",
    });
    send(socket, {
      type: "configure-auto-resume-result",
      protocol: ITERM_BRIDGE_PROTOCOL_VERSION,
      requestId: command.requestId,
      ok: true,
    });
    await expect(configuring).resolves.toBeUndefined();
    socket.destroy();
  });

  it("rejects invalid automatic recovery targets before sending a bridge command", async () => {
    const { adapter, socketPath } = await makeAdapter();
    const socket = await connect(socketPath);
    hello(socket);
    snapshot(socket);
    await waitFor(() => adapter.getSessions().length === 1);
    let received = false;
    socket.on("data", () => {
      received = true;
    });

    await expect(
      adapter.configureAutoResume(
        { ...adapter.getSessions()[0]!, cwd: "relative" },
        "not-a-session-id",
        4_317,
      ),
    ).rejects.toThrow("working directory");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received).toBe(false);
    socket.destroy();
  });

  it("clears only the matching automatic recovery marker", async () => {
    const { adapter, socketPath } = await makeAdapter();
    const socket = await connect(socketPath);
    hello(socket);
    snapshot(socket);
    await waitFor(() => adapter.getSessions().length === 1);

    const received = new Promise<Record<string, unknown>>((resolve) => {
      socket.once("data", (chunk: Buffer) => {
        resolve(JSON.parse(chunk.toString("utf8").trim()) as Record<string, unknown>);
      });
    });
    const clearing = adapter.clearAutoResume(
      "w0t0p0:ABC",
      "01234567-89ab-cdef-8123-456789abcdef",
    );
    const command = await received;
    expect(command).toMatchObject({
      type: "clear-auto-resume",
      protocol: ITERM_BRIDGE_PROTOCOL_VERSION,
      sessionId: "w0t0p0:ABC",
      conversationId: "01234567-89ab-cdef-8123-456789abcdef",
    });
    send(socket, {
      type: "clear-auto-resume-result",
      protocol: ITERM_BRIDGE_PROTOCOL_VERSION,
      requestId: command.requestId,
      ok: true,
    });
    await expect(clearing).resolves.toBeUndefined();
    socket.destroy();
  });

  it("sends a persisted layout and correlates the restore result", async () => {
    const { adapter, socketPath } = await makeAdapter();
    const socket = await connect(socketPath);
    hello(socket);
    snapshot(socket);
    await waitFor(() => adapter.getHealth().status === "online");
    const layout: ItermWindowLayoutRecord = {
      windowId: "closed-window",
      status: "closed",
      firstSeenAt: timestamp(),
      lastSeenAt: timestamp(),
      closedAt: timestamp(),
      tabs: [
        {
          tabId: "closed-tab",
          tabIndex: 1,
          panes: [
            {
              sessionId: "closed-pane",
              title: "Project",
              cwd: "/tmp/project",
              conversationId: "01234567-89ab-cdef-8123-456789abcdef",
              resumeCommand:
                "codex resume -C '/tmp/project' '01234567-89ab-cdef-8123-456789abcdef'",
              splitPath: [{ vertical: true, index: 0 }],
            },
          ],
        },
      ],
    };
    const received = new Promise<Record<string, unknown>>((resolve) => {
      socket.once("data", (chunk: Buffer) => {
        resolve(JSON.parse(chunk.toString("utf8").trim()) as Record<string, unknown>);
      });
    });

    const restoring = adapter.restoreLayout(layout, 4_317);
    const command = await received;
    expect(command).toMatchObject({
      type: "restore-layout",
      protocol: ITERM_BRIDGE_PROTOCOL_VERSION,
      controllerPort: 4_317,
      layout: { windowId: "closed-window", status: "closed" },
    });
    send(socket, {
      type: "restore-layout-result",
      protocol: ITERM_BRIDGE_PROTOCOL_VERSION,
      requestId: command.requestId,
      ok: true,
      createdWindowId: "restored-window",
    });
    await expect(restoring).resolves.toBe("restored-window");
    socket.destroy();
  });

  it("sends an in-place recovery batch and correlates the result", async () => {
    const { adapter, socketPath } = await makeAdapter();
    const socket = await connect(socketPath);
    hello(socket);
    snapshot(socket);
    await waitFor(() => adapter.getHealth().status === "online");
    const commandReceived = new Promise<Record<string, unknown>>((resolve) => {
      socket.once("data", (chunk: Buffer) => {
        resolve(JSON.parse(chunk.toString("utf8").trim()) as Record<string, unknown>);
      });
    });

    const restoring = adapter.restoreRecoveries("recovery-batch:test", [
      {
        targetSessionId: "shell-one",
        cwd: "/tmp/project",
        conversationId: "01234567-89ab-cdef-8123-456789abcdef",
        title: "Project",
        splitVertical: true,
      },
    ], 4_317);
    const command = await commandReceived;
    expect(command).toMatchObject({
      type: "restore-recoveries",
      batchId: "recovery-batch:test",
      controllerPort: 4_317,
      recoveries: [{ targetSessionId: "shell-one", splitVertical: true }],
    });
    send(socket, {
      type: "restore-recoveries-result",
      protocol: ITERM_BRIDGE_PROTOCOL_VERSION,
      requestId: command.requestId,
      ok: true,
    });
    await expect(restoring).resolves.toBeUndefined();
    socket.destroy();
  });

  it("keeps a timed-out layout restore in flight until the bridge reports completion", async () => {
    const { adapter, socketPath } = await makeAdapter({ restoreRequestTimeoutMs: 10 });
    const socket = await connect(socketPath);
    hello(socket);
    snapshot(socket);
    await waitFor(() => adapter.getHealth().status === "online");
    const layout: ItermWindowLayoutRecord = {
      windowId: "slow-window",
      status: "closed",
      firstSeenAt: timestamp(),
      lastSeenAt: timestamp(),
      closedAt: timestamp(),
      tabs: [
        {
          tabId: "slow-tab",
          tabIndex: 1,
          panes: [
            {
              sessionId: "slow-pane",
              title: "Slow project",
              cwd: "/tmp/slow-project",
              splitPath: [{ vertical: true, index: 0 }],
            },
          ],
        },
      ],
    };
    const commandReceived = new Promise<Record<string, unknown>>((resolve) => {
      socket.once("data", (chunk: Buffer) => {
        resolve(JSON.parse(chunk.toString("utf8").trim()) as Record<string, unknown>);
      });
    });

    const first = adapter.restoreLayout(layout, 4_317);
    const command = await commandReceived;
    const uncertain: Array<{ windowId: string }> = [];
    adapter.on("restore-uncertain", (event) => uncertain.push(event));
    await expect(first).rejects.toThrow("inspect the created sessions");
    expect(uncertain).toEqual([{ windowId: "slow-window" }]);
    await expect(adapter.restoreLayout(layout, 4_317)).rejects.toThrow("inspect the created sessions");

    send(socket, {
      type: "restore-layout-result",
      protocol: ITERM_BRIDGE_PROTOCOL_VERSION,
      requestId: command.requestId,
      ok: false,
      partial: true,
      error: "late partial result",
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(uncertain).toEqual([{ windowId: "slow-window" }]);
    socket.destroy();
  });

  it("blocks retries after the bridge reports a partial window restore", async () => {
    const { adapter, socketPath } = await makeAdapter();
    const socket = await connect(socketPath);
    hello(socket);
    snapshot(socket);
    await waitFor(() => adapter.getHealth().status === "online");
    const layout: ItermWindowLayoutRecord = {
      windowId: "partial-window",
      status: "closed",
      firstSeenAt: timestamp(),
      lastSeenAt: timestamp(),
      closedAt: timestamp(),
      tabs: [
        {
          tabId: "partial-tab",
          tabIndex: 1,
          panes: [
            {
              sessionId: "partial-pane",
              title: "Partial project",
              cwd: "/tmp/partial-project",
              splitPath: [{ vertical: true, index: 0 }],
            },
          ],
        },
      ],
    };
    const uncertain: Array<{ windowId: string; createdWindowId?: string }> = [];
    adapter.on("restore-uncertain", (event) => uncertain.push(event));
    const commandReceived = new Promise<Record<string, unknown>>((resolve) => {
      socket.once("data", (chunk: Buffer) => {
        resolve(JSON.parse(chunk.toString("utf8").trim()) as Record<string, unknown>);
      });
    });

    const first = adapter.restoreLayout(layout, 4_317);
    const command = await commandReceived;
    send(socket, {
      type: "restore-layout-result",
      protocol: ITERM_BRIDGE_PROTOCOL_VERSION,
      requestId: command.requestId,
      ok: false,
      partial: true,
      createdWindowId: "new-window-id",
      error: "split RPC failed",
    });

    await expect(first).rejects.toThrow("inspect the created sessions");
    expect(uncertain).toEqual([
      { windowId: "partial-window", createdWindowId: "new-window-id" },
    ]);
    await expect(adapter.restoreLayout(layout, 4_317)).rejects.toThrow(
      "inspect the created sessions",
    );
    socket.destroy();
  });

  it("blocks retries after the bridge disconnects with a restore command in flight", async () => {
    const { adapter, socketPath } = await makeAdapter();
    const socket = await connect(socketPath);
    hello(socket);
    snapshot(socket);
    await waitFor(() => adapter.getHealth().status === "online");
    const layout: ItermWindowLayoutRecord = {
      windowId: "disconnected-window",
      status: "closed",
      firstSeenAt: timestamp(),
      lastSeenAt: timestamp(),
      closedAt: timestamp(),
      tabs: [
        {
          tabId: "disconnected-tab",
          tabIndex: 1,
          panes: [
            {
              sessionId: "disconnected-pane",
              title: "Disconnected project",
              cwd: "/tmp/disconnected-project",
              splitPath: [{ vertical: true, index: 0 }],
            },
          ],
        },
      ],
    };
    const commandReceived = new Promise<void>((resolve) => socket.once("data", () => resolve()));

    const first = adapter.restoreLayout(layout, 4_317);
    await commandReceived;
    socket.destroy();
    await expect(first).rejects.toThrow("inspect the created sessions");
    await waitFor(() => adapter.getHealth().status === "offline");

    const reconnected = await connect(socketPath);
    hello(reconnected);
    snapshot(reconnected);
    await waitFor(() => adapter.getHealth().status === "online");
    await expect(adapter.restoreLayout(layout, 4_317)).rejects.toThrow(
      "inspect the created sessions",
    );
    reconnected.destroy();
  });

  it("rejects unknown ids without sending a bridge command", async () => {
    const { adapter, socketPath } = await makeAdapter();
    const socket = await connect(socketPath);
    hello(socket);
    snapshot(socket);
    await waitFor(() => adapter.getSessions().length === 1);

    let received = false;
    socket.on("data", () => {
      received = true;
    });
    await expect(adapter.focus("w0t0p0:DIFFERENT")).rejects.toThrow("Unknown iTerm session");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received).toBe(false);
    socket.destroy();
  });

  it("fails closed on a protocol mismatch and keeps the last good inventory", async () => {
    const { adapter, socketPath } = await makeAdapter();
    const socket = await connect(socketPath);
    hello(socket);
    snapshot(socket);
    await waitFor(() => adapter.getSessions().length === 1);

    send(socket, {
      type: "health",
      protocol: 999,
      status: "online",
      sentAt: timestamp(),
    });
    await waitFor(() => adapter.getHealth().status === "offline");
    expect(adapter.getSessions()).toHaveLength(1);
    expect(adapter.getHealth().message).toContain("protocol mismatch");
  });

  it("refuses a second controller without displacing the active bridge", async () => {
    const { adapter, socketPath } = await makeAdapter();
    const socket = await connect(socketPath);
    hello(socket);
    snapshot(socket);
    await waitFor(() => adapter.getHealth().status === "online");

    const second = new ItermBridgeAdapter({ socketPath });
    activeAdapters.push(second);
    await expect(second.start()).rejects.toThrow("already listening");
    expect(adapter.getHealth().status).toBe("online");
    expect(adapter.getSessions()).toHaveLength(1);
    socket.destroy();
  });

  it("removes only the socket it created when stopped", async () => {
    const { adapter, socketPath } = await makeAdapter();
    await adapter.stop();
    activeAdapters.splice(activeAdapters.indexOf(adapter), 1);
    await expect(readFile(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("saved-thread bridge actions", () => {
  const proof = { rolloutPath: "/Users/demo/.codex/sessions/rollout-01234567-89ab-cdef-8123-456789abcdef.jsonl", size: 1234, mtimeNs: "123456789" };
  it("sends exact expiring close identity and awaits native acknowledgement", async () => {
    const { adapter, socketPath } = await makeAdapter();
    const socket = await connect(socketPath);
    hello(socket);
    snapshot(socket);
    await waitFor(() => adapter.getSessions().length === 1);
    const commandReceived = new Promise<Record<string, unknown>>((resolve) => {
      socket.once("data", (bytes) => resolve(JSON.parse(bytes.toString())));
    });
    const closing = adapter.closeSession(adapter.getSessions()[0]!, "01234567-89ab-cdef-8123-456789abcdef", proof);
    const command = await commandReceived;
    expect(command).toMatchObject({ type: "close-session", sessionId: "w0t0p0:ABC", expectedJobPid: 4242, expectedJobName: "codex", expectedCommandLine: "codex" });
    expect(command.expiresAt).toBeGreaterThan(Date.now());
    expect(command.proof).toEqual(proof);
    send(socket, { type: "close-session-result", protocol: ITERM_BRIDGE_PROTOCOL_VERSION, requestId: command.requestId, ok: true });
    await closing;
    socket.destroy();
  });

  it("refuses stale process identity before sending close", async () => {
    const { adapter, socketPath } = await makeAdapter();
    const socket = await connect(socketPath);
    hello(socket);
    snapshot(socket);
    await waitFor(() => adapter.getSessions().length === 1);
    await expect(adapter.closeSession({ ...adapter.getSessions()[0]!, jobPid: 4243 }, "01234567-89ab-cdef-8123-456789abcdef", proof)).rejects.toThrow("identity changed");
    socket.destroy();
  });

  it("returns exact restored pane identity and blocks concurrent duplicate restoration", async () => {
    const { adapter, socketPath } = await makeAdapter();
    const socket = await connect(socketPath);
    hello(socket);
    await waitFor(() => adapter.getHealth().status === "online");
    const target = { conversationId: "01234567-89ab-cdef-8123-456789abcdef", cwd: "/tmp/project", title: "Pending work", windowId: "original-window", savedCard: true };
    const commandReceived = new Promise<Record<string, unknown>>((resolve) => {
      socket.once("data", (bytes) => resolve(JSON.parse(bytes.toString())));
    });
    const restoring = adapter.restoreThread(target, 4317);
    const command = await commandReceived;
    expect(command).toMatchObject({ type: "restore-thread", target, controllerPort: 4317 });
    await expect(adapter.restoreThread(target, 4317)).rejects.toMatchObject({ code: "WINDOW_RESTORE_IN_PROGRESS" });
    send(socket, { type: "restore-thread-result", protocol: ITERM_BRIDGE_PROTOCOL_VERSION, requestId: command.requestId, ok: true, terminalSessionId: "new-pane", windowId: "original-window" });
    await expect(restoring).resolves.toEqual({ terminalSessionId: "new-pane", windowId: "original-window" });
    socket.destroy();
  });

  it("retains an uncertain restoration after timeout and a late success", async () => {
    const { adapter, socketPath } = await makeAdapter({ restoreRequestTimeoutMs: 20 });
    const socket = await connect(socketPath);
    hello(socket);
    await waitFor(() => adapter.getHealth().status === "online");
    const target = { conversationId: "01234567-89ab-cdef-8123-456789abcdef", cwd: "/tmp/project", title: "Pending work" };
    const commandReceived = new Promise<Record<string, unknown>>((resolve) => {
      socket.once("data", (bytes) => resolve(JSON.parse(bytes.toString())));
    });
    const restoring = expect(adapter.restoreThread(target, 4317)).rejects.toMatchObject({ code: "WINDOW_RESTORE_PARTIAL" });
    const command = await commandReceived;
    await restoring;
    send(socket, { type: "restore-thread-result", protocol: ITERM_BRIDGE_PROTOCOL_VERSION, requestId: command.requestId, ok: true, terminalSessionId: "late-pane", windowId: "new-window" });
    await expect(adapter.restoreThread(target, 4317)).rejects.toMatchObject({ code: "WINDOW_RESTORE_PARTIAL" });
    adapter.confirmThreadRestored(target.conversationId, "missing-pane");
    await expect(adapter.restoreThread(target, 4317)).rejects.toMatchObject({ code: "WINDOW_RESTORE_PARTIAL" });
    snapshot(socket);
    await waitFor(() => adapter.getSessions().length === 1);
    adapter.confirmThreadRestored(target.conversationId, "w0t0p0:ABC");
    send(socket, { type: "snapshot", protocol: ITERM_BRIDGE_PROTOCOL_VERSION, observedAt: timestamp(), sessions: [] });
    await waitFor(() => adapter.getSessions().length === 0);
    const secondCommandReceived = new Promise<Record<string, unknown>>((resolve) => {
      socket.once("data", (bytes) => resolve(JSON.parse(bytes.toString())));
    });
    const secondRestore = adapter.restoreThread(target, 4317);
    const secondCommand = await secondCommandReceived;
    send(socket, { type: "restore-thread-result", protocol: ITERM_BRIDGE_PROTOCOL_VERSION, requestId: secondCommand.requestId, ok: true, terminalSessionId: "second-pane" });
    await expect(secondRestore).resolves.toEqual({ terminalSessionId: "second-pane" });
    socket.destroy();
  });
});

describe("saved-session display markers", () => {
  const conversationId = "01234567-89ab-cdef-8123-456789abcdef";
  const sessionId = "w0t0p0:ABC";

  async function ready(overrides: Partial<ItermSessionSnapshot> = {}) {
    const { adapter, socketPath } = await makeAdapter();
    const socket = await connect(socketPath);
    hello(socket);
    snapshot(socket, overrides);
    await waitFor(() => adapter.getSessions().length === 1);
    return { adapter, socket };
  }

  function nextCommand(socket: Socket): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      socket.once("data", (bytes) => resolve(JSON.parse(bytes.toString())));
    });
  }

  it.each(["requested", "applied"] as const)("reads %s provenance without profile contents and retains inherited ownership", async (savedMarkerState) => {
    const marker = { savedMarkerConversationId: conversationId, savedMarkerOwnerSessionId: "original-pane", savedMarkerState };
    const { adapter, socket } = await ready(marker);
    expect(adapter.getSessions()[0]).toMatchObject(marker);
    const parsed = parseBridgeMessage({
      type: "snapshot", protocol: ITERM_BRIDGE_PROTOCOL_VERSION, observedAt: timestamp(),
      sessions: [{ ...adapter.getSessions()[0], badgeText: "custom badge", savedMarkerBackup: { badge: "original badge" } }],
    });
    expect(parsed?.type).toBe("snapshot");
    if (parsed?.type !== "snapshot") throw new Error("Missing snapshot");
    expect(parsed.sessions[0]).not.toHaveProperty("badgeText");
    expect(parsed.sessions[0]).not.toHaveProperty("savedMarkerBackup");
    expect(parsed.sessions[0]?.savedMarkerOwnerSessionId).toBe("original-pane");
    socket.destroy();
  });

  it.each([
    { savedMarkerConversationId: "invalid" },
    { savedMarkerOwnerSessionId: "" },
    { savedMarkerOwnerSessionId: "invalid\nowner" },
    { savedMarkerState: "unknown" },
    { savedMarkerState: undefined },
    { savedMarkerConversationId: undefined },
    { savedMarkerOwnerSessionId: undefined },
  ])("rejects malformed or incomplete marker provenance: %j", (overrides) => {
    expect(parseBridgeMessage({
      type: "snapshot", protocol: ITERM_BRIDGE_PROTOCOL_VERSION, observedAt: timestamp(),
      sessions: [{
        sessionId, name: "saved", cwd: "/tmp/project", focused: true, buried: false, observedAt: timestamp(),
        savedMarkerConversationId: conversationId, savedMarkerOwnerSessionId: sessionId, savedMarkerState: "applied",
        ...overrides,
      }],
    })).toBeNull();
  });

  it("sends exact expiring process identity and only accepts the matching marker acknowledgement", async () => {
    const { adapter, socket } = await ready();
    const received = nextCommand(socket);
    let settled = false;
    const applying = adapter.configureSavedMarker(adapter.getSessions()[0]!, conversationId).then(() => { settled = true; });
    const command = await received;
    expect(command).toMatchObject({
      type: "configure-saved-marker", protocol: ITERM_BRIDGE_PROTOCOL_VERSION,
      sessionId, conversationId, cwd: "/Users/demo/Code/Workstation/session-atlas",
      expectedJobPid: 4242, expectedJobName: "codex", expectedCommandLine: "codex",
    });
    expect(command.expiresAt).toBeGreaterThan(Date.now());
    expect(command).not.toHaveProperty("badgeText");
    send(socket, { type: "configure-saved-marker-result", protocol: ITERM_BRIDGE_PROTOCOL_VERSION, requestId: "different-request", ok: true });
    send(socket, { type: "focus-result", protocol: ITERM_BRIDGE_PROTOCOL_VERSION, requestId: command.requestId, ok: true });
    send(socket, { type: "clear-saved-marker-result", protocol: ITERM_BRIDGE_PROTOCOL_VERSION, requestId: command.requestId, ok: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    send(socket, { type: "configure-saved-marker-result", protocol: ITERM_BRIDGE_PROTOCOL_VERSION, requestId: command.requestId, ok: true });
    await applying;
    expect(adapter.getSessions()[0]).not.toHaveProperty("savedMarkerState");
    snapshot(socket, { savedMarkerConversationId: conversationId, savedMarkerOwnerSessionId: sessionId, savedMarkerState: "applied" });
    await waitFor(() => adapter.getSessions()[0]?.savedMarkerState === "applied");
    socket.destroy();
  });

  it.each([
    { cwd: "/tmp/different-project" },
    { jobPid: 4243 },
    { jobName: "zsh" },
    { commandLine: "codex resume another-thread" },
    { jobPid: undefined },
  ])("rejects stale or missing process identity before sending a marker command: %j", async (overrides) => {
    const { adapter, socket } = await ready();
    let sent = false;
    socket.on("data", () => { sent = true; });
    await expect(adapter.configureSavedMarker({ ...adapter.getSessions()[0]!, ...overrides }, conversationId)).rejects.toThrow(/identity/u);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sent).toBe(false);
    socket.destroy();
  });

  it("does not relabel a pane owned by another marker or inherited from a split", async () => {
    const { adapter, socket } = await ready({ savedMarkerConversationId: conversationId, savedMarkerOwnerSessionId: "original-pane", savedMarkerState: "applied" });
    await expect(adapter.configureSavedMarker(adapter.getSessions()[0]!, conversationId)).rejects.toThrow("ownership changed");
    await expect(adapter.clearSavedMarker(sessionId, "11111111-1111-1111-1111-111111111111")).rejects.toThrow("ownership changed");
    socket.destroy();
  });

  it.each([true, false])("clears inherited display with explicit forget=%s and awaits acknowledgement", async (forget) => {
    const { adapter, socket } = await ready({ savedMarkerConversationId: conversationId, savedMarkerOwnerSessionId: "original-pane", savedMarkerState: "applied" });
    const received = nextCommand(socket);
    const clearing = forget ? adapter.clearSavedMarker(sessionId, conversationId) : adapter.clearSavedMarker(sessionId, conversationId, false);
    const command = await received;
    expect(command).toMatchObject({ type: "clear-saved-marker", protocol: ITERM_BRIDGE_PROTOCOL_VERSION, sessionId, conversationId, forget });
    expect(command.expiresAt).toBeGreaterThan(Date.now());
    send(socket, { type: "clear-saved-marker-result", protocol: ITERM_BRIDGE_PROTOCOL_VERSION, requestId: command.requestId, ok: true });
    await clearing;
    expect(adapter.getSessions()[0]?.savedMarkerState).toBe("applied");
    socket.destroy();
  });

  it("reports marker write rejection without changing the last observed marker", async () => {
    const { adapter, socket } = await ready();
    const received = nextCommand(socket);
    const applying = expect(adapter.configureSavedMarker(adapter.getSessions()[0]!, conversationId)).rejects.toThrow("Process changed");
    const command = await received;
    send(socket, { type: "configure-saved-marker-result", protocol: ITERM_BRIDGE_PROTOCOL_VERSION, requestId: command.requestId, ok: false, error: "Process changed" });
    await applying;
    expect(adapter.getSessions()[0]).not.toHaveProperty("savedMarkerConversationId");
    socket.destroy();
  });

  it("rejects marker operations after a stale bridge disconnect while retaining inventory", async () => {
    const { adapter, socket } = await ready();
    hello(socket, "0.14.0");
    await waitFor(() => adapter.getHealth().status === "offline");
    await expect(adapter.configureSavedMarker(adapter.getSessions()[0]!, conversationId)).rejects.toThrow("offline");
    await expect(adapter.clearSavedMarker(sessionId, conversationId)).rejects.toThrow("offline");
    socket.destroy();
  });
});
