import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  CreateThreadInput,
  ItermWindowLayoutRecord,
  RespondRequestInput,
  SessionAtlasHealth,
  SessionExecution,
  SessionSummary,
} from "../../shared/types.js";
import { AttentionStore } from "../attention-store.js";
import type { ServerConfig } from "../config.js";
import { SessionAtlasController } from "../controller.js";
import { createSessionAtlasHttpApplication } from "../http-server.js";
import { LegacyCodexObserver } from "../legacy-codex-observer.js";
import type {
  ItermBridgeHealth,
  ItermRecoveryTarget,
  ItermSessionSnapshot,
  ProviderEvent,
} from "../provider-ports.js";
import { SessionRegistry } from "../session-registry.js";
import { RecoveryStore } from "../recovery-store.js";

const temporaryDirectories: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

function managedSession(cwd: string): SessionSummary {
  const timestamp = new Date().toISOString();
  return {
    id: "managed:one",
    provider: "codex",
    conversationId: "thread-one",
    surface: "managed",
    title: "Managed task",
    cwd,
    projectKey: cwd,
    projectName: "demo",
    activityState: "idle",
    attentionReason: null,
    currentActivity: "Ready",
    lastActivityAt: timestamp,
    observedAt: timestamp,
    stale: false,
    activities: [],
    capabilities: {
      open: true,
      focus: false,
      send: true,
      steer: false,
      interrupt: false,
      approve: false,
      answer: false,
    },
    pinned: false,
    parked: false,
  };
}

class FakeCodex {
  sessions: SessionSummary[];
  messages: Array<{ threadId: string; text: string }> = [];
  executionReads: string[] = [];
  execution: SessionExecution = {
    turnId: "turn-one",
    turnStatus: "in_progress",
    observedAt: "2026-08-20T03:00:00.000Z",
    steps: [
      { id: "received", label: "收到本轮任务", status: "completed" },
      { id: "working", label: "正在处理下一步", status: "in_progress" },
    ],
    truncated: false,
  };
  listeners = new Set<(event: ProviderEvent) => void>();

  constructor(session: SessionSummary) {
    this.sessions = [session];
  }

