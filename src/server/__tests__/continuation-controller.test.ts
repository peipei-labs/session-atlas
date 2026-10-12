import { EventEmitter } from "node:events";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RecoveryRecord, SessionAtlasHealth, SessionSummary, ThreadTagsResult, UpsertHandoffInput } from "../../shared/types.js";
import * as recoveryPreview from "../recovery-preview.js";
import * as continuationRuntime from "../continuation-runtime.js";
import { AttentionStore } from "../attention-store.js";
import { loadConfig } from "../config.js";
import { SessionAtlasController } from "../controller.js";
import { AppError } from "../errors.js";
import { createSessionAtlasHttpApplication } from "../http-server.js";
import { LegacyCodexObserver } from "../legacy-codex-observer.js";
import type {
  ItermBridgeHealth,
  ItermSessionSnapshot,
  ItermThreadRestoreTarget,
  ProviderEvent,
} from "../provider-ports.js";
import { RecoveryStore } from "../recovery-store.js";
import { SessionRegistry } from "../session-registry.js";
import type { BookmarkTitleClient } from "../codex/daemon-titles.js";

const SESSION_ID = "01234567-89ab-cdef-8123-456789abcdef";
const OTHER_SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const temporaryDirectories: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

class EmptyCodex {
  listener?: (event: ProviderEvent) => void;
  async start() {}
  async stop() {}
  getHealth(): SessionAtlasHealth {
    return { controller: "online", codex: "online", iterm: "offline" };
  }
  async list() { return []; }
  async readExecution(): Promise<never> { throw new Error("unused"); }
  async createThread(): Promise<never> { throw new Error("unused"); }
  async sendMessage() {}
  async interrupt() {}
  async respondRequest() {}
  subscribe(listener: (event: ProviderEvent) => void) { this.listener = listener; return () => { this.listener = undefined; }; }
}

class ContinuationIterm extends EventEmitter {
  health: ItermBridgeHealth = { status: "online" };
  sessions: ItermSessionSnapshot[] = [];
  closed: Array<{ terminalSessionId: string; conversationId: string }> = [];
  focused: string[] = [];
  restored: Array<{ target: ItermThreadRestoreTarget; port: number }> = [];
  beforeClose?: () => Promise<void>;
  beforeRestore?: () => Promise<void>;
  restoreError?: Error;
  markerError?: Error;
  markersConfigured: Array<{ terminalSessionId: string; conversationId: string }> = [];
  markersCleared: Array<{ terminalSessionId: string; conversationId: string; forget: boolean }> = [];
  beforeFocus?: () => void;

  async start() { this.emit("snapshot", this.sessions); }
  async stop() {}
  getHealth() { return this.health; }
  getSessions() { return this.sessions; }
  async focus(id: string) { this.focused.push(id); this.beforeFocus?.(); }
  async configureSavedMarker(session: ItermSessionSnapshot, conversationId: string) {
    this.markersConfigured.push({ terminalSessionId: session.sessionId, conversationId });
    if (this.markerError) throw this.markerError;
  }
  async clearSavedMarker(terminalSessionId: string, conversationId: string, forget = true) {
    this.markersCleared.push({ terminalSessionId, conversationId, forget });
    if (this.markerError) throw this.markerError;
  }
  async configureAutoResume() {}
  async clearAutoResume() {}
  async restoreLayout() { return "restored-window"; }
  async restoreRecoveries() {}
  async closeSession(session: ItermSessionSnapshot, conversationId: string) {
    await this.beforeClose?.();
    this.closed.push({ terminalSessionId: session.sessionId, conversationId });
  }
  async restoreThread(target: ItermThreadRestoreTarget, port: number) {
    this.restored.push({ target, port });
    await this.beforeRestore?.();
    if (this.restoreError) throw this.restoreError;
    return { terminalSessionId: "restored-pane", windowId: target.windowId ?? "new-window" };
  }
}

function event(type: "task_started" | "task_complete", turnId = "turn-one", timestamp = new Date(Date.now() - 10_000).toISOString()) {
  return { type: "event_msg", timestamp, payload: { type, turn_id: turnId } };
}

async function makeFixture(options: { active?: boolean; writer?: boolean; observerRetryAfterMs?: number; bookmarkTitleClient?: BookmarkTitleClient } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "session-atlas-continuation-")));
  temporaryDirectories.push(directory);
  const project = join(directory, "Code", "project");
  const codexHome = join(directory, ".codex");
  const rolloutPath = join(codexHome, "sessions", `rollout-${SESSION_ID}.jsonl`);
  await Promise.all([mkdir(project, { recursive: true }), mkdir(join(codexHome, "sessions"), { recursive: true })]);
  const metadata = { type: "session_meta", payload: { id: SESSION_ID, cwd: project, source: "cli" } };
  const writeRollout = async (records: unknown[] = [event("task_started"), event("task_complete")], meta = metadata) => {
    await writeFile(rolloutPath, [meta, ...records].map((record) => JSON.stringify(record)).join("\n") + "\n");
  };
  await writeRollout();
  const config = loadConfig({
    homeDir: directory,
    projectDir: directory,
    applicationSupportDir: join(directory, "state"),
    allowedProjectRoots: [join(directory, "Code")],
    deniedProjectRoots: [],
    development: false,
    autoResumeEnabled: false,
    port: 0,
    env: { NODE_ENV: "production" },
  });
  const registry = new SessionRegistry(
    new AttentionStore(config.attentionStateFile),
    new RecoveryStore(config.recoveryStateFile),
    config.staleAfterMs,
  );
  const iterm = new ContinuationIterm();
  const terminal: ItermSessionSnapshot = {
    sessionId: "original-pane",
    name: "Project (codex)",
    cwd: project,
    tty: "/dev/ttys001",
    jobName: "codex",
    jobPid: 42,
    commandLine: `codex resume ${SESSION_ID}`,
    focused: true,
    buried: false,
    windowId: "original-window",
    tabId: "original-tab",
    windowIndex: 1,
    tabIndex: 2,
    paneIndex: 1,
    profileName: "Work",
    splitPath: [{ vertical: true, index: 0 }],
    observedAt: new Date().toISOString(),
  };
  if (options.active !== false) iterm.sessions = [terminal];
  const inspection: { output?: string; beforeRead?: () => Promise<void> } = {};
  const writerCheck = vi.fn(async () => options.writer ?? false);
  const codex = new EmptyCodex();
  const controller = new SessionAtlasController({
    config,
    registry,
    codex,
    iterm,
    legacyCodexObserver: new LegacyCodexObserver({
      codexHome,
      retryAfterMs: options.observerRetryAfterMs ?? 0,
      readCommand: async (file, args) => {
        if (file.endsWith("/ps")) {
          return iterm.sessions.map((session) => ` ${session.jobPid} 1 ${session.tty?.replace("/dev/", "")} ${session.commandLine}\n`).join("");
        }
        await inspection.beforeRead?.();
        if (inspection.output !== undefined) return inspection.output;
        return args.at(-1)!.split(",").map((pid) => `p${pid}\nn${rolloutPath}\n`).join("");
      },
    }),
    rolloutWriterCheck: writerCheck,
    bookmarkTitleClient: options.bookmarkTitleClient,
  });
  await controller.start();
  cleanups.push(() => controller.stop());
  const input = (overrides: Partial<UpsertHandoffInput> = {}): UpsertHandoffInput => ({
    expectedVersion: registry.getHandoff(SESSION_ID)?.version ?? registry.getHandoff(SESSION_ID)?.updatedAt ?? null,
    cwd: project,
    summary: "发布已完成，等待约定的运行核验",
    source: "thread",
    items: [{ id: "verify", title: "核验运行记录", kind: "condition", condition: "新数据到达", nextAction: "核对新记录是否符合要求", status: "pending" }],
    ...overrides,
  });
  const closeInventory = () => {
    iterm.sessions = [];
    iterm.emit("snapshot", []);
  };
  return { directory, project, codexHome, rolloutPath, config, registry, iterm, terminal, controller, codex, input, writerCheck, writeRollout, metadata, closeInventory, inspection };
}

