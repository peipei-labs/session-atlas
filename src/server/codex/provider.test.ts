import { describe, expect, it, vi } from "vitest";

import {
  CodexRpcError,
  type CodexClientEvent,
  type CodexClientListener,
  type CodexClientPort,
  type CodexClientState,
} from "./client.js";
import { CodexProvider, CodexProviderError } from "./provider.js";
import type {
  CodexThread,
  InitializeResponse,
  RpcId,
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

const NOW = new Date("2026-08-20T03:00:00.000Z");

class FakeClient implements CodexClientPort {
  state: CodexClientState = "stopped";
  version = "0.148.0";
  writable = true;
  initializeResult: InitializeResponse | undefined = {
    userAgent: "fake/0.148.0",
    codexHome: "/tmp/codex",
    platformFamily: "unix",
    platformOs: "macos",
  };
  threads: CodexThread[] = [];
  loaded = new Set<string>();
  threadStartSource: CodexThread["source"] = "appServer";
  listeners = new Set<CodexClientListener>();
  responses: Array<{ id: RpcId; result: unknown }> = [];
  rejections: Array<{ id: RpcId; code: number; message: string }> = [];
  turnStartCalls: Array<{ threadId: string; text: string }> = [];
  turnSteerCalls: Array<{ threadId: string; expectedTurnId: string; text: string }> = [];
  turnInterruptCalls: Array<{ threadId: string; turnId: string }> = [];
  startCalls = 0;
  threadReadCalls: string[] = [];
  threadTurnsListCalls: ThreadTurnsListParams[] = [];
  threadItemsListCalls: ThreadItemsListParams[] = [];

  async start(): Promise<void> {
    this.startCalls += 1;
    this.state = "running";
    this.emit({ type: "state", state: "running" });
  }

  async stop(): Promise<void> {
    this.state = "stopped";
    this.emit({ type: "state", state: "stopped" });
  }

  subscribe(listener: CodexClientListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: CodexClientEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  emitRequest(request: RpcServerRequest): void {
    this.emit({ type: "server-request", request });
  }

  async threadStart(params: ThreadStartParams): Promise<ThreadStartResponse> {
    const thread = makeThread({
      id: `managed-${this.threads.length + 1}`,
      cwd: typeof params.cwd === "string" ? params.cwd : "/tmp/project",
      source: this.threadStartSource,
      status: { type: "idle" },
      canAcceptDirectInput: true,
    });
    this.threads.push(thread);
    this.loaded.add(thread.id);
    return { thread, model: "fake", modelProvider: "fake", cwd: thread.cwd };
  }

  async threadList(params?: ThreadListParams): Promise<ThreadListResponse> {
    const data = params?.sourceKinds?.length
      ? this.threads.filter((thread) =>
          params.sourceKinds?.includes(
            typeof thread.source === "string" &&
              (thread.source === "cli" ||
                thread.source === "vscode" ||
                thread.source === "exec" ||
                thread.source === "appServer")
              ? thread.source
              : "unknown",
          ),
        )
      : this.threads;
    return { data, nextCursor: null, backwardsCursor: null };
  }

  async threadRead(threadId: string, _includeTurns?: boolean): Promise<ThreadReadResponse> {
    this.threadReadCalls.push(threadId);
    const thread = this.threads.find((candidate) => candidate.id === threadId);
    if (!thread) throw new Error("missing thread");
    return { thread };
  }

  async threadTurnsList(params: ThreadTurnsListParams): Promise<ThreadTurnsListResponse> {
    this.threadTurnsListCalls.push(params);
    const thread = this.threads.find((candidate) => candidate.id === params.threadId);
    if (!thread) throw new Error("missing thread");
    const latest = [...thread.turns].sort(
      (left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0),
    )[0];
    return {
      data: latest
        ? [params.itemsView === "full" ? latest : { ...latest, items: [], itemsView: "notLoaded" }]
        : [],
      nextCursor: null,
      backwardsCursor: null,
    };
  }

  async threadItemsList(params: ThreadItemsListParams): Promise<ThreadItemsListResponse> {
    this.threadItemsListCalls.push(params);
    const thread = this.threads.find((candidate) => candidate.id === params.threadId);
    const turn = thread?.turns.find((candidate) => candidate.id === params.turnId);
    if (!turn) throw new Error("missing turn");
    const ordered = params.sortDirection === "desc" ? [...turn.items].reverse() : turn.items;
    return {
      data: ordered.slice(0, params.limit ?? ordered.length).map((item) => ({
        turnId: turn.id,
        item,
      })),
      nextCursor: null,
      backwardsCursor: null,
    };
  }

  async threadLoadedList(): Promise<ThreadLoadedListResponse> {
    return { data: [...this.loaded], nextCursor: null };
  }

  async turnStart(threadId: string, text: string): Promise<TurnStartResponse> {
    this.turnStartCalls.push({ threadId, text });
    return {
      turn: {
        id: `turn-${this.turnStartCalls.length}`,
        items: [],
        itemsView: "full",
        status: "inProgress",
        error: null,
        startedAt: Math.floor(NOW.getTime() / 1_000),
        completedAt: null,
        durationMs: null,
      },
    };
  }

  async turnSteer(
    threadId: string,
    expectedTurnId: string,
    text: string,
  ): Promise<TurnSteerResponse> {
    this.turnSteerCalls.push({ threadId, expectedTurnId, text });
    return { turnId: expectedTurnId };
  }

  async turnInterrupt(threadId: string, turnId: string): Promise<void> {
    this.turnInterruptCalls.push({ threadId, turnId });
  }

  respondToServerRequest(id: RpcId, result: unknown): void {
    this.responses.push({ id, result });
  }

  rejectServerRequest(id: RpcId, code: number, message: string): void {
    this.rejections.push({ id, code, message });
  }

  declineServerRequest(request: RpcServerRequest, message = "declined"): void {
    if (
      request.method === "item/commandExecution/requestApproval" ||
      request.method === "item/fileChange/requestApproval"
    ) {
      this.responses.push({ id: request.id, result: { decision: "decline" } });
    } else if (request.method === "item/permissions/requestApproval") {
      this.responses.push({ id: request.id, result: { permissions: {}, scope: "turn" } });
    } else {
      this.rejections.push({ id: request.id, code: -32001, message });
    }
  }
}

describe("CodexProvider", () => {
  it("restarts the owned App Server after an unexpected transport stop", async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    const provider = new CodexProvider({
      client,
      now: () => new Date(NOW),
      restartDelaysMs: [25],
    });
    try {
      await provider.start();
      client.state = "stopped";
      client.emit({ type: "state", state: "stopped", error: new Error("transport closed") });

      expect(client.startCalls).toBe(1);
      expect(provider.getHealth()).toMatchObject({
        codex: "offline",
        message: "Codex App Server stopped unexpectedly; retrying in 25ms.",
      });

      await vi.advanceTimersByTimeAsync(25);

      expect(client.startCalls).toBe(2);
      expect(provider.getHealth()).toMatchObject({ codex: "online" });
    } finally {
      await provider.stop();
      vi.useRealTimers();
    }
  });

  it("drops transport-scoped pending requests when the App Server stops", async () => {
    const client = managedClient();
    const provider = createProvider(client);
    await provider.start();

    client.emitRequest({
      id: "reused-after-restart",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "managed",
        turnId: "turn-live",
        itemId: "command-before-restart",
        startedAtMs: NOW.getTime(),
        command: "npm test",
        cwd: "/tmp/project",
        reason: "Run tests",
        availableDecisions: ["accept", "decline"],
      },
    });
    expect((await provider.list())[0]?.pendingRequest).toBeDefined();

    client.state = "stopped";
    client.emit({ type: "state", state: "stopped" });

    expect((await provider.list())[0]).toMatchObject({
      activityState: "offline",
      attentionReason: null,
      stale: true,
    });
    expect((await provider.list())[0]?.pendingRequest).toBeUndefined();

    client.state = "running";
    client.emit({ type: "state", state: "running" });
    await provider.refresh();
    client.emitRequest({
      id: "reused-after-restart",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "managed",
        turnId: "turn-live",
        itemId: "command-after-restart",
        startedAtMs: NOW.getTime(),
        command: "npm test",
        cwd: "/tmp/project",
        reason: "Run tests again",
        availableDecisions: ["accept", "decline"],
      },
    });

    expect((await provider.list())[0]?.pendingRequest).toMatchObject({
      kind: "approval",
      command: "npm test",
    });
    expect(client.rejections).toEqual([]);
    await provider.stop();
  });

  it("increases restart delays when the App Server repeatedly crashes after initialize", async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    const provider = new CodexProvider({
      client,
      now: () => new Date(NOW),
      restartDelaysMs: [10, 20, 40],
      restartStabilityMs: 1_000,
    });
    try {
      await provider.start();

      client.state = "stopped";
      client.emit({ type: "state", state: "stopped", error: new Error("crash one") });
      expect(provider.getHealth().message).toContain("retrying in 10ms");
      await vi.advanceTimersByTimeAsync(10);
      expect(client.startCalls).toBe(2);

      client.state = "stopped";
      client.emit({ type: "state", state: "stopped", error: new Error("crash two") });
      expect(provider.getHealth().message).toContain("retrying in 20ms");
      await vi.advanceTimersByTimeAsync(20);
      expect(client.startCalls).toBe(3);

      client.state = "stopped";
      client.emit({ type: "state", state: "stopped", error: new Error("crash three") });
      expect(provider.getHealth().message).toContain("retrying in 40ms");
    } finally {
      await provider.stop();
      vi.useRealTimers();
    }
  });

  it("lists only App Server inventory and leaves independent CLI sessions to the iTerm adapter", async () => {
    const client = new FakeClient();
    client.threads = [
      makeThread({ id: "managed", source: "appServer", status: { type: "idle" } }),
      makeThread({ id: "legacy", source: "cli", status: { type: "notLoaded" } }),
    ];
    client.loaded.add("managed");
    const provider = createProvider(client);
    await provider.start();

    const sessions = await provider.list();
    expect(sessions).toHaveLength(1);
    expect(sessions.find((session) => session.conversationId === "managed")).toMatchObject({
      id: "codex:managed",
      surface: "managed",
      activityState: "idle",
      stale: false,
      capabilities: { send: true, steer: false, focus: false },
    });
    expect(sessions.find((session) => session.conversationId === "legacy")).toBeUndefined();
  });

  it("projects a stored CLI turn into bounded execution steps without exposing transcript data", async () => {
    const client = new FakeClient();
    client.threads = [
      makeThread({
        id: "legacy",
        source: "cli",
        status: { type: "notLoaded" },
        turns: [
          {
            id: "turn-stored",
            items: [
              { id: "user", type: "userMessage", content: [{ text: "private prompt" }] },
              { id: "reason", type: "reasoning", summary: ["private reasoning"] },
              {
                id: "command-1",
                type: "commandExecution",
                command: "print-secret-value",
                status: "completed",
              },
              {
                id: "command-2",
                type: "commandExecution",
                command: "another-private-command",
                status: "completed",
              },
              {
                id: "files",
                type: "fileChange",
                status: "completed",
                changes: [{ path: "/private/file-a" }, { path: "/private/file-b" }],
              },
              {
                id: "tool",
                type: "mcpToolCall",
                server: "private-server",
                tool: "private-tool",
                status: "inProgress",
              },
              { id: "reply", type: "agentMessage", text: "private reply" },
            ],
            itemsView: "full",
            status: "inProgress",
            error: null,
            startedAt: Math.floor(NOW.getTime() / 1_000),
            completedAt: null,
            durationMs: null,
          },
        ],
      }),
    ];
    const provider = createProvider(client);
    await provider.start();

    const execution = await provider.readExecution("legacy");

    expect(execution).toMatchObject({
      turnId: "turn-stored",
      turnStatus: "in_progress",
      truncated: false,
      steps: [
        { label: "收到本轮任务", status: "completed" },
        { label: "执行命令", status: "completed", count: 2 },
        { label: "修改文件（2 项）", status: "completed" },
        { label: "调用工具", status: "in_progress" },
      ],
    });
    expect(JSON.stringify(execution)).not.toMatch(
      /private prompt|private reasoning|print-secret|private\/file|private-server|private-tool|private reply/u,
    );
    expect(client.threadTurnsListCalls).toEqual([
      {
        threadId: "legacy",
        limit: 1,
        sortDirection: "desc",
        itemsView: "notLoaded",
      },
    ]);
    expect(client.threadItemsListCalls).toEqual([
      { threadId: "legacy", turnId: "turn-stored", limit: 50, sortDirection: "desc" },
    ]);
    expect(client.threadReadCalls).toEqual([]);
  });

  it("falls back to a bounded full-turn read when item pagination is unavailable", async () => {
    const client = new FakeClient();
    client.threads = [
      makeThread({
        id: "legacy",
        source: "cli",
        status: { type: "notLoaded" },
        turns: [
          {
            id: "turn-stored",
            items: [{ id: "command", type: "commandExecution", status: "completed" }],
            itemsView: "full",
            status: "completed",
            error: null,
            startedAt: Math.floor(NOW.getTime() / 1_000),
            completedAt: Math.floor(NOW.getTime() / 1_000),
            durationMs: 1_000,
          },
        ],
      }),
    ];
    client.threadItemsList = async () => {
      throw new CodexRpcError({ code: -32601, message: "Method not found" });
    };
    const provider = createProvider(client);
    await provider.start();

    await expect(provider.readExecution("legacy")).resolves.toMatchObject({
      turnId: "turn-stored",
      steps: [
        { label: "执行命令", status: "completed" },
        { label: "本轮任务完成", status: "completed" },
      ],
    });
    expect(client.threadTurnsListCalls.at(-1)?.itemsView).toBe("full");
    expect(client.threadReadCalls).toEqual([]);
    client.threadTurnsList = async () => {
      throw new CodexRpcError({ code: -32601, message: "Method not found" });
    };
    await expect(provider.readExecution("legacy")).rejects.toMatchObject({
      code: "EXECUTION_DETAIL_UNAVAILABLE",
    });
    expect(client.threadReadCalls).toEqual([]);
  });

  it("shows an empty execution record for a new thread before its first user message", async () => {
    const client = new FakeClient();
    client.version = "0.162.1";
    client.threadTurnsList = async ({ threadId }) => {
      throw new CodexRpcError({
        code: -32600,
        message: `thread ${threadId} is not materialized yet; thread/turns/list is unavailable before first user message`,
      });
    };
    const provider = createProvider(client);
    await provider.start();
    const created = await provider.createThread({ cwd: "/tmp/project" });

    await expect(provider.readExecution(created.id)).resolves.toMatchObject({
      turnId: "",
      steps: [],
      truncated: false,
    });
    expect(client.threadReadCalls).toEqual([]);
    expect(client.turnStartCalls).toEqual([]);
    expect(client.threadItemsListCalls).toEqual([]);
    expect(created.capabilities.send).toBe(true);
  });

  it.each([
    { code: -32600, message: "Invalid pagination limit" },
    { code: -32600, message: "thread other-thread is not materialized yet; thread/turns/list is unavailable before first user message" },
    { code: -32001, message: "thread managed-1 is not materialized yet; thread/turns/list is unavailable before first user message" },
  ])("preserves unrelated history errors: $code $message", async (error) => {
    const client = new FakeClient();
    const rpcError = new CodexRpcError(error);
    client.threadTurnsList = async () => { throw rpcError; };
    const provider = createProvider(client);
    await provider.start();
    const created = await provider.createThread({ cwd: "/tmp/project" });

    await expect(provider.readExecution(created.id)).rejects.toBe(rpcError);
  });

  it("keeps a persisted but unloaded App Server thread read-only until explicitly managed", async () => {
    const client = new FakeClient();
    client.threads = [
      makeThread({
        id: "persisted",
        source: "appServer",
        status: { type: "notLoaded" },
        canAcceptDirectInput: null,
      }),
    ];
    const provider = createProvider(client);
    await provider.start();

    expect((await provider.list())[0]).toMatchObject({
      surface: "managed",
      activityState: "unknown",
      stale: true,
      capabilities: { send: false, steer: false, interrupt: false },
    });
    await expect(provider.sendMessage("persisted", "do not resume implicitly")).rejects.toMatchObject({
      code: "SESSION_NOT_MANAGED",
    });
  });

  it("treats a threadStart result as owned even when Codex reports a subAgent source object", async () => {
    const client = new FakeClient();
    client.threadStartSource = { subAgent: { kind: "agentControl" } };
    const provider = createProvider(client);
    await provider.start();

    const created = await provider.createThread({ cwd: "/tmp/subagent-owned" });

    expect(created).toMatchObject({
      conversationId: "managed-1",
      surface: "managed",
      activityState: "idle",
      capabilities: { send: true, steer: false, interrupt: false },
    });
    await provider.sendMessage(created.id, "owned source objects remain controllable");
    expect(client.turnStartCalls).toEqual([
      { threadId: "managed-1", text: "owned source objects remain controllable" },
    ]);
  });

  it("does not grant ownership to an arbitrary loaded subAgent notification", async () => {
    const client = new FakeClient();
    const foreign = makeThread({
      id: "foreign-subagent",
      source: { subAgent: { kind: "agentControl" } },
      status: { type: "idle" },
      canAcceptDirectInput: true,
    });
    client.threads = [foreign];
    client.loaded.add(foreign.id);
    const provider = createProvider(client);
    await provider.start();

    client.emit({
      type: "notification",
      notification: { method: "thread/started", params: { thread: foreign } },
    });

    expect((await provider.list())[0]).toMatchObject({
      conversationId: "foreign-subagent",
      surface: "legacy",
      capabilities: { send: false, steer: false, interrupt: false },
    });
    await expect(provider.sendMessage(foreign.id, "must stay read-only")).rejects.toMatchObject({
      code: "SESSION_NOT_MANAGED",
    });
    expect(client.turnStartCalls).toEqual([]);
  });

  it("starts when idle, steers only with the known active turn, and interrupts that turn", async () => {
    const client = new FakeClient();
    client.threads = [makeThread({ id: "managed", source: "appServer", status: { type: "idle" } })];
    client.loaded.add("managed");
    const provider = createProvider(client);
    await provider.start();

    await provider.sendMessage("codex:managed", "first task");
    await provider.sendMessage("managed", "additional detail");
    await provider.interrupt("managed");

    expect(client.turnStartCalls).toEqual([{ threadId: "managed", text: "first task" }]);
    expect(client.turnSteerCalls).toEqual([
      { threadId: "managed", expectedTurnId: "turn-1", text: "additional detail" },
    ]);
    expect(client.turnInterruptCalls).toEqual([{ threadId: "managed", turnId: "turn-1" }]);
  });

  it("fails closed rather than guessing an active turn id", async () => {
    const client = new FakeClient();
    client.threads = [
      makeThread({ id: "managed", source: "appServer", status: { type: "active", activeFlags: [] } }),
    ];
    client.loaded.add("managed");
    const provider = createProvider(client);
    await provider.start();

    await expect(provider.sendMessage("managed", "do not guess")).rejects.toMatchObject({
      code: "TURN_ID_UNKNOWN",
    });
    expect(client.turnSteerCalls).toEqual([]);
  });

  it("exposes only server-provided command decisions and correlates the approval response", async () => {
    const client = managedClient();
    const provider = createProvider(client);
    await provider.start();

    client.emitRequest({
      id: 42,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "managed",
        turnId: "turn-live",
        itemId: "command-1",
        startedAtMs: NOW.getTime(),
        command: "npm test",
        cwd: "/tmp/project",
        reason: "Run tests",
        availableDecisions: ["accept", "decline"],
      },
    });

    const pending = (await provider.list())[0]?.pendingRequest;
    expect(pending).toMatchObject({
      kind: "approval",
      command: "npm test",
      choices: [
        { id: "accept", label: "允许一次" },
        { id: "decline", label: "拒绝" },
      ],
    });
    if (!pending) throw new Error("pending request missing");
    await provider.respondRequest("managed", pending.requestId, { choiceId: "accept" });

    expect(client.responses).toEqual([{ id: 42, result: { decision: "accept" } }]);
    expect((await provider.list())[0]?.pendingRequest).toBeUndefined();
    await expect(
      provider.respondRequest("managed", pending.requestId, { choiceId: "accept" }),
    ).rejects.toBeInstanceOf(CodexProviderError);
  });

  it("declines and clears a pending approval when its managed thread closes", async () => {
    const client = managedClient();
    const provider = createProvider(client);
    await provider.start();

    client.emitRequest({
      id: "closing-approval",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "managed",
        turnId: "turn-live",
        itemId: "command-closing",
        startedAtMs: NOW.getTime(),
        command: "npm test",
        cwd: "/tmp/project",
        reason: "Run tests",
        availableDecisions: ["accept", "decline"],
      },
    });
    client.emitRequest({
      id: "closing-file-approval",
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "managed",
        turnId: "turn-live",
        itemId: "file-closing",
        startedAtMs: NOW.getTime(),
        reason: "Write test output",
      },
    });

    const pending = (await provider.list())[0]?.pendingRequest;
    if (!pending) throw new Error("pending request missing");

    client.emit({
      type: "notification",
      notification: { method: "thread/closed", params: { threadId: "managed" } },
    });

    expect(client.responses).toEqual([
      { id: "closing-approval", result: { decision: "decline" } },
      { id: "closing-file-approval", result: { decision: "decline" } },
    ]);
    expect((await provider.list())[0]).toMatchObject({
      activityState: "unknown",
      attentionReason: null,
      currentActivity: "会话已关闭",
      capabilities: { send: false, steer: false, interrupt: false },
    });
    expect((await provider.list())[0]?.pendingRequest).toBeUndefined();
    await expect(
      provider.respondRequest("managed", pending.requestId, { choiceId: "accept" }),
    ).rejects.toMatchObject({ code: "SESSION_NOT_MANAGED" });
    expect(client.responses).toHaveLength(2);
  });

  it("shows permission scope and grants only the requested permissions for the current turn", async () => {
    const client = managedClient();
    const provider = createProvider(client);
    await provider.start();

    client.emitRequest({
      id: "permission-rpc",
      method: "item/permissions/requestApproval",
      params: {
        threadId: "managed",
        turnId: "turn-live",
        itemId: "permission-1",
        environmentId: null,
        startedAtMs: NOW.getTime(),
        cwd: "/tmp/project",
        reason: "Build and download dependencies",
        permissions: {
          network: { enabled: true },
          fileSystem: {
            read: ["/tmp/input"],
            write: ["/tmp/output"],
            entries: [
              { path: { type: "path", path: "/tmp/input" }, access: "read" },
              { path: { type: "path", path: "/tmp/output" }, access: "write" },
              { path: { type: "glob_pattern", pattern: "/tmp/cache/**" }, access: "write" },
            ],
          },
        },
      },
    });

    const pending = (await provider.list())[0]?.pendingRequest;
    expect(pending).toMatchObject({
      kind: "approval",
      title: "运行权限需要确认",
      cwd: "/tmp/project",
      choices: [
        { id: "grantTurn", label: "允许本次任务" },
        { id: "decline", label: "拒绝" },
      ],
    });
    if (!pending) throw new Error("permission request missing");
    const detail = pending.detail ?? "";
    expect(detail).toContain("网络：请求启用");
    expect(detail).toContain("文件读取：/tmp/input");
    expect(detail).toContain("文件写入：/tmp/output");
    expect(detail).toContain("/tmp/cache/**");
    expect(detail.match(/\/tmp\/input/g)).toHaveLength(1);
    expect(detail.match(/\/tmp\/output/g)).toHaveLength(1);
    expect(pending.choices.some((choice) => choice.id.includes("session"))).toBe(false);

    await provider.respondRequest("managed", pending.requestId, { choiceId: "grantTurn" });

    client.emitRequest({
      id: "permission-decline",
      method: "item/permissions/requestApproval",
      params: {
        threadId: "managed",
        turnId: "turn-live",
        itemId: "permission-2",
        environmentId: null,
        startedAtMs: NOW.getTime(),
        cwd: "/tmp/project",
        reason: "Optional network",
        permissions: { network: { enabled: true }, fileSystem: null },
      },
    });
    const decline = (await provider.list())[0]?.pendingRequest;
    if (!decline) throw new Error("second permission request missing");
    await provider.respondRequest("managed", decline.requestId, { choiceId: "decline" });

    expect(client.responses).toEqual([
      {
        id: "permission-rpc",
        result: {
          permissions: {
            network: { enabled: true },
            fileSystem: {
              read: ["/tmp/input"],
              write: ["/tmp/output"],
              entries: [
                { path: { type: "path", path: "/tmp/input" }, access: "read" },
                { path: { type: "path", path: "/tmp/output" }, access: "write" },
                { path: { type: "glob_pattern", pattern: "/tmp/cache/**" }, access: "write" },
              ],
            },
          },
          scope: "turn",
        },
      },
      {
        id: "permission-decline",
        result: { permissions: {}, scope: "turn" },
      },
    ]);
  });

  it("declines permission requests from threads it does not own with an empty turn grant", async () => {
    const client = managedClient();
    const provider = createProvider(client);
    await provider.start();

    client.emitRequest({
      id: "foreign-permission",
      method: "item/permissions/requestApproval",
      params: {
        threadId: "not-owned",
        turnId: "turn-foreign",
        itemId: "permission-foreign",
        environmentId: null,
        startedAtMs: NOW.getTime(),
        cwd: "/tmp/foreign",
        reason: "Unexpected request",
        permissions: {
          network: { enabled: true },
          fileSystem: null,
        },
      },
    });

    expect(client.responses).toEqual([
      { id: "foreign-permission", result: { permissions: {}, scope: "turn" } },
    ]);
    expect((await provider.list())[0]?.pendingRequest).toBeUndefined();
  });

  it("serializes multi-question requests through the single shared pending-request slot", async () => {
    const client = managedClient();
    const provider = createProvider(client);
    await provider.start();

    client.emitRequest({
      id: "question-rpc",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "managed",
        turnId: "turn-live",
        itemId: "question-1",
        isBlocking: true,
        autoResolutionMs: null,
        questions: [
          {
            id: "runtime",
            header: "Runtime",
            question: "Choose runtime",
            isOther: false,
            isSecret: false,
            options: [{ label: "Node", description: "Use Node.js" }],
          },
          {
            id: "note",
            header: "Note",
            question: "Add a note",
            isOther: true,
            isSecret: false,
            options: null,
          },
        ],
      },
    });

    const first = (await provider.list())[0]?.pendingRequest;
    expect(first?.title).toBe("Runtime");
    if (!first) throw new Error("first question missing");
    await provider.respondRequest("managed", first.requestId, { choiceId: "option:0" });

    const second = (await provider.list())[0]?.pendingRequest;
    expect(second?.title).toBe("Note");
    expect(second?.requestId).not.toBe(first.requestId);
    if (!second) throw new Error("second question missing");
    await provider.respondRequest("managed", second.requestId, {
      choiceId: "other",
      text: "Keep it local",
    });

    expect(client.responses).toEqual([
      {
        id: "question-rpc",
        result: {
          answers: {
            runtime: { answers: ["Node"] },
            note: { answers: ["Keep it local"] },
          },
        },
      },
    ]);
  });

  it("uses real plan counts and raises attention when a turn completes", async () => {
    const client = managedClient();
    const provider = createProvider(client);
    const upserts = vi.fn();
    provider.subscribe((event) => {
      if (event.type === "session-upsert") upserts(event.session);
    });
    await provider.start();

    client.emit({
      type: "notification",
      notification: {
        method: "turn/plan/updated",
        params: {
          threadId: "managed",
          turnId: "turn-live",
          explanation: "Working through the plan",
          plan: [
            { step: "Inspect", status: "completed" },
            { step: "Implement", status: "inProgress" },
            { step: "Verify", status: "pending" },
          ],
        },
      },
    });
    client.emit({
      type: "notification",
      notification: {
        method: "turn/completed",
        params: {
          threadId: "managed",
          turn: {
            id: "turn-live",
            items: [],
            itemsView: "full",
            status: "completed",
            error: null,
            startedAt: Math.floor(NOW.getTime() / 1_000),
            completedAt: Math.floor(NOW.getTime() / 1_000),
            durationMs: 1_000,
          },
        },
      },
    });

    const summary = (await provider.list())[0];
    expect(summary?.plan).toMatchObject({ done: 1, total: 3 });
    expect(summary).toMatchObject({
      activityState: "idle",
      attentionReason: "newly_completed",
      currentActivity: "任务已完成",
    });
    expect(upserts).toHaveBeenCalled();
  });

  it("keeps an unsupported version readable and auto-declines approval requests", async () => {
    const client = managedClient();
    client.version = "0.154.0";
    client.writable = false;
    const provider = createProvider(client);
    await provider.start();

    expect(provider.getHealth()).toMatchObject({ codex: "readonly", codexVersion: "0.154.0" });
    await expect(provider.createThread({ cwd: "/tmp/project" })).rejects.toMatchObject({
      code: "READ_ONLY_PROTOCOL_VERSION",
    });

    client.emitRequest({
      id: 9,
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "managed",
        turnId: "turn-live",
        itemId: "file-1",
        startedAtMs: NOW.getTime(),
      },
    });
    expect(client.responses).toEqual([{ id: 9, result: { decision: "decline" } }]);
    expect((await provider.list())[0]?.pendingRequest).toBeUndefined();
  });

  it("rejects secret questions without putting them in the attention inbox", async () => {
    const client = managedClient();
    const provider = createProvider(client);
    await provider.start();

    client.emitRequest({
      id: "secret",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "managed",
        turnId: "turn-live",
        itemId: "secret-item",
        isBlocking: true,
        autoResolutionMs: null,
        questions: [
          {
            id: "password",
            header: "Password",
            question: "Enter password",
            isOther: true,
            isSecret: true,
            options: null,
          },
        ],
      },
    });

    expect(client.rejections).toEqual([
      {
        id: "secret",
        code: -32002,
        message: "Session Atlas does not collect secret or empty user-input requests.",
      },
    ]);
    expect((await provider.list())[0]?.pendingRequest).toBeUndefined();
  });
});