  async start() {}
  async stop() {}
  getHealth(): SessionAtlasHealth {
    return { controller: "online", codex: "online", iterm: "offline", codexVersion: "0.148.0" };
  }
  async list() {
    return this.sessions;
  }
  async readExecution(threadId: string) {
    this.executionReads.push(threadId);
    return this.execution;
  }
  async createThread(input: CreateThreadInput) {
    const session = managedSession(input.cwd);
    session.id = "managed:created";
    session.conversationId = "thread-created";
    session.title = input.title ?? "Created task";
    this.sessions.push(session);
    return session;
  }
  async sendMessage(threadId: string, text: string) {
    this.messages.push({ threadId, text });
  }
  async interrupt() {}
  async respondRequest(_threadId: string, _requestId: string, _input: RespondRequestInput) {}
  subscribe(listener: (event: ProviderEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

class FakeIterm extends EventEmitter {
  health: ItermBridgeHealth = { status: "online" };
  focused?: string;
  sessions: ItermSessionSnapshot[] = [];
  restored?: ItermWindowLayoutRecord;
  recovered?: { batchId: string; targets: readonly ItermRecoveryTarget[] };
  restoreError?: Error;
  recoveryError?: Error;
  restoreCalls = 0;
  recoveryCalls = 0;
  cleared: Array<{ sessionId: string; conversationId: string }> = [];

  async start() {
    this.emit("snapshot", this.sessions);
  }
  async stop() {}
  getHealth() {
    return this.health;
  }
  getSessions() {
    return this.sessions;
  }
  async focus(sessionId: string) {
    this.focused = sessionId;
  }
  async configureAutoResume() {}
  async clearAutoResume(sessionId: string, conversationId: string) {
    this.cleared.push({ sessionId, conversationId });
  }
  async restoreLayout(layout: ItermWindowLayoutRecord) {
    this.restoreCalls += 1;
    if (this.restoreError) {
      if ((this.restoreError as { code?: string }).code === "WINDOW_RESTORE_PARTIAL") {
        this.emit("restore-uncertain", {
          windowId: layout.windowId,
          createdWindowId: (this.restoreError as { createdWindowId?: string }).createdWindowId,
        });
      }
      throw this.restoreError;
    }
    this.restored = layout;
    return "restored-window-1";
  }
  async restoreRecoveries(batchId: string, targets: readonly ItermRecoveryTarget[]) {
    this.recoveryCalls += 1;
    if (this.recoveryError) {
      if ((this.recoveryError as { code?: string }).code === "WINDOW_RESTORE_PARTIAL") {
        this.emit("restore-uncertain", { windowId: batchId });
      }
      throw this.recoveryError;
    }
    this.recovered = { batchId, targets };
  }
}

async function makeApplication(options: { seedClosedRecovery?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "session-atlas-http-"));
  temporaryDirectories.push(directory);
  const projectRoot = join(directory, "Code");
  const project = join(projectRoot, "demo");
  const staticDir = join(directory, "dist", "client");
  await Promise.all([mkdir(project, { recursive: true }), mkdir(staticDir, { recursive: true })]);
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>Session Atlas</title>");
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    development: false,
    allowedProjectRoots: [projectRoot],
    deniedProjectRoots: [],
    applicationSupportDir: join(directory, "state"),
    attentionStateFile: join(directory, "state", "state.json"),
    recoveryStateFile: join(directory, "state", "recovery.json"),
    itermSocketPath: join(directory, "state", "bridge.sock"),
    staticDir,
    maxJsonBytes: 4_096,
    staleAfterMs: 45_000,
    autoResumeEnabled: false,
  };
  const codex = new FakeCodex(managedSession(project));
  const iterm = new FakeIterm();
  iterm.sessions.push({
    sessionId: "terminal-one",
    name: "Terminal",
    cwd: project,
    tty: "/dev/ttys001",
    jobName: "zsh",
    focused: false,
    buried: false,
    windowId: "window-1",
    tabId: "tab-1",
    windowIndex: 1,
    tabIndex: 1,
    paneIndex: 1,
    splitPath: [{ vertical: true, index: 0 }],
    observedAt: new Date().toISOString(),
  });
  const store = new AttentionStore(config.attentionStateFile);
  const recoveryStore = new RecoveryStore(config.recoveryStateFile);
  if (options.seedClosedRecovery) {
    await recoveryStore.load();
    const observedAt = new Date(Date.now() - 60_000).toISOString();
    await recoveryStore.observe(
      [
        {
          ...iterm.sessions[0]!,
          name: "Demo (codex)",
          jobName: "codex",
          commandLine: "codex",
          observedAt,
        },
      ],
      [
        {
          status: "linked",
          conversationId: "01234567-89ab-cdef-8123-456789abcdef",
        },
      ],
    );
    await recoveryStore.observe(
      [{ ...iterm.sessions[0]!, observedAt: new Date().toISOString() }],
      [{ status: "unlinked" }],
    );
  }
  const registry = new SessionRegistry(store, recoveryStore, config.staleAfterMs);
  const codexHome = join(directory, ".codex");
  if (options.seedClosedRecovery) {
    const sessions = join(codexHome, "sessions", "2026", "09", "02");
    const id = "01234567-89ab-cdef-8123-456789abcdef";
    await mkdir(sessions, { recursive: true });
    await writeFile(join(sessions, `rollout-2026-09-02T00-00-00-${id}.jsonl`),
      JSON.stringify({ type: "session_meta", payload: { id, cwd: project, source: "cli" } }) + "\n");
  }
  const controller = new SessionAtlasController({
    config,
    registry,
    codex,
    iterm,
    legacyCodexObserver: new LegacyCodexObserver({ codexHome }),
  });
  await controller.start();
  const application = await createSessionAtlasHttpApplication(controller, config);
  await application.listen();
  const address = application.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => {
    await application.close();
    await controller.stop();
  });
  return { baseUrl, codex, iterm, controller, project, directory, codexHome };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function rawRequest(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest(
      url,
      { method: options.method, headers: options.headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => {
          resolveRequest({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.once("error", rejectRequest);
    request.end(options.body);
  });
}

describe("Session Atlas HTTP server", () => {
  it("serves snapshots, static UI, and SSE from loopback", async () => {
    const { baseUrl } = await makeApplication();
    const snapshotResponse = await fetch(`${baseUrl}/api/sessions`);
    expect(snapshotResponse.status).toBe(200);
    const snapshot = (await snapshotResponse.json()) as { sessions: SessionSummary[] };
    expect(snapshot.sessions.map((session) => session.id)).toEqual(
      expect.arrayContaining(["managed:one", "iterm:terminal-one"]),
    );

    const page = await fetch(baseUrl);
    expect(await page.text()).toContain("Session Atlas");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");

    const abort = new AbortController();
    const events = await fetch(`${baseUrl}/api/events`, { signal: abort.signal });
    const firstChunk = await events.body!.getReader().read();
    abort.abort();
    expect(Buffer.from(firstChunk.value!).toString("utf8")).toContain('"type":"snapshot"');
  });

  it("preflights an inherited split profile before it resumes an active Codex thread", async () => {
    const { baseUrl, controller, iterm, project } = await makeApplication();
    const conversationId = "01234567-89ab-cdef-8123-456789abcdef";
    const originalTerminalId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const duplicateTerminalId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await controller.registry.upsert({
      ...managedSession(project),
      id: `iterm:${originalTerminalId}`,
      conversationId,
      surface: "legacy",
      terminalSessionId: originalTerminalId,
    });

    const duplicate = await fetch(`${baseUrl}/api/recoveries/preflight`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId, terminalSessionId: duplicateTerminalId }),
    });
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toEqual({
      activeElsewhere: true,
      duplicateProfileCleared: true,
    });
    expect(iterm.cleared).toContainEqual({
      sessionId: duplicateTerminalId,
      conversationId,
    });

    const original = await fetch(`${baseUrl}/api/recoveries/preflight`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId, terminalSessionId: originalTerminalId }),
    });
    await expect(original.json()).resolves.toEqual({
      activeElsewhere: false,
      duplicateProfileCleared: false,
    });
  });

  it("atomically grants only one concurrent auto-resume preflight", async () => {
    const { baseUrl, iterm } = await makeApplication();
    const conversationId = "01234567-89ab-cdef-8123-456789abcdef";
    const terminalIds = [
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ];
    const responses = await Promise.all(
      terminalIds.map((terminalSessionId) =>
        fetch(`${baseUrl}/api/recoveries/preflight`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversationId, terminalSessionId }),
        }),
      ),
    );
    const results = await Promise.all(responses.map((response) => response.json())) as Array<{
      activeElsewhere: boolean;
      duplicateProfileCleared: boolean;
    }>;

    expect(results.map((result) => result.activeElsewhere).sort()).toEqual([false, true]);
    expect(iterm.cleared).toHaveLength(1);
    expect(results.find((result) => result.activeElsewhere)).toMatchObject({
      duplicateProfileCleared: true,
    });

    iterm.health = { status: "offline" };
    iterm.emit("health", iterm.health);
    iterm.health = { status: "online" };
    iterm.emit("health", iterm.health);
    const beforeReconnectSnapshot = await fetch(`${baseUrl}/api/recoveries/preflight`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId, terminalSessionId: terminalIds[0] }),
    });
    expect(beforeReconnectSnapshot.status).toBe(503);
  });

  it("disarms every currently marked iTerm recovery profile before uninstall", async () => {
    const { baseUrl, iterm } = await makeApplication();
    const conversationId = "01234567-89ab-cdef-8123-456789abcdef";
    iterm.sessions[0] = {
      ...iterm.sessions[0]!,
      autoResumeConversationId: conversationId,
      autoResumeKind: "helper",
    };

    const response = await fetch(`${baseUrl}/api/recoveries/disarm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ cleared: 1 });
    expect(iterm.cleared).toEqual([{ sessionId: "terminal-one", conversationId }]);
  });

  it("reads a selected Codex thread execution record without exposing it in the session list", async () => {
    const { baseUrl, codex } = await makeApplication();
    codex.sessions[0]!.plan = {
      done: 0,
      total: 1,
      steps: [{ id: "inspect", label: "检查现状", status: "in_progress" }],
    };
    const detail = await fetch(`${baseUrl}/api/sessions/managed%3Aone/detail`);

    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      sessionId: "managed:one",
      execution: {
        turnId: "turn-one",
        steps: [
          { label: "收到本轮任务", status: "completed" },
          { label: "正在处理下一步", status: "in_progress" },
        ],
      },
    });
    expect(codex.executionReads).toEqual(["thread-one"]);

    const unlinked = await fetch(`${baseUrl}/api/sessions/iterm%3Aterminal-one/detail`);
    expect(unlinked.status).toBe(200);
    await expect(unlinked.json()).resolves.toMatchObject({
      sessionId: "iterm:terminal-one",
      message: expect.stringContaining("不是已关联的 Codex 线程"),
    });
    expect(codex.executionReads).toEqual(["thread-one"]);

    const wrongMethod = await fetch(`${baseUrl}/api/sessions/managed%3Aone/detail`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET");
  });

  it("rejects external origins, non-JSON mutations, and unsupported fields", async () => {
    const { baseUrl } = await makeApplication();
    const external = await fetch(`${baseUrl}/api/sessions`, {
      headers: { Origin: "https://example.com" },
    });
    expect(external.status).toBe(403);
    await expect(external.json()).resolves.toMatchObject({ error: { code: "FORBIDDEN_ORIGIN" } });

    const nonJson = await fetch(`${baseUrl}/api/sessions/managed%3Aone/messages`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "hello",
    });
    expect(nonJson.status).toBe(415);

    const extra = await fetch(`${baseUrl}/api/sessions/managed%3Aone/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello", command: "rm -rf" }),
    });
    expect(extra.status).toBe(400);
    await expect(extra.json()).resolves.toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  });

  it("allows a cross-site top-level GET navigation but still rejects cross-site API writes", async () => {
    const { baseUrl } = await makeApplication();
    const page = await rawRequest(baseUrl, {
      headers: {
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document",
      },
    });
    expect(page.status).toBe(200);
    expect(page.body).toContain("Session Atlas");

    const mutation = await rawRequest(`${baseUrl}/api/threads`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
      },
      body: JSON.stringify({ cwd: "/tmp/never-created" }),
    });
    expect(mutation.status).toBe(403);
    expect(JSON.parse(mutation.body)).toMatchObject({
      error: { code: "FORBIDDEN_ORIGIN" },
    });
  });

  it("validates project roots and gates actions by session capabilities", async () => {
    const { baseUrl, codex, project, directory } = await makeApplication();
    const created = await fetch(`${baseUrl}/api/threads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: project, title: "New task" }),
    });
    expect(created.status).toBe(201);

    const outside = await fetch(`${baseUrl}/api/threads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: directory }),
    });
    expect(outside.status).toBe(403);

    const readOnly = await fetch(`${baseUrl}/api/sessions/iterm%3Aterminal-one/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "unsafe" }),
    });
    expect(readOnly.status).toBe(409);
    await expect(readOnly.json()).resolves.toMatchObject({
      error: { code: "CAPABILITY_UNAVAILABLE" },
    });

    const sent = await fetch(`${baseUrl}/api/sessions/managed%3Aone/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "continue" }),
    });
    expect(sent.status).toBe(202);
    expect(codex.messages).toEqual([{ threadId: "thread-one", text: "continue" }]);
  });

  it("focuses the exact legacy target and persists attention changes", async () => {
    const { baseUrl, iterm } = await makeApplication();
    const focused = await fetch(`${baseUrl}/api/sessions/iterm%3Aterminal-one/focus`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(focused.status).toBe(200);
    expect(iterm.focused).toBe("terminal-one");

    const patched = await fetch(`${baseUrl}/api/sessions/managed%3Aone/attention`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: true, title: "Priority" }),
    });
    expect(patched.status).toBe(200);
    await expect(patched.json()).resolves.toMatchObject({ pinned: true, title: "Priority" });
  });

  it("restores all selected reboot placeholders in their original iTerm panes", async () => {
    const { baseUrl, iterm } = await makeApplication({ seedClosedRecovery: true });
    const sessionId = "01234567-89ab-cdef-8123-456789abcdef";

    const restored = await fetch(`${baseUrl}/api/recoveries/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionIds: [sessionId] }),
    });

    expect(restored.status).toBe(202);
    await expect(restored.json()).resolves.toEqual({
      requested: 1,
      sessionIds: [sessionId],
    });
    expect(iterm.recoveryCalls).toBe(1);
    expect(iterm.recovered).toMatchObject({
      batchId: expect.stringMatching(/^recovery-batch:/u),
      targets: [
        {
          targetSessionId: "terminal-one",
          cwd: expect.stringContaining("/Code/demo"),
          conversationId: sessionId,
          splitVertical: true,
        },
      ],
    });
  });

  it("returns real request previews for a recorded closed Codex session", async () => {
    const { baseUrl, codexHome } = await makeApplication({ seedClosedRecovery: true });
    const sessionId = "01234567-89ab-cdef-8123-456789abcdef";
    const directory = join(codexHome, "sessions", "2026", "09", "02");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, `rollout-2026-09-02T00-00-00-${sessionId}.jsonl`),
      [
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "把最近关闭的线程内容显示清楚。" }],
          },
        }),
      ].join("\n"),
    );

    const response = await fetch(`${baseUrl}/api/recoveries/previews`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionIds: [sessionId] }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      previews: [
        {
          sessionId,
          status: "available",
          firstRequest: "把最近关闭的线程内容显示清楚。",
          latestRequest: "把最近关闭的线程内容显示清楚。",
        },
      ],
    });
  });

  it("persists a timed-out recovery batch as uncertain before allowing another request", async () => {
    const { baseUrl, iterm } = await makeApplication({ seedClosedRecovery: true });
    const sessionId = "01234567-89ab-cdef-8123-456789abcdef";
    iterm.recoveryError = Object.assign(new Error("restore timed out"), {
      code: "WINDOW_RESTORE_PARTIAL",
    });

    const request = () =>
      fetch(`${baseUrl}/api/recoveries/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionIds: [sessionId] }),
      });
    const first = await request();
    expect(first.status).toBe(409);
    await expect(first.json()).resolves.toMatchObject({
      error: { code: "RECOVERY_RESTORE_UNCERTAIN" },
    });

    const second = await request();
    expect(second.status).toBe(409);
    expect(iterm.recoveryCalls).toBe(1);
  });

  it("rejects batch recovery when the original pane is no longer an idle shell", async () => {
    const { baseUrl, iterm } = await makeApplication({ seedClosedRecovery: true });
    iterm.sessions = iterm.sessions.map((session) => ({ ...session, jobName: "node" }));

    const restored = await fetch(`${baseUrl}/api/recoveries/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionIds: ["01234567-89ab-cdef-8123-456789abcdef"],
      }),
    });

    expect(restored.status).toBe(409);
    expect(iterm.restoreCalls).toBe(0);
  });

  it("restores only a persisted closed window layout", async () => {
    const { baseUrl, iterm, controller } = await makeApplication();
    const active = await fetch(`${baseUrl}/api/layouts/window-1/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(active.status).toBe(409);

    iterm.sessions = [];
    iterm.emit("snapshot", []);
    await waitFor(async () => {
      const snapshot = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as {
        windowLayouts: ItermWindowLayoutRecord[];
      };
      return snapshot.windowLayouts[0]?.status === "closed";
    });

    const restored = await fetch(`${baseUrl}/api/layouts/window-1/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(restored.status).toBe(202);
    expect(iterm.restored).toMatchObject({
      windowId: "window-1",
      status: "closed",
      tabs: [{ panes: [{ cwd: expect.stringContaining("/Code/demo") }] }],
    });

    const duplicate = await fetch(`${baseUrl}/api/layouts/window-1/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toMatchObject({
      error: { code: "WINDOW_LAYOUT_RESTORE_PENDING_OBSERVATION" },
    });
    expect(iterm.restoreCalls).toBe(1);

    iterm.sessions = [
      {
        sessionId: "restored-terminal",
        name: "Restored terminal",
        cwd: iterm.restored!.tabs[0]!.panes[0]!.cwd,
        tty: "/dev/ttys009",
        jobName: "zsh",
        focused: false,
        buried: false,
        windowId: "unrelated-window",
        tabId: "unrelated-tab",
        windowIndex: 2,
        tabIndex: 1,
        paneIndex: 1,
        splitPath: [{ vertical: true, index: 0 }],
        observedAt: new Date().toISOString(),
      },
    ];
    iterm.emit("snapshot", iterm.sessions);
    await waitFor(() => controller.snapshot().windowLayouts.some(
      (layout) => layout.windowId === "unrelated-window",
    ));
    const afterUnrelatedObservation = await fetch(`${baseUrl}/api/layouts/window-1/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(afterUnrelatedObservation.status).toBe(409);
    expect(iterm.restoreCalls).toBe(1);

    iterm.sessions = [
      {
        ...iterm.sessions[0]!,
        windowId: "restored-window-1",
        tabId: "restored-tab",
        observedAt: new Date(Date.now() + 1_000).toISOString(),
      },
    ];
    iterm.emit("snapshot", iterm.sessions);
    await waitFor(() => controller.snapshot().windowLayouts.some(
      (layout) => layout.windowId === "restored-window-1",
    ));
    const afterCorrelatedObservation = await fetch(`${baseUrl}/api/layouts/window-1/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(afterCorrelatedObservation.status).toBe(202);
    expect(iterm.restoreCalls).toBe(2);
  });

  it("keeps a buried live session ineligible for window restoration", async () => {
    const { baseUrl, iterm } = await makeApplication();
    iterm.sessions = iterm.sessions.map((session) => ({
      ...session,
      buried: true,
      windowId: undefined,
      tabId: undefined,
      observedAt: new Date().toISOString(),
    }));
    iterm.emit("snapshot", iterm.sessions);
    await waitFor(async () => {
      const snapshot = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as {
        windowLayouts: ItermWindowLayoutRecord[];
      };
      return snapshot.windowLayouts[0]?.status === "active";
    });

    const restore = await fetch(`${baseUrl}/api/layouts/window-1/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(restore.status).toBe(409);
    expect(iterm.restored).toBeUndefined();
  });

  it("persists a partial restore as uncertain and rejects a second attempt", async () => {
    const { baseUrl, iterm } = await makeApplication();
    iterm.sessions = [];
    iterm.emit("snapshot", []);
    await waitFor(async () => {
      const snapshot = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as {
        windowLayouts: ItermWindowLayoutRecord[];
      };
      return snapshot.windowLayouts[0]?.status === "closed";
    });
    iterm.restoreError = Object.assign(new Error("split RPC failed"), {
      code: "WINDOW_RESTORE_PARTIAL",
      createdWindowId: "created-window-id",
    });

    const first = await fetch(`${baseUrl}/api/layouts/window-1/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(first.status).toBe(409);
    await expect(first.json()).resolves.toMatchObject({
      error: { code: "WINDOW_LAYOUT_RESTORE_UNCERTAIN" },
    });
    const snapshot = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as {
      windowLayouts: ItermWindowLayoutRecord[];
    };
    expect(snapshot.windowLayouts[0]).toMatchObject({
      restoreStatus: "partial",
      createdWindowId: "created-window-id",
    });

    const second = await fetch(`${baseUrl}/api/layouts/window-1/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(second.status).toBe(409);
    expect(iterm.restoreCalls).toBe(1);
  });
});