async function httpFixture(options: { active?: boolean; writer?: boolean; bookmarkTitleClient?: BookmarkTitleClient } = {}) {
  const fixture = await makeFixture(options);
  const application = await createSessionAtlasHttpApplication(fixture.controller, fixture.config);
  await application.listen();
  cleanups.push(() => application.close());
  const baseUrl = `http://127.0.0.1:${(application.server.address() as AddressInfo).port}`;
  const request = (path: string, method = "GET", body?: unknown, signal?: AbortSignal) => fetch(`${baseUrl}${path}`, {
    method,
    signal,
    ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  return { ...fixture, request, server: application.server };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function makeBatchFixture() {
  const f = await makeFixture();
  await f.controller.upsertHandoff(SESSION_ID, f.input());
  f.closeInventory();
  await vi.waitFor(() => expect(f.registry.requireWindowLayout("original-window").status).toBe("closed"));
  f.iterm.sessions = [{ ...f.terminal, jobName: "zsh", commandLine: "zsh" }];
  return { ...f, restore: vi.spyOn(f.iterm, "restoreRecoveries") };
}

function abortableAction(f: Awaited<ReturnType<typeof httpFixture>>, path: string) {
  const disconnected = deferred();
  f.server.once("request", (_request, response) => response.once("close", disconnected.resolve));
  const abort = new AbortController();
  const outcome = f.request(path, "POST", {}, abort.signal).then(
    (response) => ({ response, error: undefined }),
    (error: unknown) => ({ response: undefined, error }),
  );
  return {
    async cancel() {
      abort.abort();
      await disconnected.promise;
      expect((await outcome).error).toMatchObject({ name: "AbortError" });
    },
  };
}

describe("continuation controller", () => {
  it("restores the latest thread directory after the saved directory disappears, keeping the idle shell directory", async () => {
    const f = await makeFixture();
    const saved = await f.controller.upsertHandoff(SESSION_ID, f.input());
    const latestCwd = join(f.directory, "Code", "latest");
    await mkdir(latestCwd);
    await f.writeRollout([{ type: "turn_context", payload: { cwd: latestCwd } }]);
    await rm(f.project, { recursive: true });
    const restore = vi.spyOn(f.iterm, "restoreRecoveries");
    f.iterm.sessions = [{ ...f.terminal, cwd: f.directory, jobName: "zsh", commandLine: "zsh" }];
    f.iterm.emit("snapshot", f.iterm.sessions);
    await vi.waitFor(() => expect(f.registry.requireRecovery(SESSION_ID).status).toBe("closed"));

    await expect(f.controller.restoreRecoveries({ sessionIds: [SESSION_ID] })).resolves.toMatchObject({ requested: 1 });
    expect(restore).toHaveBeenCalledWith(expect.any(String), [expect.objectContaining({
      targetSessionId: f.terminal.sessionId,
      cwd: latestCwd,
      expectedPlaceholderCwd: f.directory,
      conversationId: SESSION_ID,
    })], f.config.port);
    const reloaded = new RecoveryStore(f.config.recoveryStateFile);
    await reloaded.load();
    expect(reloaded.list()[0]).toMatchObject({ cwd: latestCwd, handoff: saved.handoff });
  });

  it.each([
    ["missing", "INVALID_PROJECT_PATH"], ["forbidden", "PROJECT_PATH_FORBIDDEN"],
    ["rollout", "SESSION_RECORD_UNAVAILABLE"], ["writer", "SESSION_ACTIVE_ELSEWHERE"],
  ])("rejects batch recovery with %s runtime evidence and permits a corrected retry", async (reason, code) => {
    const f = await makeBatchFixture();
    if (reason === "rollout") await rm(f.rolloutPath);
    if (reason === "writer") f.writerCheck.mockResolvedValue(true);
    if (reason === "missing" || reason === "forbidden") {
      const cwd = reason === "missing" ? join(f.project, "missing") : f.directory;
      await f.writeRollout([{ type: "turn_context", payload: { cwd } }]);
    }
    await expect(f.controller.restoreRecoveries({ sessionIds: [SESSION_ID] })).rejects.toMatchObject({ code });
    expect(f.restore).not.toHaveBeenCalled();
    expect(f.registry.requireRecovery(SESSION_ID)).toMatchObject({ cwd: f.project });
    expect(f.registry.requireRecovery(SESSION_ID).restoreStatus).toBeUndefined();
    await f.writeRollout();
    f.writerCheck.mockResolvedValue(false);
    await expect(f.controller.restoreRecoveries({ sessionIds: [SESSION_ID] })).resolves.toMatchObject({ requested: 1 });
    expect(f.restore).toHaveBeenCalledTimes(1);
  });

  it.each(["runtime", "persistence"] as const)("reserves batch targets during %s and rechecks before dispatch", async (stage) => {
    const f = await makeBatchFixture();
    const latestCwd = join(f.directory, "Code", "latest");
    await mkdir(latestCwd);
    await f.writeRollout([{ type: "turn_context", payload: { cwd: latestCwd } }]);
    const entered = deferred();
    const gate = deferred();
    if (stage === "runtime") {
      const readRuntime = continuationRuntime.readContinuationRuntime;
      vi.spyOn(continuationRuntime, "readContinuationRuntime").mockImplementationOnce(async (...args) => {
        entered.resolve(); await gate.promise; return readRuntime(...args);
      });
    } else {
      const updateCwd = f.registry.updateRecoveryCwd.bind(f.registry);
      vi.spyOn(f.registry, "updateRecoveryCwd").mockImplementationOnce(async (...args) => {
        entered.resolve(); await gate.promise; return updateCwd(...args);
      });
    }
    const restoring = f.controller.restoreRecoveries({ sessionIds: [SESSION_ID] });
    await entered.promise;
    try {
      await expect(f.controller.resumeHandoff(SESSION_ID)).rejects.toMatchObject({ code: "HANDOFF_BUSY" });
      await expect(f.controller.restoreRecoveries({ sessionIds: [SESSION_ID] })).rejects.toMatchObject({ code: "RECOVERY_RESTORE_IN_PROGRESS" });
      await expect(f.controller.restoreWindowLayout("original-window")).rejects.toMatchObject({ code: "RECOVERY_RESTORE_IN_PROGRESS" });
      if (stage === "runtime") f.iterm.sessions = [{ ...f.iterm.sessions[0]!, cwd: latestCwd }];
      else await f.controller.stop();
    } finally { gate.resolve(); }
    await expect(restoring).rejects.toMatchObject({
      code: stage === "runtime" ? "RECOVERY_NOT_RESTART_PLACEHOLDER" : "ITERM_OFFLINE",
    });
    expect(f.restore).not.toHaveBeenCalled();
  });

  it.each([false, true])("rejects a batch overlapping a reserved or partial layout: partial=%s", async (partial) => {
    const f = await makeBatchFixture();
    if (partial) vi.spyOn(f.iterm, "restoreLayout").mockRejectedValueOnce(
      new AppError(409, "WINDOW_RESTORE_PARTIAL", "test partial layout creation"),
    );
    const restoring = f.controller.restoreWindowLayout("original-window");
    if (partial) await expect(restoring).rejects.toMatchObject({ code: "WINDOW_LAYOUT_RESTORE_UNCERTAIN" });
    else await restoring;
    await expect(f.controller.restoreRecoveries({ sessionIds: [SESSION_ID] })).rejects.toMatchObject({
      code: "RECOVERY_RESTORE_IN_PROGRESS",
    });
    expect(f.restore).not.toHaveBeenCalled();
    expect(f.writerCheck).not.toHaveBeenCalled();
  });

  it("excludes live managed threads from closed previews through lifecycle and read races", async () => {
    const f = await makeFixture({ active: false });
    const managed: SessionSummary = {
      id: SESSION_ID, conversationId: SESSION_ID, provider: "codex", surface: "managed",
      title: "Managed", cwd: f.project, projectKey: f.project, projectName: "project",
      activityState: "idle", attentionReason: null, lastActivityAt: new Date().toISOString(),
      observedAt: new Date().toISOString(), stale: false, activities: [], pinned: false, parked: false,
      capabilities: { open: true, focus: false, send: false, steer: false, interrupt: false, approve: false, answer: false },
    };
    f.codex.listener?.({ type: "session-upsert", session: managed });
    await vi.waitFor(() => expect(f.registry.getSession(SESSION_ID)).toBeDefined());
    const saved = await f.controller.upsertHandoff(SESSION_ID, f.input());
    expect(saved.status).toBe("active");
    const previews = { sessionIds: [SESSION_ID] };
    await expect(f.controller.readRecoveryPreviews(previews)).rejects.toMatchObject({ code: "RECOVERY_STILL_ACTIVE" });
    f.codex.listener?.({ type: "session-upsert", session: { ...managed, surface: "legacy", stale: true } });
    await vi.waitFor(() => expect(f.registry.getSession(SESSION_ID)).toBeUndefined());
    expect(f.controller.readHandoff(SESSION_ID).status).toBe("closed");
    vi.spyOn(recoveryPreview, "readRecoveryPreviews").mockImplementationOnce(async () => {
      await f.registry.upsert(managed);
      return [{ sessionId: SESSION_ID, status: "available", firstRequest: "fixture excerpt" }];
    });
    await expect(f.controller.readRecoveryPreviews(previews)).rejects.toMatchObject({ code: "RECOVERY_STILL_ACTIVE" });
    expect(f.registry.getHandoff(SESSION_ID)).toEqual(saved.handoff);
  });

  it.each(["timestamp", "turn-id", "both"] as const)("closes an existing reference without re-registering after a changed %s", async (change) => {
    const f = await makeFixture();
    const reference = { title: "复用排查结论", reason: "类似问题再次出现时参考" };
    const saved = await f.controller.upsertHandoff(SESSION_ID, f.input({ summary: reference.title, items: [], reference }));
    const at = new Date(Date.parse(saved.handoff!.updatedAt) + (change === "turn-id" ? -1_000 : 1_000)).toISOString();
    const turnId = change === "timestamp" ? "turn-one" : "turn-two";
    await f.writeRollout([event("task_started", turnId, at), event("task_complete", turnId, at)]);
    const close = vi.spyOn(f.iterm, "closeSession");

    await expect(f.controller.closeHandoff(SESSION_ID, f.terminal.sessionId)).resolves.toEqual({
      closed: true, terminalSessionId: f.terminal.sessionId,
    });
    expect(close).toHaveBeenCalledWith(f.terminal, SESSION_ID, {
      rolloutPath: f.rolloutPath, size: (await readFile(f.rolloutPath)).length, mtimeNs: expect.any(String),
    });
    expect(f.registry.getHandoff(SESSION_ID)).toEqual(saved.handoff);
    const persisted = JSON.parse(await readFile(f.config.recoveryStateFile, "utf8"));
    expect(persisted.recoveries[SESSION_ID].handoff).toEqual(saved.handoff);
  });

  it.each(["done", "cancelled"] as const)("keeps a reference reusable when its existing task is %s", async (status) => {
    const f = await makeFixture();
    const reference = { title: "复用排查结论", reason: "类似问题再次出现时参考" };
    const saved = await f.controller.upsertHandoff(SESSION_ID, f.input({
      reference, items: f.input().items.map((item) => ({ ...item, status })),
    }));
    const at = new Date(Date.parse(saved.handoff!.updatedAt) + 1_000).toISOString();
    await f.writeRollout([event("task_started", "turn-two", at), event("task_complete", "turn-two", at)]);

    await expect(f.controller.parkTerminal(f.terminal.sessionId)).resolves.toMatchObject({ closed: true });
    expect(f.registry.getHandoff(SESSION_ID)).toEqual(saved.handoff);
  });

  it.each(["timestamp", "turn-id", "both"] as const)("still requires current pending work alongside a reference after a changed %s", async (change) => {
    const f = await makeFixture();
    const reference = { title: "复用排查结论", reason: "类似问题再次出现时参考" };
    const saved = await f.controller.upsertHandoff(SESSION_ID, f.input({ reference }));
    const at = new Date(Date.parse(saved.handoff!.updatedAt) + (change === "turn-id" ? -1_000 : 1_000)).toISOString();
    const turnId = change === "timestamp" ? "turn-one" : "turn-two";
    await f.writeRollout([event("task_started", turnId, at), event("task_complete", turnId, at)]);

    await expect(f.controller.closeHandoff(SESSION_ID)).rejects.toMatchObject({ code: "HANDOFF_STALE" });
    await expect(f.controller.parkTerminal(f.terminal.sessionId)).rejects.toMatchObject({ code: "HANDOFF_STALE" });
    expect(f.iterm.closed).toEqual([]);
    expect(f.registry.getHandoff(SESSION_ID)).toEqual(saved.handoff);
  });

  it.each(["done", "cancelled", "empty"] as const)("does not authorize saved close for %s work without a reference", async (status) => {
    const f = await makeFixture();
    await f.controller.upsertHandoff(SESSION_ID, f.input({
      items: status === "empty" ? [] : f.input().items.map((item) => ({ ...item, status })),
    }));
    await expect(f.controller.closeHandoff(SESSION_ID)).rejects.toMatchObject({ code: "HANDOFF_REQUIRED" });
    await expect(f.controller.parkTerminal(f.terminal.sessionId)).rejects.toMatchObject({ code: "HANDOFF_REQUIRED" });
    expect(f.iterm.closed).toEqual([]);
  });

  it.each(["running", "unknown", "requires-process"] as const)("keeps reference-only panes open when %s", async (reason) => {
    const f = await makeFixture();
    const reference = { title: "复用排查结论", reason: "类似问题再次出现时参考" };
    await f.controller.upsertHandoff(SESSION_ID, f.input({
      summary: reference.title, items: [], reference, requiresRunningProcess: reason === "requires-process",
    }));
    if (reason === "running") await f.writeRollout([event("task_started")]);
    if (reason === "unknown") await appendFile(f.rolloutPath, '{"type":"event_msg"');
    const code = reason === "requires-process" ? "SESSION_REQUIRES_PROCESS" : "SESSION_NOT_IDLE";
    await expect(f.controller.closeHandoff(SESSION_ID)).rejects.toMatchObject({ code });
    await expect(f.controller.parkTerminal(f.terminal.sessionId)).rejects.toMatchObject({ code });
    expect(f.iterm.closed).toEqual([]);
    expect(f.registry.getHandoff(SESSION_ID)).toMatchObject({ reference, items: [] });
  });

  it("does not use a reference to bypass exact pane identity or an active rollout writer", async () => {
    const f = await makeFixture({ writer: true });
    const reference = { title: "复用排查结论", reason: "类似问题再次出现时参考" };
    await f.controller.upsertHandoff(SESSION_ID, f.input({ summary: reference.title, items: [], reference }));
    await expect(f.controller.closeHandoff(SESSION_ID, "another-pane")).rejects.toMatchObject({ code: "SESSION_TARGET_CHANGED" });
    f.closeInventory();
    await expect(f.controller.resumeHandoff(SESSION_ID)).rejects.toMatchObject({ code: "SESSION_ACTIVE_ELSEWHERE" });
    expect(f.iterm.closed).toEqual([]);
    expect(f.iterm.focused).toEqual([]);
    expect(f.iterm.restored).toEqual([]);
    expect(f.controller.readHandoff(SESSION_ID).restoreStatus).toBeUndefined();
    expect(f.registry.getHandoff(SESSION_ID)?.reference).toEqual(reference);
  });

  it("saves a handoff while an unrelated inventory observation is blocked and retains it after ingestion", async () => {
    const f = await makeFixture();
    let signalObservationEntered!: () => void;
    let releaseObservation!: () => void;
    let signalObservationPersisted!: () => void;
    let observationReleased = false;
    const entered = new Promise<void>((resolve) => { signalObservationEntered = resolve; });
    const gate = new Promise<void>((resolve) => { releaseObservation = resolve; });
    const persisted = new Promise<void>((resolve) => { signalObservationPersisted = resolve; });
    const observeRecoveries = f.registry.observeRecoveries.bind(f.registry);
    vi.spyOn(f.registry, "observeRecoveries").mockImplementationOnce(async (sessions, matches) => {
      await observeRecoveries(sessions, matches);
      signalObservationPersisted();
    });
    vi.spyOn(f.controller.legacyCodexObserver, "observeAll").mockImplementationOnce(async () => {
      signalObservationEntered();
      await gate;
      observationReleased = true;
      return [{ status: "linked", conversationId: SESSION_ID }];
    });
    f.iterm.sessions = [{ ...f.terminal, name: "Updated project (codex)" }];
    f.iterm.emit("snapshot", f.iterm.sessions);
    await entered;

    let saved = false;
    const registration = f.controller.upsertHandoff(SESSION_ID, f.input()).then((record) => {
      saved = true;
      return record;
    });
    try {
      await vi.waitFor(() => expect(saved).toBe(true), { timeout: 1_000, interval: 10 });
      expect(observationReleased).toBe(false);
      const record = await registration;
      expect(record.handoff?.summary).toBe(f.input().summary);
      const state = JSON.parse(await readFile(f.config.recoveryStateFile, "utf8"));
      expect(state.recoveries[SESSION_ID].handoff.summary).toBe(f.input().summary);
      expect(f.iterm.closed).toEqual([]);
    } finally {
      releaseObservation();
      await registration;
      await persisted;
    }

    expect(f.controller.readHandoff(SESSION_ID)).toMatchObject({
      title: "Updated project (codex)",
      handoff: { summary: f.input().summary, sourceTurnId: "turn-one" },
    });
    const reloaded = new RecoveryStore(f.config.recoveryStateFile);
    await reloaded.load();
    expect(reloaded.getHandoff(SESSION_ID)?.summary).toBe(f.input().summary);
  });

  it("allows registration without terminal metadata but refuses closing an unlinked target", async () => {
    const f = await makeFixture({ active: false });
    const saved = await f.controller.upsertHandoff(SESSION_ID, f.input());
    expect(saved).toMatchObject({ sessionId: SESSION_ID, cwd: f.project, status: "closed" });
    expect(saved.terminalSessionId).toBeUndefined();
    expect(saved.savedLocation).toBeUndefined();
    const state = JSON.parse(await readFile(f.config.recoveryStateFile, "utf8"));
    expect(state.recoveries[SESSION_ID].handoff.summary).toBe(f.input().summary);
    await expect(f.controller.closeHandoff(SESSION_ID)).rejects.toMatchObject({ code: "SESSION_TARGET_CHANGED" });
    expect(f.iterm.closed).toEqual([]);
  });

  it("registers without closing and saves the exact final position durably before explicit close", async () => {
    const f = await makeFixture();
    const saved = await f.controller.upsertHandoff(SESSION_ID, f.input());
    expect(saved.handoff?.sourceTurnId).toBe("turn-one");
    expect(f.iterm.closed).toEqual([]);
    f.iterm.sessions = [{ ...f.terminal, tabId: "moved-tab", tabIndex: 3 }];
    f.iterm.beforeClose = async () => {
      const persisted = JSON.parse(await readFile(f.config.recoveryStateFile, "utf8"));
      expect(persisted.recoveries[SESSION_ID]).toMatchObject({
        handoff: { summary: f.input().summary },
        savedLocation: { windowId: "original-window", tabId: "moved-tab", tabIndex: 3 },
      });
    };

    await expect(f.controller.parkTerminal(f.terminal.sessionId)).resolves.toEqual({ closed: true, terminalSessionId: f.terminal.sessionId });
    expect(f.iterm.closed).toEqual([{ terminalSessionId: f.terminal.sessionId, conversationId: SESSION_ID }]);
    expect(f.registry.getHandoff(SESSION_ID)?.items[0]?.status).toBe("pending");
  });

  it("does not close if close-time recovery persistence fails", async () => {
    const f = await makeFixture();
    await f.controller.upsertHandoff(SESSION_ID, f.input());
    vi.spyOn(f.registry, "saveRecoveryLocation").mockRejectedValueOnce(new Error("test write failure"));
    await expect(f.controller.closeHandoff(SESSION_ID)).rejects.toThrow("test write failure");
    expect(f.iterm.closed).toEqual([]);
  });

  it("keeps ordinary completed closures out of the pending list", async () => {
    const f = await makeFixture();
    await expect(f.controller.parkTerminal(f.terminal.sessionId)).rejects.toMatchObject({ code: "HANDOFF_REQUIRED" });
    expect(f.iterm.closed).toEqual([]);
    f.closeInventory();
    await vi.waitFor(() => expect(f.controller.readHandoff(SESSION_ID)).toMatchObject({ status: "closed" }));
    expect(f.controller.readHandoff(SESSION_ID).handoff).toBeUndefined();
    expect(f.controller.snapshot().recoveries.filter((record) => record.handoff)).toEqual([]);
  });

  it("distinguishes an unlinked pane from a linked thread that needs a handoff", async () => {
    const f = await makeFixture();
    vi.spyOn(f.controller.legacyCodexObserver, "observeAll").mockResolvedValue([{ status: "unlinked" }]);
    f.iterm.emit("snapshot", f.iterm.sessions);
    await vi.waitFor(() => expect(f.controller.snapshot().sessions.find((session) =>
      session.terminalSessionId === f.terminal.sessionId)?.conversationId).toBeUndefined());
    await expect(f.controller.parkTerminal(f.terminal.sessionId)).rejects.toMatchObject({ code: "SESSION_NOT_LINKED" });
    expect(f.iterm.closed).toEqual([]);
    expect(f.registry.getHandoff(SESSION_ID)).toBeUndefined();
  });

  it.each(["running", "unknown", "requires-process", "new-turn"] as const)("refuses unsafe or stale close: %s", async (reason) => {
    const f = await makeFixture();
    await f.controller.upsertHandoff(SESSION_ID, f.input({ requiresRunningProcess: reason === "requires-process" }));
    if (reason === "running") await f.writeRollout([event("task_started")]);
    if (reason === "unknown") await appendFile(f.rolloutPath, '{"type":"event_msg"');
    if (reason === "new-turn") {
      const at = new Date(Date.now() + 1_000).toISOString();
      await f.writeRollout([event("task_started", "turn-two", at), event("task_complete", "turn-two", at)]);
    }
    await expect(f.controller.closeHandoff(SESSION_ID)).rejects.toMatchObject({
      code: reason === "requires-process" ? "SESSION_REQUIRES_PROCESS" : reason === "new-turn" ? "HANDOFF_STALE" : "SESSION_NOT_IDLE",
    });
    expect(f.iterm.closed).toEqual([]);
    expect(f.registry.getHandoff(SESSION_ID)).toBeDefined();
  });

  it.each(["child", "sibling"] as const)("registers a thread from a %s worktree using its verified conversation directory", async (kind) => {
    const f = await httpFixture();
    const helperCwd = kind === "child" ? join(f.project, "worktrees", "android") : join(f.directory, "Code", "project-worktrees", "analysis");
    await mkdir(helperCwd, { recursive: true });
    const response = await f.request(`/api/handoffs/${SESSION_ID}`, "PUT", f.input({ cwd: helperCwd }));
    expect(response.status).toBe(200);
    const saved = await response.json() as RecoveryRecord;
    expect(saved).toMatchObject({
      sessionId: SESSION_ID, cwd: f.project, terminalSessionId: f.terminal.sessionId,
      handoff: { source: "thread", sourceTurnId: "turn-one", items: f.input().items },
    });
    expect(saved.resumeCommand).toContain(f.project);
    expect(saved.resumeCommand).not.toContain(helperCwd);
    const persisted = JSON.parse(await readFile(f.config.recoveryStateFile, "utf8"));
    expect(persisted.recoveries[SESSION_ID].cwd).toBe(f.project);
    expect(persisted.recoveries[SESSION_ID].handoff).toEqual(saved.handoff);
    expect(f.iterm.closed).toEqual([]);
  });

  it("uses the latest verified thread directory after a resume instead of the helper or original directory", async () => {
    const f = await makeFixture({ active: false });
    const resumedCwd = join(f.directory, "Code", "resumed");
    await mkdir(resumedCwd);
    await f.writeRollout([
      { type: "turn_context", payload: { cwd: resumedCwd } },
      event("task_started", "resumed-turn"), event("task_complete", "resumed-turn"),
    ]);
    const saved = await f.controller.upsertHandoff(SESSION_ID, f.input());
    expect(saved).toMatchObject({ cwd: resumedCwd, handoff: { sourceTurnId: "resumed-turn" } });
    expect(saved.resumeCommand).toContain(resumedCwd);
    expect(f.iterm.closed).toEqual([]);
  });

  it("retains the exact pane and closes a saved thread whose verified directory differs from its shell", async () => {
    const f = await makeFixture();
    const resumedCwd = join(f.directory, "Code", "resumed");
    await mkdir(resumedCwd);
    await f.writeRollout([
      { type: "turn_context", payload: { cwd: resumedCwd } },
      event("task_started"), event("task_complete"),
    ]);
    const saved = await f.controller.upsertHandoff(SESSION_ID, f.input());
    expect(saved).toMatchObject({
      cwd: resumedCwd, projectName: "resumed", terminalSessionId: f.terminal.sessionId,
      savedLocation: { windowId: "original-window", tabId: "original-tab", profileName: "Work" },
    });
    const moved = { ...f.terminal, tabId: "moved-tab", tabIndex: 3 };
    f.iterm.sessions = [moved];
    await f.registry.observeRecoveries([moved], [{ status: "linked", conversationId: SESSION_ID }]);
    expect(f.controller.readHandoff(SESSION_ID)).toMatchObject({ cwd: resumedCwd, handoff: saved.handoff });
    f.iterm.beforeClose = async () => {
      const state = JSON.parse(await readFile(f.config.recoveryStateFile, "utf8"));
      expect(state.recoveries[SESSION_ID]).toMatchObject({
        cwd: resumedCwd, handoff: saved.handoff,
        savedLocation: { windowId: "original-window", tabId: "moved-tab", tabIndex: 3 },
      });
    };
    await expect(f.controller.closeHandoff(SESSION_ID, moved.sessionId)).resolves.toMatchObject({ closed: true });
    expect(f.iterm.closed).toEqual([{ terminalSessionId: moved.sessionId, conversationId: SESSION_ID }]);
  });

  it.each(["running", "new-turn"] as const)("keeps a differing-shell-directory pane open when its thread is %s", async (reason) => {
    const f = await makeFixture();
    const saved = await f.controller.upsertHandoff(SESSION_ID, f.input());
    const resumedCwd = join(f.directory, "Code", "resumed");
    await mkdir(resumedCwd);
    const at = new Date(Date.now() + 1_000).toISOString();
    await f.writeRollout([
      { type: "turn_context", payload: { cwd: resumedCwd } },
      event("task_started", "turn-two", at),
      ...(reason === "new-turn" ? [event("task_complete", "turn-two", at)] : []),
    ]);
    await expect(f.controller.closeHandoff(SESSION_ID)).rejects.toMatchObject({
      code: reason === "running" ? "SESSION_NOT_IDLE" : "HANDOFF_STALE",
    });
    expect(f.iterm.closed).toEqual([]);
    expect(f.registry.getHandoff(SESSION_ID)).toEqual(saved.handoff);
  });

  it("persists a corrected thread directory before close and keeps the pane open if that write fails", async () => {
    const f = await makeFixture();
    const saved = await f.controller.upsertHandoff(SESSION_ID, f.input());
    const resumedCwd = join(f.directory, "Code", "resumed");
    await mkdir(resumedCwd);
    await f.writeRollout([
      { type: "turn_context", payload: { cwd: resumedCwd } },
      event("task_started"), event("task_complete"),
    ]);
    vi.spyOn(f.registry, "updateRecoveryCwd").mockRejectedValueOnce(new Error("test directory write failure"));
    await expect(f.controller.closeHandoff(SESSION_ID)).rejects.toThrow("test directory write failure");
    expect(f.iterm.closed).toEqual([]);
    expect(f.registry.requireRecovery(SESSION_ID).cwd).toBe(f.project);
    f.iterm.beforeClose = async () => {
      const state = JSON.parse(await readFile(f.config.recoveryStateFile, "utf8"));
      expect(state.recoveries[SESSION_ID]).toMatchObject({ cwd: resumedCwd, projectName: "resumed", handoff: saved.handoff });
    };
    await expect(f.controller.closeHandoff(SESSION_ID)).resolves.toMatchObject({ closed: true });
    expect(f.iterm.closed).toHaveLength(1);
    expect(f.registry.getHandoff(SESSION_ID)).toEqual(saved.handoff);
  });

  it.each(["outside", "denied", "missing"] as const)("rejects a verified thread directory that is %s instead of trusting the helper directory", async (kind) => {
    const f = await makeFixture({ active: false });
    const actualCwd = join(kind === "outside" ? f.directory : f.project, kind);
    if (kind !== "missing") await mkdir(actualCwd);
    if (kind === "denied") f.config.deniedProjectRoots.push(actualCwd);
    await f.writeRollout([{ type: "turn_context", payload: { cwd: actualCwd } }]);
    await expect(f.controller.upsertHandoff(SESSION_ID, f.input())).rejects.toMatchObject({
      code: kind === "missing" ? "INVALID_PROJECT_PATH" : "PROJECT_PATH_FORBIDDEN",
    });
    expect(f.registry.getHandoff(SESSION_ID)).toBeUndefined();
    expect(f.iterm.closed).toEqual([]);
  });

  it("rejects invalid ids, mismatched manual directory and subagent identity without creating a card", async () => {
    const f = await makeFixture();
    await expect(f.controller.upsertHandoff("not-an-id", f.input())).rejects.toMatchObject({ code: "INVALID_SESSION_ID" });
    const otherProject = join(f.directory, "Code", "other");
    await mkdir(otherProject);
    await expect(f.controller.upsertHandoff(SESSION_ID, f.input({ source: "user", cwd: otherProject }))).rejects.toMatchObject({ code: "SESSION_CWD_MISMATCH" });
    await f.writeRollout([], { ...f.metadata, payload: { ...f.metadata.payload, id: OTHER_SESSION_ID } });
    await expect(f.controller.upsertHandoff(SESSION_ID, f.input())).rejects.toMatchObject({ code: "SESSION_IDENTITY_MISMATCH" });
    await writeFile(f.rolloutPath, JSON.stringify({ ...f.metadata, payload: { ...f.metadata.payload, source: { subagent: { thread_spawn: { parent_thread_id: OTHER_SESSION_ID } } } } }) + "\n");
    await expect(f.controller.upsertHandoff(SESSION_ID, f.input())).rejects.toMatchObject({ code: "SESSION_IDENTITY_MISMATCH" });
    expect(f.registry.getHandoff(SESSION_ID)).toBeUndefined();
    expect(f.iterm.closed).toEqual([]);
  });

  it("refuses closing a changed or multiply linked target", async () => {
    const f = await makeFixture();
    await f.controller.upsertHandoff(SESSION_ID, f.input());
    await expect(f.controller.closeHandoff(SESSION_ID, "some-other-pane")).rejects.toMatchObject({ code: "SESSION_TARGET_CHANGED" });
    f.iterm.sessions.push({ ...f.terminal, sessionId: "second-pane", jobPid: 43, tty: "/dev/ttys002" });
    await expect(f.controller.closeHandoff(SESSION_ID)).rejects.toMatchObject({ code: "SESSION_TARGET_CHANGED" });
    await expect(f.controller.resumeHandoff(SESSION_ID)).rejects.toMatchObject({ code: "SESSION_TARGET_AMBIGUOUS" });
    expect(f.iterm.closed).toEqual([]);
    expect(f.iterm.restored).toEqual([]);
  });

  it("focuses an existing thread instead of creating a duplicate", async () => {
    const f = await makeFixture();
    await f.controller.upsertHandoff(SESSION_ID, f.input());
    await expect(f.controller.resumeHandoff(SESSION_ID)).resolves.toMatchObject({ action: "focused", terminalSessionId: f.terminal.sessionId });
    expect(f.iterm.focused).toEqual([f.terminal.sessionId]);
    expect(f.iterm.restored).toEqual([]);
    expect(f.writerCheck).not.toHaveBeenCalled();
  });

  it("restores the closed thread with recorded window/profile and persists a retry guard before dispatch", async () => {
    const f = await makeFixture();
    await f.controller.upsertHandoff(SESSION_ID, f.input());
    f.closeInventory();
    f.iterm.beforeRestore = async () => {
      const persisted = JSON.parse(await readFile(f.config.recoveryStateFile, "utf8"));
      expect(persisted.recoveries[SESSION_ID].restoreStatus).toBe("partial");
    };
    await expect(f.controller.resumeHandoff(SESSION_ID)).resolves.toEqual({ action: "restored", terminalSessionId: "restored-pane", windowId: "original-window" });
    expect(f.iterm.restored).toEqual([{ target: { conversationId: SESSION_ID, cwd: f.project, title: "Project (codex)", windowId: "original-window", profileName: "Work", savedCard: true }, port: f.config.port }]);
    expect(f.writerCheck).toHaveBeenCalledWith(f.rolloutPath);
    await expect(f.controller.resumeHandoff(SESSION_ID)).rejects.toMatchObject({ code: "RECOVERY_RESTORE_UNCERTAIN" });
    const reloaded = new RecoveryStore(f.config.recoveryStateFile);
    await reloaded.load();
    expect(reloaded.list()[0]).toMatchObject({ restoreStatus: "partial", handoff: { summary: f.input().summary } });
    expect(f.iterm.restored).toHaveLength(1);
  });

  it("persists an explicit corrected directory on the original card before restoring", async () => {
    const f = await httpFixture();
    const saved = await f.controller.upsertHandoff(SESSION_ID, f.input());
    await f.controller.updateThreadTags(SESSION_ID, { add: ["Network"] });
    f.closeInventory();
    await vi.waitFor(() => expect(f.registry.requireRecovery(SESSION_ID).status).toBe("closed"));
    const corrected = join(f.directory, "Code", "moved");
    await mkdir(corrected);
    await rm(f.project, { recursive: true });
    const path = `/api/handoffs/${SESSION_ID}/resume`;
    expect((await f.request(path, "POST", {})).status).toBe(400);
    expect((await f.request(path, "POST", { cwd: f.directory })).status).toBe(403);
    expect(f.registry.requireRecovery(SESSION_ID).cwdOverride).toBeUndefined();
    f.iterm.restoreError = new Error("Temporary bridge failure");
    expect((await f.request(path, "POST", { cwd: corrected })).status).toBeGreaterThanOrEqual(400);
    const reloaded = new RecoveryStore(f.config.recoveryStateFile);
    await reloaded.load();
    expect(reloaded.list()[0]).toMatchObject({ sessionId: SESSION_ID, cwd: corrected, cwdOverride: corrected, handoff: saved.handoff });
    expect(f.registry.requireRecovery(SESSION_ID).tags).toEqual(["Network"]);
    f.iterm.restoreError = undefined;
    const restored = await f.request(path, "POST", {});
    expect(restored.status).toBe(200);
    expect(f.iterm.restored.at(-1)?.target).toMatchObject({ conversationId: SESSION_ID, cwd: corrected });
    expect(f.registry.getHandoff(SESSION_ID)).toEqual(saved.handoff);
  });

  it.each([true, false])("restores from the verified directory after the old directory disappears, with saved card: %s", async (withCard) => {
    const f = await makeFixture();
    const saved = withCard ? await f.controller.upsertHandoff(SESSION_ID, f.input()) : undefined;
    await f.controller.updateThreadTags(SESSION_ID, { add: ["Network", "排障"] });
    f.closeInventory();
    await vi.waitFor(() => expect(f.registry.requireRecovery(SESSION_ID).status).toBe("closed"));
    const before = f.registry.requireRecovery(SESSION_ID);
    const resumedCwd = join(f.directory, "Code", "resumed");
    await mkdir(resumedCwd);
    await f.writeRollout([
      { type: "turn_context", payload: { cwd: resumedCwd } },
      event("task_started"), event("task_complete"),
    ]);
    await rm(f.project, { recursive: true });
    f.iterm.beforeRestore = async () => {
      const state = JSON.parse(await readFile(f.config.recoveryStateFile, "utf8"));
      expect(state.recoveries[SESSION_ID]).toMatchObject({ cwd: resumedCwd, projectName: "resumed", restoreStatus: "partial" });
      expect(state.recoveries[SESSION_ID].handoff).toEqual(saved?.handoff);
      expect(f.registry.requireRecovery(SESSION_ID).tags).toEqual(["Network", "排障"]);
    };

    await expect(withCard ? f.controller.resumeHandoff(SESSION_ID) : f.controller.openRecovery(SESSION_ID)).resolves.toMatchObject({ action: "restored" });
    expect(f.iterm.restored).toEqual([{
      target: {
        conversationId: SESSION_ID, cwd: resumedCwd, title: before.title,
        windowId: "original-window", profileName: "Work", ...(withCard ? { savedCard: true } : {}),
      },
      port: f.config.port,
    }]);
    const after = f.registry.requireRecovery(SESSION_ID);
    expect(after).toMatchObject({
      cwd: resumedCwd, projectName: "resumed", title: before.title,
      firstSeenAt: before.firstSeenAt, lastSeenAt: before.lastSeenAt, closedAt: before.closedAt,
      savedLocation: before.savedLocation, tags: before.tags,
    });
    expect(after.handoff).toEqual(saved?.handoff);
    expect(after.resumeCommand).toContain(resumedCwd);
  });

  it.each(["outside", "denied", "missing"] as const)("does not restore or rewrite the card when the latest verified directory is %s", async (kind) => {
    const f = await makeFixture({ active: false });
    const saved = await f.controller.upsertHandoff(SESSION_ID, f.input());
    const actualCwd = join(kind === "outside" ? f.directory : f.project, kind);
    if (kind !== "missing") await mkdir(actualCwd);
    if (kind === "denied") f.config.deniedProjectRoots.push(actualCwd);
    await f.writeRollout([{ type: "turn_context", payload: { cwd: actualCwd } }, event("task_complete")]);
    await expect(f.controller.resumeHandoff(SESSION_ID)).rejects.toMatchObject({
      code: kind === "missing" ? "INVALID_PROJECT_PATH" : "PROJECT_PATH_FORBIDDEN",
    });
    expect(f.iterm.restored).toEqual([]);
    expect(f.registry.requireRecovery(SESSION_ID)).toEqual(saved);
  });

  it("does not dispatch a restore if corrected directory persistence fails and permits a retry", async () => {
    const f = await makeFixture({ active: false });
    const saved = await f.controller.upsertHandoff(SESSION_ID, f.input());
    const resumedCwd = join(f.directory, "Code", "resumed");
    await mkdir(resumedCwd);
    await f.writeRollout([{ type: "turn_context", payload: { cwd: resumedCwd } }, event("task_complete")]);
    vi.spyOn(f.registry, "updateRecoveryCwd").mockRejectedValueOnce(new Error("test directory write failure"));
    await expect(f.controller.resumeHandoff(SESSION_ID)).rejects.toThrow("test directory write failure");
    expect(f.iterm.restored).toEqual([]);
    expect(f.registry.requireRecovery(SESSION_ID)).toEqual(saved);
    await expect(f.controller.resumeHandoff(SESSION_ID)).resolves.toMatchObject({ action: "restored" });
    expect(f.iterm.restored).toHaveLength(1);
    expect(f.iterm.restored[0]!.target.cwd).toBe(resumedCwd);
  });

  it("rejects simultaneous restores while the first dispatch is unfinished", async () => {
    const f = await makeFixture({ active: false });
    await f.controller.upsertHandoff(SESSION_ID, f.input());
    let signalEntered!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.iterm.beforeRestore = async () => { signalEntered(); await gate; };
    const first = f.controller.resumeHandoff(SESSION_ID);
    await entered;
    await expect(f.controller.resumeHandoff(SESSION_ID)).rejects.toMatchObject({ code: "HANDOFF_BUSY" });
    release();
    await expect(first).resolves.toMatchObject({ action: "restored", windowId: "new-window" });
    expect(f.iterm.restored).toHaveLength(1);
  });

  it("does not separately resume a thread while its full window layout is being restored", async () => {
    const f = await makeFixture();
    await f.controller.upsertHandoff(SESSION_ID, f.input());
    f.closeInventory();
    await vi.waitFor(() => expect(f.registry.requireWindowLayout("original-window").status).toBe("closed"));
    let signalEntered!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const restoreLayout = vi.spyOn(f.iterm, "restoreLayout").mockImplementation(async () => {
      signalEntered();
      await gate;
      return "restored-layout-window";
    });
    const restoring = f.controller.restoreWindowLayout("original-window");
    await entered;
    try {
      await expect(f.controller.resumeHandoff(SESSION_ID)).rejects.toMatchObject({ code: "RECOVERY_RESTORE_IN_PROGRESS" });
      expect(f.iterm.restored).toEqual([]);
      expect(f.writerCheck).not.toHaveBeenCalled();
    } finally {
      release();
      await restoring;
    }
    expect(restoreLayout).toHaveBeenCalledTimes(1);
  });

  it("does not separately resume a thread after its layout restore may have partially created it", async () => {
    const f = await makeFixture();
    await f.controller.upsertHandoff(SESSION_ID, f.input());
    f.closeInventory();
    await vi.waitFor(() => expect(f.registry.requireWindowLayout("original-window").status).toBe("closed"));
    vi.spyOn(f.iterm, "restoreLayout").mockRejectedValueOnce(
      new AppError(409, "WINDOW_RESTORE_PARTIAL", "test partial layout creation"),
    );
    await expect(f.controller.restoreWindowLayout("original-window")).rejects.toMatchObject({ code: "WINDOW_LAYOUT_RESTORE_UNCERTAIN" });
    expect(f.controller.readHandoff(SESSION_ID).restoreStatus).toBeUndefined();
    const reloaded = new RecoveryStore(f.config.recoveryStateFile);
    await reloaded.load();
    expect(reloaded.listLayouts()[0]).toMatchObject({ windowId: "original-window", restoreStatus: "partial" });
    await expect(f.controller.resumeHandoff(SESSION_ID)).rejects.toMatchObject({ code: "RECOVERY_RESTORE_IN_PROGRESS" });
    expect(f.iterm.restored).toEqual([]);
    expect(f.writerCheck).not.toHaveBeenCalled();
  });

  it("permits retry after persistence fails before any restore dispatch", async () => {
    const f = await makeFixture({ active: false });
    await f.controller.upsertHandoff(SESSION_ID, f.input());
    vi.spyOn(f.registry, "markRecoveriesRestoreUncertain").mockRejectedValueOnce(new Error("test write failure"));
    await expect(f.controller.resumeHandoff(SESSION_ID)).rejects.toThrow("test write failure");
    expect(f.iterm.restored).toEqual([]);
    expect(f.controller.readHandoff(SESSION_ID).restoreStatus).toBeUndefined();
    await expect(f.controller.resumeHandoff(SESSION_ID)).resolves.toMatchObject({ action: "restored" });
    expect(f.iterm.restored).toHaveLength(1);
  });

  it("clears the restored-thread guard after a fresh exact association and focuses that pane", async () => {
    const f = await makeFixture({ active: false });
    await f.controller.upsertHandoff(SESSION_ID, f.input());
    await f.controller.resumeHandoff(SESSION_ID);
    f.iterm.sessions = [{ ...f.terminal, sessionId: "restored-pane", windowId: "new-window" }];
    f.iterm.emit("snapshot", f.iterm.sessions);
    await vi.waitFor(() => expect(f.controller.readHandoff(SESSION_ID).restoreStatus).toBeUndefined());
    await expect(f.controller.resumeHandoff(SESSION_ID)).resolves.toMatchObject({ action: "focused", terminalSessionId: "restored-pane" });
    expect(f.iterm.restored).toHaveLength(1);
  });

  it("rejects recovery while another process still writes the rollout", async () => {
    const f = await makeFixture({ active: false, writer: true });
    await f.controller.upsertHandoff(SESSION_ID, f.input());
    await expect(f.controller.resumeHandoff(SESSION_ID)).rejects.toMatchObject({ code: "SESSION_ACTIVE_ELSEWHERE" });
    expect(f.iterm.restored).toEqual([]);
    expect(f.controller.readHandoff(SESSION_ID).restoreStatus).toBeUndefined();
  });

  it.each([false, true])("keeps uncertainty only for possibly partial provider failure: %s", async (partial) => {
    const f = await makeFixture({ active: false });
    await f.controller.upsertHandoff(SESSION_ID, f.input());
    f.iterm.restoreError = new AppError(409, partial ? "WINDOW_RESTORE_PARTIAL" : "WINDOW_NOT_FOUND", "test provider rejection");
    await expect(f.controller.resumeHandoff(SESSION_ID)).rejects.toMatchObject({ code: partial ? "WINDOW_RESTORE_PARTIAL" : "WINDOW_NOT_FOUND" });
    expect(f.controller.readHandoff(SESSION_ID).restoreStatus).toBe(partial ? "partial" : undefined);
    f.iterm.restoreError = undefined;
    if (partial) {
      await expect(f.controller.resumeHandoff(SESSION_ID)).rejects.toMatchObject({ code: "RECOVERY_RESTORE_UNCERTAIN" });
      expect(f.iterm.restored).toHaveLength(1);
    } else {
      await expect(f.controller.resumeHandoff(SESSION_ID)).resolves.toMatchObject({ action: "restored" });
      expect(f.iterm.restored).toHaveLength(2);
    }
  });
});

describe("thread tag HTTP routes", () => {
  it("lets an original thread without a card or snapshot entry store and read back independent tags", async () => {
    const f = await httpFixture({ active: false });
    const path = `/api/threads/${SESSION_ID}/tags`;
    const empty = await f.request(path);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ sessionId: SESSION_ID, tags: [] });
    expect(f.controller.snapshot().recoveries).toEqual([]);
    const saved = await f.request(path, "PATCH", { add: [" ＡＩ ", "多窗口"] });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ sessionId: SESSION_ID, tags: ["AI", "多窗口"] });
    expect(await (await f.request(path)).json()).toEqual({ sessionId: SESSION_ID, tags: ["AI", "多窗口"] });
    expect(f.controller.snapshot().sessions).toEqual([]);
    expect(f.controller.snapshot().recoveries).toEqual([]);
    expect(f.registry.getHandoff(SESSION_ID)).toBeUndefined();
    expect(f.iterm.closed).toEqual([]);
    expect(f.iterm.restored).toEqual([]);
    const persisted = JSON.parse(await readFile(f.config.attentionStateFile, "utf8"));
    expect(persisted).toEqual({ version: 1, sessions: {}, threads: { [SESSION_ID]: { tags: ["AI", "多窗口"] } } });
    const removed = await f.request(path, "PATCH", { remove: ["ai", "多窗口"] });
    expect(await removed.json()).toEqual({ sessionId: SESSION_ID, tags: [] });
    expect(await (await f.request(path)).json()).toEqual({ sessionId: SESSION_ID, tags: [] });
    const wrongMethod = await f.request(path, "POST", {});
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("Allow")).toBe("GET, PATCH");
  });

  it("preserves concurrent HTTP tag changes and the separately saved handoff", async () => {
    const f = await httpFixture();
    const saved = await f.controller.upsertHandoff(SESSION_ID, f.input());
    const path = `/api/threads/${SESSION_ID}/tags`;
    expect((await f.request(path, "PATCH", { add: ["Old", "Keep"] })).status).toBe(200);
    const responses = await Promise.all([
      f.request(path, "PATCH", { add: ["one"], remove: ["old"] }),
      f.request(path, "PATCH", { add: ["two"] }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const tags = await (await f.request(path)).json() as ThreadTagsResult;
    expect(tags.tags).toHaveLength(3);
    expect(tags.tags).toEqual(expect.arrayContaining(["Keep", "one", "two"]));
    expect(f.registry.getHandoff(SESSION_ID)).toEqual(saved.handoff);
    expect(f.registry.requireRecovery(SESSION_ID).tags).toEqual(tags.tags);
  });

  it("reads empty tags for a known thread but verifies the original rollout before every write", async () => {
    const f = await httpFixture();
    await rm(f.rolloutPath);
    const path = `/api/threads/${SESSION_ID}/tags`;
    expect(await (await f.request(path)).json()).toEqual({ sessionId: SESSION_ID, tags: [] });
    const response = await f.request(path, "PATCH", { add: ["not saved"] });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "SESSION_RECORD_UNAVAILABLE" } });
    expect(f.registry.readThreadTags(SESSION_ID).tags).toEqual([]);
  });

  it.each(["missing", "mismatched", "subagent"] as const)("rejects %s original-thread identity for tag reads and writes", async (reason) => {
    const f = await httpFixture({ active: false });
    const target = reason === "missing" ? OTHER_SESSION_ID : SESSION_ID;
    if (reason === "mismatched") await f.writeRollout([], { ...f.metadata, payload: { ...f.metadata.payload, id: OTHER_SESSION_ID } });
    if (reason === "subagent") await writeFile(f.rolloutPath, JSON.stringify({ ...f.metadata, payload: { ...f.metadata.payload, source: { subagent: { thread_spawn: { parent_thread_id: OTHER_SESSION_ID } } } } }) + "\n");
    for (const method of ["GET", "PATCH"]) {
      const response = await f.request(`/api/threads/${target}/tags`, method, method === "PATCH" ? { add: ["not saved"] } : undefined);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: reason === "missing" ? "SESSION_RECORD_UNAVAILABLE" : "SESSION_IDENTITY_MISMATCH" } });
    }
    expect(f.controller.snapshot().recoveries).toEqual([]);
    expect(f.registry.readThreadTags(target).tags).toEqual([]);
  });

  it("validates the tag patch and UUID through HTTP before changing state", async () => {
    const f = await httpFixture({ active: false });
    for (const body of [{}, { tags: ["x"] }, { add: ["x"], remove: ["Ｘ"] }, { add: ["bad\n"] }, { add: Array(13).fill("x") }]) {
      const response = await f.request(`/api/threads/${SESSION_ID}/tags`, "PATCH", body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    }
    const invalid = await f.request("/api/threads/not-a-thread/tags", "PATCH", { add: ["x"] });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: "INVALID_SESSION_ID" } });
    expect(f.registry.readThreadTags(SESSION_ID).tags).toEqual([]);
    expect(f.controller.snapshot().recoveries).toEqual([]);
  });

  it("publishes tags in actual session and recovery SSE updates", async () => {
    const f = await httpFixture();
    const stream = await f.request("/api/events");
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    await reader.read();
    try {
      expect((await f.request(`/api/threads/${SESSION_ID}/tags`, "PATCH", { add: ["SSE标签"] })).status).toBe(200);
      let data = "";
      while (!data.includes('"type":"recovery-upsert"')) {
        const part = await reader.read();
        expect(part.done).toBe(false);
        data += decoder.decode(part.value, { stream: true });
      }
      expect(data).toContain('"type":"session-upsert"');
      expect(data).toContain('"tags":["SSE标签"]');
      const updates = data.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
      expect(updates.find((event) => event.type === "session-upsert")).toMatchObject({ session: { conversationId: SESSION_ID, tags: ["SSE标签"] } });
      expect(updates.find((event) => event.type === "recovery-upsert")).toMatchObject({ recovery: { sessionId: SESSION_ID, tags: ["SSE标签"] } });
    } finally { await reader.cancel(); }
  });
});