function createProvider(client: FakeClient): CodexProvider {
  return new CodexProvider({ client, now: () => new Date(NOW) });
}

function managedClient(): FakeClient {
  const client = new FakeClient();
  client.threads = [
    makeThread({
      id: "managed",
      source: "appServer",
      status: { type: "active", activeFlags: [] },
      canAcceptDirectInput: true,
      turns: [
        {
          id: "turn-live",
          items: [],
          itemsView: "full",
          status: "inProgress",
          error: null,
          startedAt: Math.floor(NOW.getTime() / 1_000),
          completedAt: null,
          durationMs: null,
        },
      ],
    }),
  ];
  client.loaded.add("managed");
  return client;
}

function makeThread(overrides: Partial<CodexThread> & Pick<CodexThread, "id">): CodexThread {
  const seconds = Math.floor(NOW.getTime() / 1_000);
  const { id, ...rest } = overrides;
  return {
    id,
    sessionId: `session-${id}`,
    preview: "Build the feature",
    createdAt: seconds,
    updatedAt: seconds,
    recencyAt: seconds,
    status: { type: "idle" },
    cwd: "/tmp/project",
    cliVersion: "0.148.0",
    source: "appServer",
    canAcceptDirectInput: true,
    gitInfo: { sha: null, branch: "main", originUrl: null },
    name: null,
    turns: [],
    ...rest,
  };
}