describe("continuation HTTP routes", () => {
  it("opens a recovery without a handoff by freshly focusing its live terminal", async () => {
    const f = await httpFixture();
    const path = `/api/recoveries/${SESSION_ID}/open`;
    expect(f.registry.getHandoff(SESSION_ID)).toBeUndefined();
    const response = await f.request(path, "POST", {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ action: "focused", terminalSessionId: f.terminal.sessionId, windowId: "original-window" });
    expect(f.iterm.focused).toEqual([f.terminal.sessionId]);
    expect(f.iterm.restored).toEqual([]);
    expect(f.writerCheck).not.toHaveBeenCalled();
    expect(f.registry.getHandoff(SESSION_ID)).toBeUndefined();
    const wrongMethod = await f.request(path);
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("Allow")).toBe("POST");
    expect((await f.request(path, "POST", { command: "unexpected" })).status).toBe(400);
    expect(f.iterm.focused).toHaveLength(1);
  });

  it("restores a closed recovery without registering a handoff and guards repeated opening", async () => {
    const f = await httpFixture();
    f.closeInventory();
    await vi.waitFor(() => expect(f.registry.requireRecovery(SESSION_ID).status).toBe("closed"));
    const path = `/api/recoveries/${SESSION_ID}/open`;
    const response = await f.request(path, "POST", {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ action: "restored", terminalSessionId: "restored-pane", windowId: "original-window" });
    expect(f.iterm.restored).toEqual([{
      target: { conversationId: SESSION_ID, cwd: f.project, title: "Project (codex)", windowId: "original-window", profileName: "Work" }, port: f.config.port,
    }]);
    expect(f.writerCheck).toHaveBeenCalledWith(f.rolloutPath);
    const reloaded = new RecoveryStore(f.config.recoveryStateFile);
    await reloaded.load();
    expect(reloaded.list()[0]).toMatchObject({ sessionId: SESSION_ID, restoreStatus: "partial" });
    expect(reloaded.getHandoff(SESSION_ID)).toBeUndefined();
    const repeated = await f.request(path, "POST", {});
    expect(repeated.status).toBe(409);
    expect(await repeated.json()).toMatchObject({ error: { code: "RECOVERY_RESTORE_UNCERTAIN" } });
    expect(f.iterm.restored).toHaveLength(1);
  });

  it.each(["duplicates", "writer"] as const)("refuses opening a recovery without a handoff when blocked by %s", async (reason) => {
    const f = await httpFixture({ writer: reason === "writer" });
    if (reason === "duplicates") {
      f.iterm.sessions.push({ ...f.terminal, sessionId: "second-pane", jobPid: 43, tty: "/dev/ttys002" });
    } else {
      f.closeInventory();
    }
    const response = await f.request(`/api/recoveries/${SESSION_ID}/open`, "POST", {});
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: reason === "duplicates" ? "SESSION_TARGET_AMBIGUOUS" : "SESSION_ACTIVE_ELSEWHERE" } });
    expect(f.iterm.focused).toEqual([]);
    expect(f.iterm.restored).toEqual([]);
    expect(f.registry.getHandoff(SESSION_ID)).toBeUndefined();
    expect(f.registry.requireRecovery(SESSION_ID).restoreStatus).toBeUndefined();
  });

  it("does not create a recovery or card for an unknown thread", async () => {
    const f = await httpFixture();
    const before = f.controller.snapshot().recoveries;
    const response = await f.request(`/api/recoveries/${OTHER_SESSION_ID}/open`, "POST", {});
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "RECOVERY_NOT_FOUND" } });
    expect(f.controller.snapshot().recoveries).toEqual(before);
    expect(f.iterm.focused).toEqual([]);
    expect(f.iterm.restored).toEqual([]);
  });

  it.each(["open", "resume"] as const)("directs managed threads back to the workbench through %s without a terminal duplicate", async (action) => {
    const f = await httpFixture();
    if (action === "resume") await f.controller.upsertHandoff(SESSION_ID, f.input());
    f.closeInventory();
    await f.registry.upsert({
      id: SESSION_ID, conversationId: SESSION_ID, provider: "codex", surface: "managed",
      title: "Managed", cwd: f.project, projectKey: f.project, projectName: "project",
      activityState: "idle", attentionReason: null, lastActivityAt: new Date().toISOString(),
      observedAt: new Date().toISOString(), stale: false, activities: [], pinned: false, parked: false,
      capabilities: { open: true, focus: false, send: false, steer: false, interrupt: false, approve: false, answer: false },
    });
    const path = action === "open" ? `/api/recoveries/${SESSION_ID}/open` : `/api/handoffs/${SESSION_ID}/resume`;
    const response = await f.request(path, "POST", {});
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "SESSION_MANAGED_ACTIVE" } });
    expect(f.iterm.restored).toEqual([]);
    expect(f.writerCheck).not.toHaveBeenCalled();
  });

  it.each(["writer", "persistence"] as const)("focuses the instance that appears during %s instead of creating a duplicate", async (stage) => {
    const f = await httpFixture();
    f.closeInventory();
    await vi.waitFor(() => expect(f.registry.requireRecovery(SESSION_ID).status).toBe("closed"));
    const entered = deferred();
    const gate = deferred();
    if (stage === "writer") {
      f.writerCheck.mockImplementationOnce(async () => { entered.resolve(); await gate.promise; return false; });
    } else {
      const markUncertain = f.registry.markRecoveriesRestoreUncertain.bind(f.registry);
      vi.spyOn(f.registry, "markRecoveriesRestoreUncertain").mockImplementationOnce(async (...args) => {
        entered.resolve(); await gate.promise; return markUncertain(...args);
      });
    }
    const request = f.request(`/api/recoveries/${SESSION_ID}/open`, "POST", {});
    await entered.promise;
    f.iterm.sessions = [{ ...f.terminal, sessionId: "newly-opened-pane" }];
    gate.resolve();
    const response = await request;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ action: "focused", terminalSessionId: "newly-opened-pane" });
    expect(f.iterm.focused).toEqual(["newly-opened-pane"]);
    expect(f.iterm.restored).toEqual([]);
    expect(f.registry.requireRecovery(SESSION_ID).restoreStatus).toBeUndefined();
    expect(f.registry.getHandoff(SESSION_ID)).toBeUndefined();
    const retry = await f.request(`/api/recoveries/${SESSION_ID}/open`, "POST", {});
    expect(await retry.json()).toMatchObject({ action: "focused", terminalSessionId: "newly-opened-pane" });
  });

  it.each([
    { action: "focus", change: "start" }, { action: "focus", change: "finish" },
    { action: "restore", change: "start" }, { action: "restore", change: "finish" },
  ])("permits $action while an unrelated pane's command changes at $change", async ({ action, change }) => {
    const f = await httpFixture();
    if (action === "restore") {
      f.closeInventory();
      await vi.waitFor(() => expect(f.registry.requireRecovery(SESSION_ID).status).toBe("closed"));
    }
    const foreignPane: ItermSessionSnapshot = {
      ...f.terminal, sessionId: "foreign-pane", tty: "/dev/ttys002", jobPid: 43,
      commandLine: change === "start" ? "zsh" : "sleep 10", jobName: change === "start" ? "zsh" : "sleep",
    };
    f.iterm.sessions.push(foreignPane);
    const changeCommand = () => {
      Object.assign(foreignPane, {
        jobPid: 44, commandLine: change === "start" ? "sleep 10" : "zsh", jobName: change === "start" ? "sleep" : "zsh",
      });
    };
    if (action === "focus") {
      const observeAll = LegacyCodexObserver.prototype.observeAll;
      vi.spyOn(LegacyCodexObserver.prototype, "observeAll").mockImplementationOnce(async function (this: LegacyCodexObserver, sessions) {
        const matches = await observeAll.call(this, sessions);
        changeCommand();
        return matches;
      });
    } else {
      f.writerCheck.mockImplementationOnce(async () => { changeCommand(); return false; });
    }
    const response = await f.request(`/api/recoveries/${SESSION_ID}/open`, "POST", {});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ action: action === "focus" ? "focused" : "restored" });
    expect(f.iterm.focused).toEqual(action === "focus" ? [f.terminal.sessionId] : []);
    expect(f.iterm.restored).toHaveLength(action === "restore" ? 1 : 0);
    expect(f.registry.getHandoff(SESSION_ID)).toBeUndefined();
  });

  it("refuses focusing a pane whose own process identity changed during lookup", async () => {
    const f = await httpFixture();
    const observeAll = LegacyCodexObserver.prototype.observeAll;
    vi.spyOn(LegacyCodexObserver.prototype, "observeAll").mockImplementationOnce(async function (this: LegacyCodexObserver, sessions) {
      const matches = await observeAll.call(this, sessions);
      f.terminal.jobPid = 99;
      f.terminal.commandLine = `codex resume ${OTHER_SESSION_ID}`;
      return matches;
    });
    const response = await f.request(`/api/recoveries/${SESSION_ID}/open`, "POST", {});
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "SESSION_TARGET_CHANGED" } });
    expect(f.iterm.focused).toEqual([]);
    expect(f.iterm.restored).toEqual([]);
  });

  it("finds a thread that appears while rechecking an unrelated inventory change", async () => {
    const f = await httpFixture();
    f.closeInventory();
    await vi.waitFor(() => expect(f.registry.requireRecovery(SESSION_ID).status).toBe("closed"));
    const foreignPane = { ...f.terminal, sessionId: "foreign-pane", tty: "/dev/ttys002", jobPid: 43, jobName: "zsh", commandLine: "zsh" };
    f.iterm.sessions = [foreignPane];
    f.writerCheck.mockImplementationOnce(async () => {
      foreignPane.commandLine = "sleep 10";
      foreignPane.jobName = "sleep";
      return false;
    });
    const observeAll = LegacyCodexObserver.prototype.observeAll;
    let scans = 0;
    vi.spyOn(LegacyCodexObserver.prototype, "observeAll").mockImplementation(async function (this: LegacyCodexObserver, sessions) {
      const matches = await observeAll.call(this, sessions);
      if (++scans === 2) f.iterm.sessions.push({ ...f.terminal, sessionId: "opened-during-rescan" });
      return matches;
    });
    const response = await f.request(`/api/recoveries/${SESSION_ID}/open`, "POST", {});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ action: "focused", terminalSessionId: "opened-during-rescan" });
    expect(scans).toBe(3);
    expect(f.iterm.restored).toEqual([]);
    expect(f.registry.requireRecovery(SESSION_ID).restoreStatus).toBeUndefined();
  });

  it("bounds lookup retries when empty results cannot establish a stable inventory", async () => {
    const f = await httpFixture();
    f.closeInventory();
    await vi.waitFor(() => expect(f.registry.requireRecovery(SESSION_ID).status).toBe("closed"));
    const foreignPane = { ...f.terminal, sessionId: "foreign-pane", tty: "/dev/ttys002", jobPid: 43, jobName: "zsh", commandLine: "zsh" };
    f.iterm.sessions = [foreignPane];
    const observeAll = LegacyCodexObserver.prototype.observeAll;
    let scans = 0;
    vi.spyOn(LegacyCodexObserver.prototype, "observeAll").mockImplementation(async function (this: LegacyCodexObserver, sessions) {
      const matches = await observeAll.call(this, sessions);
      scans += 1;
      foreignPane.jobPid += 1;
      return matches;
    });
    const response = await f.request(`/api/recoveries/${SESSION_ID}/open`, "POST", {});
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "SESSION_TARGET_CHANGED" } });
    expect(scans).toBe(2);
    expect(f.iterm.restored).toEqual([]);
    expect(f.writerCheck).not.toHaveBeenCalled();
  });

  it("does not open a closed recovery after client disconnection during writer verification", async () => {
    const f = await httpFixture();
    f.closeInventory();
    const entered = deferred();
    const gate = deferred();
    f.writerCheck.mockImplementationOnce(async () => { entered.resolve(); await gate.promise; return false; });
    const invoked = vi.spyOn(f.controller, "openRecovery");
    const path = `/api/recoveries/${SESSION_ID}/open`;
    const request = abortableAction(f, path);
    await entered.promise;
    try {
      await request.cancel();
      await expect(invoked.mock.results[0]?.value).rejects.toMatchObject({ code: "CONTINUATION_CANCELLED" });
    } finally { gate.resolve(); }
    expect(f.iterm.restored).toEqual([]);
    expect(f.registry.requireRecovery(SESSION_ID).restoreStatus).toBeUndefined();
    expect(f.registry.getHandoff(SESSION_ID)).toBeUndefined();
  });

  it("rejects stale whole-card writes and deletes without losing newer work", async () => {
    const f = await httpFixture();
    const path = `/api/handoffs/${SESSION_ID}`;
    expect((await f.request(path, "PUT", f.input())).status).toBe(200);
    const oldInput = f.input();
    const newer = f.input({ items: [...oldInput.items, { ...oldInput.items[0]!, id: "new-work" }], requiresRunningProcess: true,
      reference: { title: "留存结论", reason: "以后参考" } });
    const response = await f.request(path, "PUT", newer);
    expect(response.status).toBe(200);
    const saved = await response.json() as RecoveryRecord;
    for (const [method, body] of [["PUT", oldInput], ["DELETE", { expectedVersion: oldInput.expectedVersion }]] as const) {
      const rejected = await f.request(path, method, body);
      expect(rejected.status).toBe(409);
      expect(await rejected.json()).toMatchObject({ error: { code: "HANDOFF_CONFLICT" } });
      expect(await (await f.request(path)).json()).toEqual(saved);
    }
    const { expectedVersion: _version, ...unversioned } = f.input();
    expect((await f.request(path, "PUT", unversioned)).status).toBe(400);
    expect((await f.request(path, "DELETE", {})).status).toBe(400);
    expect((await f.request(path, "DELETE", { expectedVersion: saved.handoff!.version })).status).toBe(204);
  });

  it.each(["park", "close"] as const)("saves, focuses, closes via %s, and restores a reference-only thread", async (action) => {
    const f = await httpFixture();
    const reference = { title: "以后复用的核验方法", reason: "这次已完成，类似发布时可参考原线程的方法" };
    const path = `/api/handoffs/${SESSION_ID}`;
    const saved = await f.request(path, "PUT", f.input({ summary: reference.title, items: [], reference }));
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ handoff: { reference, items: [] } });
    expect(f.iterm.closed).toEqual([]);
    const read = await f.request(path);
    expect(await read.json()).toMatchObject({ handoff: { reference, items: [] } });
    const focused = await f.request(`${path}/resume`, "POST", {});
    expect(focused.status).toBe(200);
    expect(await focused.json()).toMatchObject({ action: "focused", terminalSessionId: f.terminal.sessionId });
    expect(f.iterm.focused).toEqual([f.terminal.sessionId]);
    expect(f.iterm.restored).toEqual([]);

    const laterTurnAt = new Date(Date.now() + 1_000).toISOString();
    await f.writeRollout([event("task_started", "reopened-turn", laterTurnAt), event("task_complete", "reopened-turn", laterTurnAt)]);
    f.iterm.beforeClose = async () => {
      const persisted = JSON.parse(await readFile(f.config.recoveryStateFile, "utf8"));
      expect(persisted.recoveries[SESSION_ID]).toMatchObject({
        handoff: { reference, items: [] }, savedLocation: { windowId: "original-window", profileName: "Work" },
      });
    };
    const closePath = action === "park" ? `/api/terminals/${f.terminal.sessionId}/park` : `${path}/close`;
    const closed = await f.request(closePath, "POST", {});
    expect(closed.status).toBe(200);
    expect(await closed.json()).toEqual({ closed: true, terminalSessionId: f.terminal.sessionId });
    expect(f.iterm.closed).toEqual([{ terminalSessionId: f.terminal.sessionId, conversationId: SESSION_ID }]);
    f.closeInventory();
    await vi.waitFor(() => expect(f.controller.readHandoff(SESSION_ID).status).toBe("closed"));

    const resumed = await f.request(`${path}/resume`, "POST", {});
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toEqual({ action: "restored", terminalSessionId: "restored-pane", windowId: "original-window" });
    expect(f.iterm.restored).toEqual([{
      target: { conversationId: SESSION_ID, cwd: f.project, title: "Project (codex)", windowId: "original-window", profileName: "Work", savedCard: true }, port: f.config.port,
    }]);
    const reloaded = new RecoveryStore(f.config.recoveryStateFile);
    await reloaded.load();
    expect(reloaded.getHandoff(SESSION_ID)).toMatchObject({ reference, items: [] });
  });

  it("updates reference and task state independently through HTTP and requires a saved purpose after both are cleared", async () => {
    const f = await httpFixture();
    const path = `/api/handoffs/${SESSION_ID}`;
    const reference = { title: "核验方法", reason: "供下次发布参考" };
    expect((await f.request(path, "PUT", f.input({ reference }))).status).toBe(200);
    const finished = await f.request(path, "PUT", f.input({ items: f.input().items.map((item) => ({ ...item, status: "done" })) }));
    expect(finished.status).toBe(200);
    expect(await finished.json()).toMatchObject({ handoff: { reference, items: [{ status: "done" }] } });

    const removed = await f.request(path, "PUT", f.input({ reference: null }));
    expect(removed.status).toBe(200);
    const remaining = await (await f.request(path)).json() as RecoveryRecord;
    expect(remaining.handoff).not.toHaveProperty("reference");
    expect(remaining.handoff?.items[0]?.status).toBe("pending");

    expect((await f.request(path, "PUT", f.input({ reference: null, items: [] }))).status).toBe(200);
    for (const action of ["close", "resume"]) {
      const response = await f.request(`${path}/${action}`, "POST", {});
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "HANDOFF_REQUIRED" } });
    }
    expect(f.iterm.closed).toEqual([]);
    expect(f.iterm.focused).toEqual([]);
    expect(f.iterm.restored).toEqual([]);
  });

  it.each(["park", "close", "resume"] as const)("does not wait for blocked background inventory before %s", async (action) => {
    const f = await httpFixture();
    await f.controller.upsertHandoff(SESSION_ID, f.input());
    const entered = deferred();
    const gate = deferred();
    const ingested = deferred();
    let released = false;
    const observeRecoveries = f.registry.observeRecoveries.bind(f.registry);
    vi.spyOn(f.registry, "observeRecoveries").mockImplementationOnce(async (sessions, matches) => {
      await observeRecoveries(sessions, matches);
      ingested.resolve();
    });
    vi.spyOn(f.controller.legacyCodexObserver, "observeAll").mockImplementationOnce(async () => {
      entered.resolve();
      await gate.promise;
      released = true;
      return [{ status: "linked", conversationId: SESSION_ID }];
    });
    f.iterm.emit("snapshot", f.iterm.sessions);
    await entered.promise;
    const path = action === "park" ? `/api/terminals/${f.terminal.sessionId}/park` : `/api/handoffs/${SESSION_ID}/${action}`;
    let response: Response | undefined;
    const request = f.request(path, "POST", {}).then((value) => { response = value; return value; });
    try {
      await vi.waitFor(() => expect(response?.status).toBe(200), { timeout: 1_000, interval: 10 });
      expect(released).toBe(false);
      const body = await (await request).json();
      expect(body).toMatchObject(action === "resume" ? { action: "focused" } : { closed: true });
      expect(f.iterm.closed).toHaveLength(action === "resume" ? 0 : 1);
      expect(f.iterm.focused).toHaveLength(action === "resume" ? 1 : 0);
      expect(f.iterm.restored).toEqual([]);
    } finally {
      gate.resolve();
      await request;
      await ingested.promise;
    }
  });

  it.each(["park", "close", "focus", "restore"] as const)("does not perform %s after the HTTP client disconnects during fresh identity lookup", async (action) => {
    const f = await httpFixture({ active: action !== "restore" });
    await f.controller.upsertHandoff(SESSION_ID, f.input());
    if (action === "restore") {
      f.iterm.sessions = [{ ...f.terminal, sessionId: "unrelated-pane", commandLine: `codex resume ${OTHER_SESSION_ID}`, jobPid: 43 }];
    }
    const entered = deferred();
    const gate = deferred();
    const inspected = deferred();
    const readCommand = f.controller.legacyCodexObserver.readCommand;
    vi.spyOn(f.controller.legacyCodexObserver, "readCommand").mockImplementation(async (file, args) => {
      if (file.endsWith("/ps")) { entered.resolve(); await gate.promise; }
      return action === "restore" && file.endsWith("/lsof")
        ? `p43\nn${join(f.codexHome, "sessions", `rollout-${OTHER_SESSION_ID}.jsonl`)}\n`
        : readCommand(file, args);
    });
    const observeAll = LegacyCodexObserver.prototype.observeAll;
    vi.spyOn(LegacyCodexObserver.prototype, "observeAll").mockImplementationOnce(async function (this: LegacyCodexObserver, sessions) {
      try { return await observeAll.call(this, sessions); }
      finally { inspected.resolve(); }
    });
    const method = action === "park" ? "parkTerminal" : action === "close" ? "closeHandoff" : "resumeHandoff";
    const invoked = vi.spyOn(f.controller, method);
    const path = action === "park" ? `/api/terminals/${f.terminal.sessionId}/park` : `/api/handoffs/${SESSION_ID}/${action === "close" ? "close" : "resume"}`;
    const request = abortableAction(f, path);
    await entered.promise;
    try {
      await request.cancel();
      await expect(invoked.mock.results[0]?.value).rejects.toMatchObject({ code: "CONTINUATION_CANCELLED" });
    } finally {
      gate.resolve();
      await inspected.promise;
    }
    expect(f.iterm.closed).toEqual([]);
    expect(f.iterm.focused).toEqual([]);
    expect(f.iterm.restored).toEqual([]);
    expect(f.controller.readHandoff(SESSION_ID).handoff).toBeDefined();
  });

  it("retains saved card and final location without closing after disconnection during persistence", async () => {
    const f = await httpFixture();
    await f.controller.upsertHandoff(SESSION_ID, f.input());
    f.iterm.sessions = [{ ...f.terminal, tabId: "final-tab", tabIndex: 4 }];
    const entered = deferred();
    const gate = deferred();
    const saveRecoveryLocation = f.registry.saveRecoveryLocation.bind(f.registry);
    vi.spyOn(f.registry, "saveRecoveryLocation").mockImplementationOnce(async (id, session) => {
      entered.resolve();
      await gate.promise;
      return saveRecoveryLocation(id, session);
    });
    const invoked = vi.spyOn(f.controller, "closeHandoff");
    const request = abortableAction(f, `/api/handoffs/${SESSION_ID}/close`);
    await entered.promise;
    try { await request.cancel(); }
    finally { gate.resolve(); }
    await expect(invoked.mock.results[0]?.value).rejects.toMatchObject({ code: "CONTINUATION_CANCELLED" });
    const reloaded = new RecoveryStore(f.config.recoveryStateFile);
    await reloaded.load();
    expect(reloaded.list()[0]).toMatchObject({
      handoff: { summary: f.input().summary },
      savedLocation: { tabId: "final-tab", tabIndex: 4 },
    });
    expect(f.iterm.closed).toEqual([]);
  });

  it("clears a pre-dispatch restore reservation after disconnecting during its durable write and permits one retry", async () => {
    const f = await httpFixture({ active: false });
    await f.controller.upsertHandoff(SESSION_ID, f.input());
    const entered = deferred();
    const gate = deferred();
    const markUncertain = f.registry.markRecoveriesRestoreUncertain.bind(f.registry);
    vi.spyOn(f.registry, "markRecoveriesRestoreUncertain").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await gate.promise;
      return markUncertain(...args);
    });
    const invoked = vi.spyOn(f.controller, "resumeHandoff");
    const path = `/api/handoffs/${SESSION_ID}/resume`;
    const request = abortableAction(f, path);
    await entered.promise;
    try { await request.cancel(); }
    finally { gate.resolve(); }
    await expect(invoked.mock.results[0]?.value).rejects.toMatchObject({ code: "CONTINUATION_CANCELLED" });
    expect(f.iterm.restored).toEqual([]);
    const reloaded = new RecoveryStore(f.config.recoveryStateFile);
    await reloaded.load();
    expect(reloaded.list()[0]?.restoreStatus).toBeUndefined();
    expect(reloaded.getHandoff(SESSION_ID)?.summary).toBe(f.input().summary);
    const retry = await f.request(path, "POST", {});
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ action: "restored" });
    expect(f.iterm.restored).toHaveLength(1);
  });

  it("preserves a partial-restore guard when the client disconnects after provider dispatch", async () => {
    const f = await httpFixture({ active: false });
    await f.controller.upsertHandoff(SESSION_ID, f.input());
    const entered = deferred();
    const gate = deferred();
    f.iterm.beforeRestore = async () => { entered.resolve(); await gate.promise; };
    f.iterm.restoreError = new AppError(409, "WINDOW_RESTORE_PARTIAL", "test partial creation after dispatch");
    const invoked = vi.spyOn(f.controller, "resumeHandoff");
    const path = `/api/handoffs/${SESSION_ID}/resume`;
    const request = abortableAction(f, path);
    await entered.promise;
    try { await request.cancel(); }
    finally { gate.resolve(); }
    await expect(invoked.mock.results[0]?.value).rejects.toMatchObject({ code: "WINDOW_RESTORE_PARTIAL" });
    expect(f.iterm.restored).toHaveLength(1);
    const reloaded = new RecoveryStore(f.config.recoveryStateFile);
    await reloaded.load();
    expect(reloaded.list()[0]?.restoreStatus).toBe("partial");
    const retry = await f.request(path, "POST", {});
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({ error: { code: "RECOVERY_RESTORE_UNCERTAIN" } });
    expect(f.iterm.restored).toHaveLength(1);
  });

  it("expires the six-second HTTP preparation deadline and never closes after the lookup later finishes", async () => {
    const f = await httpFixture();
    await f.controller.upsertHandoff(SESSION_ID, f.input());
    const entered = deferred();
    const gate = deferred();
    const inspected = deferred();
    const readCommand = f.controller.legacyCodexObserver.readCommand;
    vi.spyOn(f.controller.legacyCodexObserver, "readCommand").mockImplementation(async (file, args) => {
      if (file.endsWith("/ps")) { entered.resolve(); await gate.promise; }
      return readCommand(file, args);
    });
    const observeAll = LegacyCodexObserver.prototype.observeAll;
    vi.spyOn(LegacyCodexObserver.prototype, "observeAll").mockImplementationOnce(async function (this: LegacyCodexObserver, sessions) {
      try { return await observeAll.call(this, sessions); }
      finally { inspected.resolve(); }
    });
    const start = performance.now();
    const request = f.request(`/api/handoffs/${SESSION_ID}/close`, "POST", {});
    await entered.promise;
    try {
      const response = await request;
      expect(response.status).toBe(408);
      expect(await response.json()).toMatchObject({ error: { code: "CONTINUATION_CANCELLED" } });
      expect(performance.now() - start).toBeGreaterThanOrEqual(5_500);
    } finally {
      gate.resolve();
      await inspected.promise;
    }
    expect(f.iterm.closed).toEqual([]);
    expect(f.iterm.focused).toEqual([]);
    expect(f.iterm.restored).toEqual([]);
  }, 8_000);

  it("allows closed-thread writer verification to finish after the shortcut preparation budget", async () => {
    const f = await httpFixture();
    await f.controller.upsertHandoff(SESSION_ID, f.input());
    f.closeInventory();
    const entered = deferred();
    const gate = deferred();
    f.writerCheck.mockImplementation(async () => { entered.resolve(); await gate.promise; return false; });
    let settled = false;
    const request = f.request(`/api/handoffs/${SESSION_ID}/resume`, "POST", {}).then((response) => {
      settled = true;
      return response;
    });
    await entered.promise;
    try {
      await new Promise((resolve) => setTimeout(resolve, 6_200));
      expect(settled).toBe(false);
      expect(f.iterm.restored).toEqual([]);
    } finally { gate.resolve(); }
    const response = await request;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ action: "restored" });
    expect(f.iterm.restored).toHaveLength(1);
  }, 9_000);

  it("accepts and reloads a legal 20-item Chinese handoff larger than 64 KiB", async () => {
    const f = await httpFixture();
    const path = `/api/handoffs/${SESSION_ID}`;
    const input = f.input({
      summary: "待".repeat(1_000),
      sourceTurnId: "轮".repeat(200),
      items: Array.from({ length: 20 }, (_, index) => ({
        id: `${String(index).padStart(2, "0")}${"项".repeat(98)}`,
        title: "核".repeat(200),
        kind: "time",
        nextAction: "查".repeat(1_000),
        status: "pending",
        condition: "等".repeat(1_000),
        anchorLabel: "起".repeat(200),
        anchorAt: "2026-09-10T08:00:00.000Z",
        delayHours: 24,
        dueAt: "2026-09-11T08:00:00.000Z",
      })),
    });
    const bytes = Buffer.byteLength(JSON.stringify(input), "utf8");
    expect(bytes).toBeGreaterThan(64 * 1024);
    expect(bytes).toBeLessThan(256 * 1024);
    const put = await f.request(path, "PUT", input);
    expect(put.status).toBe(200);
    const saved = await put.json() as RecoveryRecord;
    expect(saved.handoff).toMatchObject({ summary: input.summary, sourceTurnId: "turn-one", items: input.items });
    const get = await f.request(path);
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual(saved);
    const reloaded = new RecoveryStore(f.config.recoveryStateFile);
    await reloaded.load();
    expect(reloaded.getHandoff(SESSION_ID)).toEqual(saved.handoff);
  });

  it("rejects a handoff body above 256 KiB without replacing the saved card", async () => {
    const f = await httpFixture();
    const path = `/api/handoffs/${SESSION_ID}`;
    const initial = await f.request(path, "PUT", f.input());
    expect(initial.status).toBe(200);
    const original = await initial.json() as RecoveryRecord;
    const oversized = f.input({ summary: "字".repeat(90_000) });
    expect(Buffer.byteLength(JSON.stringify(oversized), "utf8")).toBeGreaterThan(256 * 1024);
    const rejected = await f.request(path, "PUT", oversized);
    expect(rejected.status).toBe(413);
    const get = await f.request(path);
    expect(await get.json()).toEqual(original);
    const reloaded = new RecoveryStore(f.config.recoveryStateFile);
    await reloaded.load();
    expect(reloaded.getHandoff(SESSION_ID)).toEqual(original.handoff);
  });

  it("serves no-store PUT/GET/DELETE and preserves recovery metadata after card removal", async () => {
    const f = await httpFixture();
    const path = `/api/handoffs/${SESSION_ID}`;
    const put = await f.request(path, "PUT", f.input());
    expect(put.status).toBe(200);
    expect(put.headers.get("cache-control")).toBe("no-store");
    expect(await put.json()).toMatchObject({ handoff: { summary: f.input().summary, sourceTurnId: "turn-one" } });
    const get = await f.request(path);
    expect(get.status).toBe(200);
    expect(get.headers.get("cache-control")).toBe("no-store");
    expect(await get.json()).toMatchObject({ sessionId: SESSION_ID, handoff: { items: [{ id: "verify" }] } });
    const removed = await f.request(path, "DELETE", { expectedVersion: f.input().expectedVersion });
    expect(removed.status).toBe(204);
    expect(removed.headers.get("cache-control")).toBe("no-store");
    const after = await f.request(path);
    expect(await after.json()).toMatchObject({ sessionId: SESSION_ID, cwd: f.project });
    expect(f.controller.readHandoff(SESSION_ID).handoff).toBeUndefined();
    expect(f.iterm.closed).toEqual([]);
  });

  it("rejects unknown fields and wires explicit close, resume and park actions", async () => {
    const f = await httpFixture();
    const path = `/api/handoffs/${SESSION_ID}`;
    const invalid = await f.request(path, "PUT", { ...f.input(), transcript: "must not persist" });
    expect(invalid.status).toBe(400);
    expect(f.registry.getHandoff(SESSION_ID)).toBeUndefined();
    expect((await f.request(path, "PUT", f.input())).status).toBe(200);
    expect((await f.request(`${path}/close`, "POST", { unexpected: true })).status).toBe(400);
    expect(f.iterm.closed).toEqual([]);
    const resume = await f.request(`${path}/resume`, "POST", {});
    expect(await resume.json()).toMatchObject({ action: "focused", terminalSessionId: f.terminal.sessionId });
    const close = await f.request(`${path}/close`, "POST", { terminalSessionId: f.terminal.sessionId });
    expect(await close.json()).toEqual({ closed: true, terminalSessionId: f.terminal.sessionId });
    const park = await f.request(`/api/terminals/${f.terminal.sessionId}/park`, "POST", {});
    expect(park.status).toBe(200);
    expect(f.iterm.closed).toHaveLength(2);
    expect(await readFile(f.config.recoveryStateFile, "utf8")).not.toContain("must not persist");
  });
});

let markerObservation = 0;
async function publishMarkerInventory(f: Awaited<ReturnType<typeof makeFixture>>, sessions = f.iterm.sessions) {
  const observedAt = new Date(Date.now() + ++markerObservation).toISOString();
  f.iterm.sessions = sessions.map((session) => ({ ...session, observedAt }));
  f.iterm.emit("snapshot", f.iterm.sessions);
  await vi.waitFor(() => {
    const live = f.controller.snapshot().sessions.filter((session) => session.surface === "legacy");
    expect(live).toHaveLength(sessions.length);
    expect(live.every((session) => session.observedAt === observedAt)).toBe(true);
  });
}

function savedMarker(terminal: ItermSessionSnapshot, state: "requested" | "applied" = "requested"): ItermSessionSnapshot {
  return { ...terminal, savedMarkerConversationId: SESSION_ID, savedMarkerOwnerSessionId: terminal.sessionId, savedMarkerState: state };
}

describe("saved-session visual markers", () => {
  it("registering a card marks the verified live pane, while ordinary board focus stays neutral", async () => {
    const f = await makeFixture();
    await f.controller.upsertHandoff(SESSION_ID, f.input());
    expect(f.iterm.markersConfigured).toEqual([{ terminalSessionId: "original-pane", conversationId: SESSION_ID }]);
    await publishMarkerInventory(f);
    await f.controller.focus(f.controller.snapshot().sessions[0]!.id);
    expect(f.iterm.markersConfigured).toHaveLength(1);
  });

  it("retries a reference-only registration after exact identity becomes available", async () => {
    const f = await makeFixture({ observerRetryAfterMs: 0 });
    f.inspection.output = "p42\n";
    await f.controller.upsertHandoff(SESSION_ID, f.input({ items: [], reference: { title: "Useful", reason: "For later" } }));
    expect(f.iterm.markersConfigured).toEqual([]);
    await publishMarkerInventory(f);
    expect(f.iterm.markersConfigured).toEqual([]);
    f.inspection.output = undefined;
    await publishMarkerInventory(f);
    expect(f.iterm.markersConfigured).toEqual([{ terminalSessionId: "original-pane", conversationId: SESSION_ID }]);
    await publishMarkerInventory(f);
    expect(f.iterm.markersConfigured).toHaveLength(1);
  });

  it("does not retry a removed registration or color duplicate live instances", async () => {
    const f = await makeFixture({ observerRetryAfterMs: 0 });
    f.inspection.output = "p42\n";
    await f.controller.upsertHandoff(SESSION_ID, f.input());
    f.inspection.output = undefined;
    await publishMarkerInventory(f, [f.terminal, { ...f.terminal, sessionId: "duplicate-pane", jobPid: 43 }]);
    expect(f.iterm.markersConfigured).toEqual([]);
    await f.controller.removeHandoff(SESSION_ID, f.registry.getHandoff(SESSION_ID)!.version!);
    await publishMarkerInventory(f, [f.terminal]);
    expect(f.iterm.markersConfigured).toEqual([]);
  });

  it("does not apply a retry if the card is removed during fresh identity verification", async () => {
    const f = await makeFixture({ observerRetryAfterMs: 0 });
    f.inspection.output = "p42\n";
    await f.controller.upsertHandoff(SESSION_ID, f.input());
    f.inspection.output = undefined;
    let reads = 0;
    f.inspection.beforeRead = async () => {
      if (++reads === 1) await f.controller.removeHandoff(SESSION_ID, f.registry.getHandoff(SESSION_ID)!.version!);
    };
    await publishMarkerInventory(f);
    expect(f.registry.getHandoff(SESSION_ID)).toBeUndefined();
    expect(f.iterm.markersConfigured).toEqual([]);
  });

  it("recovers an unmarked saved registration after restart", async () => {
    const f = await makeFixture({ observerRetryAfterMs: 0 });
    f.inspection.output = "p42\n";
    await f.controller.upsertHandoff(SESSION_ID, f.input());
    await f.controller.stop();
    f.inspection.output = undefined;
    const restarted = new SessionAtlasController({ config: f.config, registry: f.registry, codex: f.codex, iterm: f.iterm,
      legacyCodexObserver: f.controller.legacyCodexObserver, rolloutWriterCheck: f.writerCheck });
    cleanups.push(() => restarted.stop());
    await restarted.start();
    expect(f.iterm.markersConfigured).toEqual([{ terminalSessionId: "original-pane", conversationId: SESSION_ID }]);
  });

  it("a failed registration marker does not fail the card write", async () => {
    const f = await makeFixture();
    f.iterm.markerError = new Error("Profile write failed");
    await expect(f.controller.upsertHandoff(SESSION_ID, f.input())).resolves.toMatchObject({ sessionId: SESSION_ID });
    expect(f.registry.getHandoff(SESSION_ID)).toBeDefined();
  });

  it("registration does not repaint an already marked pane", async () => {
    const f = await makeFixture();
    await f.controller.upsertHandoff(SESSION_ID, f.input());
    expect(f.iterm.markersConfigured).toHaveLength(1);
    await publishMarkerInventory(f, [savedMarker(f.terminal, "applied")]);
    await f.controller.upsertHandoff(SESSION_ID, f.input());
    expect(f.iterm.markersConfigured).toHaveLength(1);
  });

  it.each([false, true])("marks an exact saved existing thread when opened through Atlas, reference only=%s", async (referenceOnly) => {
    const f = await makeFixture();
    await f.controller.upsertHandoff(SESSION_ID, f.input(referenceOnly ? { items: [], reference: { title: "Useful", reason: "For later" } } : {}));
    f.iterm.markersConfigured.length = 0; // Registration already marked the verified pane.
    expect((await f.controller.resumeHandoff(SESSION_ID)).action).toBe("focused");
    expect(f.iterm.markersConfigured).toEqual([{ terminalSessionId: "original-pane", conversationId: SESSION_ID }]);
    expect(f.iterm.restored).toEqual([]);
  });

  it("a failed optional marker does not fail a successful focus or create another tab", async () => {
    const f = await makeFixture();
    await f.controller.upsertHandoff(SESSION_ID, f.input());
    f.iterm.markerError = new Error("Profile write failed");
    await expect(f.controller.resumeHandoff(SESSION_ID)).resolves.toMatchObject({ action: "focused" });
    expect(f.iterm.restored).toEqual([]);
    expect(f.registry.getHandoff(SESSION_ID)).toBeDefined();
  });

  it("does not mark when another pane appears during focus", async () => {
    const f = await makeFixture();
    await f.controller.upsertHandoff(SESSION_ID, f.input());
    f.iterm.markersConfigured.length = 0; // Registration already marked the verified pane.
    f.iterm.beforeFocus = () => { f.iterm.sessions.push({ ...f.terminal, sessionId: "second-pane", jobPid: 43 }); };
    await f.controller.resumeHandoff(SESSION_ID);
    expect(f.iterm.markersConfigured).toEqual([]);
  });

  it("restore requests retain provenance without displaying a marker before observation", async () => {
    const f = await makeFixture({ active: false });
    await f.controller.upsertHandoff(SESSION_ID, f.input());
    await f.controller.resumeHandoff(SESSION_ID);
    expect(f.iterm.restored[0]?.target.savedCard).toBe(true);
    expect(f.iterm.markersConfigured).toEqual([]);
    await publishMarkerInventory(f, [savedMarker({ ...f.terminal, sessionId: "restored-pane" })]);
    expect(f.iterm.markersConfigured).toEqual([{ terminalSessionId: "restored-pane", conversationId: SESSION_ID }]);
  });

  it("a resume command without an open original rollout stays unmarked", async () => {
    const f = await makeFixture();
    await f.controller.upsertHandoff(SESSION_ID, f.input());
    f.iterm.markersConfigured.length = 0; // Registration already marked the verified pane.
    f.inspection.output = "p42\n";
    const requested = savedMarker(f.terminal);
    await publishMarkerInventory(f, [requested]);
    expect(f.iterm.markersConfigured).toEqual([]);
    expect(f.iterm.markersCleared[0]?.forget).toBe(false);
  });

  it.each(["different-thread", "duplicate"])("rechecks real rollout ownership on retry despite a warm 30-second cache: %s", async (change) => {
    const f = await makeFixture({ observerRetryAfterMs: 30_000 });
    await f.controller.upsertHandoff(SESSION_ID, f.input());
    f.iterm.markersConfigured.length = 0; // Registration already marked the verified pane.
    const otherPath = join(f.codexHome, "sessions", `rollout-${OTHER_SESSION_ID}.jsonl`);
    await writeFile(otherPath, JSON.stringify({ type: "session_meta", payload: { id: OTHER_SESSION_ID, cwd: f.project, source: "cli" } }) + "\n");
    const panes = [savedMarker(f.terminal), ...(change === "duplicate" ? [{ ...f.terminal, sessionId: "other-pane", jobPid: 43, tty: "/dev/ttys002", commandLine: `codex resume ${OTHER_SESSION_ID}` }] : [])];
    f.inspection.output = `p42\nn${f.rolloutPath}\np43\nn${otherPath}\n`;
    f.iterm.markerError = new Error("Temporary profile failure");
    await publishMarkerInventory(f, panes);
    expect(f.iterm.markersConfigured).toHaveLength(1);
    f.iterm.markerError = undefined;
    f.inspection.output = change === "different-thread" ? `p42\nn${otherPath}\n` : `p42\nn${f.rolloutPath}\np43\nn${f.rolloutPath}\n`;
    await publishMarkerInventory(f, panes);
    expect(f.iterm.markersConfigured).toHaveLength(1);
    expect(f.iterm.markersCleared.at(-1)?.forget).toBe(change === "different-thread");
  });

  it.each([0, 30_000])("retries when fresh proof briefly disappears without an intervening unknown snapshot, cache=%s", async (retryAfterMs) => {
    const now = vi.spyOn(Date, "now");
    const f = await makeFixture({ observerRetryAfterMs: retryAfterMs });
    await f.controller.upsertHandoff(SESSION_ID, f.input());
    f.iterm.markersConfigured.length = 0; // Registration already marked the verified pane.
    let reads = 0;
    f.inspection.beforeRead = async () => { f.inspection.output = ++reads === 2 ? "p42\n" : undefined; };
    await publishMarkerInventory(f, [savedMarker(f.terminal)]);
    expect(reads).toBe(2);
    expect(f.iterm.markersConfigured).toEqual([]);
    expect(f.iterm.markersCleared.at(-1)?.forget).toBe(false);
    const later = Date.now() + retryAfterMs + 1;
    now.mockReturnValue(later);
    await publishMarkerInventory(f);
    expect(f.iterm.markersConfigured).toHaveLength(1);
    await publishMarkerInventory(f);
    expect(f.iterm.markersConfigured).toHaveLength(1);
  });

  it("clears visible state on an uncertain identity and can reapply after it is verified", async () => {
    const f = await makeFixture();
    await f.controller.upsertHandoff(SESSION_ID, f.input());
    f.iterm.markersConfigured.length = 0; // Registration already marked the verified pane.
    await publishMarkerInventory(f, [savedMarker({ ...f.terminal, jobName: "zsh", commandLine: "zsh" }, "applied")]);
    expect(f.iterm.markersCleared).toEqual([{ terminalSessionId: "original-pane", conversationId: SESSION_ID, forget: false }]);
    await publishMarkerInventory(f, [savedMarker(f.terminal)]);
    expect(f.iterm.markersConfigured).toHaveLength(1);
  });

  it("does not color duplicate instances and clears an already visible duplicate marker", async () => {
    const f = await makeFixture();
    await f.controller.upsertHandoff(SESSION_ID, f.input());
    f.iterm.markersConfigured.length = 0; // Registration already marked the verified pane.
    await publishMarkerInventory(f, [savedMarker(f.terminal, "applied"), { ...f.terminal, sessionId: "duplicate-pane", jobPid: 43 }]);
    expect(f.iterm.markersConfigured).toEqual([]);
    expect(f.iterm.markersCleared[0]?.forget).toBe(false);
    await publishMarkerInventory(f, [savedMarker(f.terminal)]);
    expect(f.iterm.markersConfigured).toHaveLength(1);
  });

  it("forgets inherited split provenance", async () => {
    const f = await makeFixture();
    await f.controller.upsertHandoff(SESSION_ID, f.input());
    f.iterm.markersConfigured.length = 0; // Registration already marked the verified pane.
    await publishMarkerInventory(f, [{ ...savedMarker(f.terminal, "applied"), savedMarkerOwnerSessionId: "different-pane" }]);
    expect(f.iterm.markersConfigured).toEqual([]);
    expect(f.iterm.markersCleared[0]?.forget).toBe(true);
  });

  it("forgets provenance after the pane switches to another verified original thread", async () => {
    const f = await makeFixture();
    await f.controller.upsertHandoff(SESSION_ID, f.input());
    f.iterm.markersConfigured.length = 0; // Registration already marked the verified pane.
    const otherPath = join(f.codexHome, "sessions", `rollout-${OTHER_SESSION_ID}.jsonl`);
    await writeFile(otherPath, JSON.stringify({ type: "session_meta", payload: { id: OTHER_SESSION_ID, cwd: f.project, source: "cli" } }) + "\n");
    f.inspection.output = `p42\nn${otherPath}\n`;
    await publishMarkerInventory(f, [savedMarker(f.terminal, "applied")]);
    expect(f.iterm.markersConfigured).toEqual([]);
    expect(f.iterm.markersCleared[0]?.forget).toBe(true);
  });

  it("rejects a stale marker identity check when the process changes during inspection", async () => {
    const f = await makeFixture();
    await f.controller.upsertHandoff(SESSION_ID, f.input());
    f.iterm.markersConfigured.length = 0; // Registration already marked the verified pane.
    const entered = deferred();
    const release = deferred();
    f.inspection.beforeRead = async () => { entered.resolve(); await release.promise; };
    const pending = publishMarkerInventory(f, [savedMarker(f.terminal)]);
    await entered.promise;
    f.iterm.sessions = [savedMarker({ ...f.terminal, jobPid: 99 })];
    release.resolve();
    await pending;
    expect(f.iterm.markersConfigured).toEqual([]);
    f.inspection.beforeRead = undefined;
    await publishMarkerInventory(f);
    expect(f.iterm.markersConfigured).toHaveLength(1);
  });

  it.each(["requested", "applied"] as const)("clears %s provenance when the saved card is removed without a terminal change", async (state) => {
    const f = await makeFixture();
    await f.controller.upsertHandoff(SESSION_ID, f.input());
    await publishMarkerInventory(f, [savedMarker(f.terminal, state)]);
    await f.controller.removeHandoff(SESSION_ID, f.registry.getHandoff(SESSION_ID)!.version!);
    await vi.waitFor(() => expect(f.iterm.markersCleared).toContainEqual({ terminalSessionId: "original-pane", conversationId: SESSION_ID, forget: true }));
  });

  it("finishing pending work retains a bookmark marker, then removing the bookmark clears it", async () => {
    const f = await makeFixture();
    await f.controller.upsertHandoff(SESSION_ID, f.input({ reference: { title: "Useful", reason: "Reference" } }));
    await publishMarkerInventory(f, [savedMarker(f.terminal, "applied")]);
    await f.controller.upsertHandoff(SESSION_ID, f.input({ items: [] }));
    await publishMarkerInventory(f);
    expect(f.iterm.markersCleared).toEqual([]);
    await f.controller.upsertHandoff(SESSION_ID, f.input({ items: [], reference: null }));
    await vi.waitFor(() => expect(f.iterm.markersCleared[0]?.forget).toBe(true));
  });

  it("resumes requested marker work after a controller restart without rearming ordinary panes", async () => {
    const f = await makeFixture();
    await f.controller.upsertHandoff(SESSION_ID, f.input());
    f.iterm.markersConfigured.length = 0; // Registration already marked the verified pane.
    await f.controller.stop();
    f.iterm.sessions = [savedMarker(f.terminal)];
    const restarted = new SessionAtlasController({ config: f.config, registry: f.registry, codex: f.codex, iterm: f.iterm,
      legacyCodexObserver: f.controller.legacyCodexObserver, rolloutWriterCheck: f.writerCheck });
    cleanups.push(() => restarted.stop());
    await restarted.start();
    expect(f.iterm.markersConfigured).toHaveLength(1);
  });

  it("bounds failed profile writes despite repeated observation timestamps", async () => {
    const f = await makeFixture();
    await f.controller.upsertHandoff(SESSION_ID, f.input());
    f.iterm.markersConfigured.length = 0; // Registration already marked the verified pane.
    f.iterm.markerError = new Error("Unavailable");
    for (let index = 0; index < 5; index++) await publishMarkerInventory(f, [savedMarker(f.terminal)]);
    expect(f.iterm.markersConfigured).toHaveLength(2);
    expect(f.iterm.markersCleared).toEqual([]);
  });

  it("performs no marker writes while disconnected or after stop", async () => {
    const f = await makeFixture();
    await f.controller.upsertHandoff(SESSION_ID, f.input());
    f.iterm.markersConfigured.length = 0; // Registration already marked the verified pane.
    f.iterm.health = { status: "offline" };
    f.iterm.emit("health", f.iterm.health);
    await publishMarkerInventory(f, [savedMarker(f.terminal)]);
    expect(f.iterm.markersConfigured).toEqual([]);
    await f.controller.stop();
    f.iterm.health = { status: "online" };
    f.iterm.emit("snapshot", f.iterm.sessions);
    expect(f.iterm.markersConfigured).toEqual([]);
  });

  it("stops without waiting for read-only observation and prevents its later persistence", async () => {
    const f = await makeFixture();
    const entered = deferred();
    const release = deferred();
    const finished = deferred();
    vi.spyOn(f.controller.legacyCodexObserver, "observeAll").mockImplementation(async () => {
      entered.resolve(); await release.promise; finished.resolve(); return [{ status: "linked", conversationId: SESSION_ID }];
    });
    const persist = vi.spyOn(f.registry, "observeRecoveries");
    f.iterm.emit("snapshot", [savedMarker(f.terminal)]);
    await entered.promise;
    await f.controller.stop();
    release.resolve();
    await finished.promise;
    await Promise.resolve();
    expect(persist).not.toHaveBeenCalled();
    expect(f.iterm.markersConfigured).toEqual([]);
  });

  it("waits for already-started recovery persistence before shutdown returns", async () => {
    const f = await makeFixture();
    const entered = deferred();
    const release = deferred();
    const persist = f.registry.observeRecoveries.bind(f.registry);
    vi.spyOn(f.registry, "observeRecoveries").mockImplementation(async (...args) => {
      entered.resolve(); await release.promise; await persist(...args);
    });
    const providerStopped = vi.spyOn(f.iterm, "stop");
    f.iterm.emit("snapshot", [{ ...f.terminal, tabIndex: 7 }]);
    await entered.promise;
    let stopped = false;
    const stopping = f.controller.stop().then(() => { stopped = true; });
    await vi.waitFor(() => expect(providerStopped).toHaveBeenCalled());
    expect(stopped).toBe(false);
    release.resolve();
    await stopping;
    const saved = JSON.parse(await readFile(f.config.recoveryStateFile, "utf8"));
    expect(saved.recoveries[SESSION_ID]).toBeDefined();
  });
});

describe("bookmark thread titles", () => {
  const reference = { title: "日志核查结论", reason: "以后排查时参考" };
  function titleClient(initialName: string | undefined = "日志核查") {
    const client = {
      name: initialName as string | undefined,
      readName: vi.fn(async (_id: string): Promise<string | undefined> => client.name),
      rename: vi.fn(async (_id: string, expectedName: string, name: string): Promise<boolean> => {
        if (client.name !== expectedName) return false;
        client.name = name;
        return true;
      }),
    };
    return client;
  }

  it("marks the exact bookmarked thread without a linked pane, preserving card content and tags", async () => {
    const client = titleClient();
    const f = await makeFixture({ active: false, bookmarkTitleClient: client });
    await f.controller.updateThreadTags(SESSION_ID, { add: ["Log4j2"] });
    client.rename.mockImplementationOnce(async (id, expected, name) => {
      const persisted = new RecoveryStore(f.config.recoveryStateFile);
      await persisted.load();
      expect(persisted.list()[0]?.bookmarkTitleMarker).toEqual({ originalName: expected, appliedName: name });
      expect(id).toBe(SESSION_ID);
      client.name = name;
      return true;
    });
    const saved = await f.controller.upsertHandoff(SESSION_ID, f.input({ items: [], reference }));
    expect(client.name).toBe("🔖 日志核查");
    expect(saved).toMatchObject({ tags: ["Log4j2"], handoff: { items: [], reference } });
    expect(f.iterm.markersConfigured).toEqual([]);
    expect(f.iterm.focused).toEqual([]);
    expect(f.iterm.restored).toEqual([]);
  });

  it("does not rename a pending-only thread and does not duplicate a retained bookmark prefix", async () => {
    const client = titleClient();
    const f = await makeFixture({ bookmarkTitleClient: client });
    await f.controller.upsertHandoff(SESSION_ID, f.input());
    expect(client.readName).not.toHaveBeenCalled();
    await f.controller.upsertHandoff(SESSION_ID, f.input({ reference }));
    await f.controller.upsertHandoff(SESSION_ID, f.input({ summary: "更新待续说明" }));
    expect(client.rename).toHaveBeenCalledTimes(1);
    expect(client.name).toBe("🔖 日志核查");
    expect(f.registry.getHandoff(SESSION_ID)?.reference).toEqual(reference);
  });

  it.each(["reference", "handoff"] as const)("removing the %s restores only the owned name", async (kind) => {
    const client = titleClient();
    const f = await makeFixture({ bookmarkTitleClient: client });
    const saved = await f.controller.upsertHandoff(SESSION_ID, f.input({ reference }));
    if (kind === "reference") {
      const result = await f.controller.upsertHandoff(SESSION_ID, f.input({ reference: null }));
      expect(result.handoff?.items).toEqual(saved.handoff?.items);
    } else {
      await f.controller.removeHandoff(SESSION_ID, saved.handoff!.version!);
      expect(f.registry.getHandoff(SESSION_ID)).toBeUndefined();
    }
    expect(client.name).toBe("日志核查");
    expect(f.registry.requireRecovery(SESSION_ID).bookmarkTitleMarker).toBeUndefined();
  });

  it("does not claim an existing prefix or use an empty, oversized, or control-bearing title", async () => {
    const client = titleClient("🔖 用户自己标的");
    const f = await makeFixture({ bookmarkTitleClient: client });
    for (const name of ["🔖 用户自己标的", "", "x".repeat(257), "unsafe\u001btitle"]) {
      client.name = name;
      await f.controller.upsertHandoff(SESSION_ID, f.input({ reference }));
      expect(f.registry.requireRecovery(SESSION_ID).bookmarkTitleMarker).toBeUndefined();
    }
    expect(client.rename).not.toHaveBeenCalled();
  });

  it("preserves a manual rename instead of restoring the old name on cancellation", async () => {
    const client = titleClient();
    const f = await makeFixture({ bookmarkTitleClient: client });
    await f.controller.upsertHandoff(SESSION_ID, f.input({ reference }));
    client.name = "用户改过的名称";
    await f.controller.upsertHandoff(SESSION_ID, f.input({ reference: null }));
    expect(client.name).toBe("用户改过的名称");
    expect(client.rename).toHaveBeenCalledTimes(1);
    expect(f.registry.requireRecovery(SESSION_ID).bookmarkTitleMarker).toBeUndefined();
  });

  it("leaves a changed name unowned when the daemon rejects the expected-name check", async () => {
    const client = titleClient();
    const f = await makeFixture({ bookmarkTitleClient: client });
    client.rename.mockImplementationOnce(async () => { client.name = "刚改的名称"; return false; });
    await expect(f.controller.upsertHandoff(SESSION_ID, f.input({ reference }))).resolves.toMatchObject({ handoff: { reference } });
    expect(client.name).toBe("刚改的名称");
    expect(f.registry.requireRecovery(SESSION_ID).bookmarkTitleMarker).toBeUndefined();
  });

  it("keeps ownership across a lost rename reply and safely removes the prefix later", async () => {
    const client = titleClient();
    const f = await makeFixture({ bookmarkTitleClient: client });
    client.rename.mockImplementationOnce(async (_id, _expected, name) => {
      client.name = name;
      throw new Error("reply lost");
    });
    const saved = await f.controller.upsertHandoff(SESSION_ID, f.input({ reference }));
    expect(saved.bookmarkTitleMarker?.appliedName).toBe(client.name);
    await expect(f.controller.syncBookmarkTitleMarker(SESSION_ID)).resolves.toEqual({ status: "applied" });
    expect(client.rename).toHaveBeenCalledTimes(1);
    await f.controller.upsertHandoff(SESSION_ID, f.input({ reference: null }));
    expect(client.name).toBe("日志核查");
  });

  it("keeps successful registration when daemon reads fail and never renames if ownership cannot be saved", async () => {
    const client = titleClient();
    const f = await makeFixture({ bookmarkTitleClient: client });
    client.readName.mockRejectedValueOnce(new Error("offline"));
    await expect(f.controller.upsertHandoff(SESSION_ID, f.input({ reference }))).resolves.toMatchObject({ handoff: { reference } });
    vi.spyOn(f.registry, "updateBookmarkTitleMarker").mockRejectedValueOnce(new Error("write failed"));
    await expect(f.controller.syncBookmarkTitleMarker(SESSION_ID)).resolves.toEqual({ status: "unavailable" });
    expect(client.rename).not.toHaveBeenCalled();
  });

  it("retries unavailable cleanup explicitly without modifying the saved card or accepting arbitrary names", async () => {
    const client = titleClient();
    const f = await httpFixture({ bookmarkTitleClient: client });
    await f.controller.upsertHandoff(SESSION_ID, f.input({ reference }));
    client.name = undefined;
    const saved = await f.controller.upsertHandoff(SESSION_ID, f.input({ reference: null }));
    expect(saved.bookmarkTitleMarker).toBeDefined();
    client.name = "🔖 日志核查";
    const path = `/api/handoffs/${SESSION_ID}/title-marker`;
    const wrongMethod = await f.request(path);
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("Allow")).toBe("POST");
    expect((await f.request(path, "POST", { name: "overwrite" })).status).toBe(400);
    expect((await f.request(`/api/handoffs/${OTHER_SESSION_ID}/title-marker`, "POST", {})).status).toBe(404);
    const response = await f.request(path, "POST", {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "cleared" });
    expect(client.name).toBe("日志核查");
    expect(f.registry.getHandoff(SESSION_ID)).toEqual(saved.handoff);
  });
});
