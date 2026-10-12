import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionAtlasHealth } from "../../shared/types.js";
import { AttentionStore } from "../attention-store.js";
import { loadConfig } from "../config.js";
import { SessionAtlasController } from "../controller.js";
import { LegacyCodexObserver } from "../legacy-codex-observer.js";
import type {
  ItermBridgeHealth,
  ItermSessionSnapshot,
  ProviderEvent,
} from "../provider-ports.js";
import { RecoveryStore } from "../recovery-store.js";
import { SessionRegistry } from "../session-registry.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

class EmptyCodex {
  async start() {}
  async stop() {}
  getHealth(): SessionAtlasHealth {
    return { controller: "online", codex: "online", iterm: "offline" };
  }
  async list() {
    return [];
  }
  async readExecution(): Promise<never> {
    throw new Error("unused");
  }
  async createThread(): Promise<never> {
    throw new Error("unused");
  }
  async sendMessage() {}
  async interrupt() {}
  async respondRequest() {}
  subscribe(_listener: (event: ProviderEvent) => void) {
    return () => undefined;
  }
}

class FakeIterm extends EventEmitter {
  health: ItermBridgeHealth = { status: "online" };
  sessions: ItermSessionSnapshot[];
  configured: Array<{
    sessionId: string;
    cwd: string;
    conversationId: string;
    controllerPort: number;
  }> = [];
  cleared: Array<{ sessionId: string; conversationId: string }> = [];
  configureError?: Error;
  clearFailuresRemaining = 0;

  constructor(sessions: ItermSessionSnapshot[]) {
    super();
    this.sessions = sessions;
  }

  async start() {}
  async stop() {}
  getHealth() {
    return this.health;
  }
  getSessions() {
    return this.sessions;
  }
  async focus() {}
  async configureAutoResume(
    session: ItermSessionSnapshot,
    conversationId: string,
    controllerPort: number,
  ) {
    this.configured.push({
      sessionId: session.sessionId,
      cwd: session.cwd,
      conversationId,
      controllerPort,
    });
    if (this.configureError) throw this.configureError;
  }
  async clearAutoResume(sessionId: string, conversationId: string) {
    this.cleared.push({ sessionId, conversationId });
    if (this.clearFailuresRemaining > 0) {
      this.clearFailuresRemaining -= 1;
      throw new Error("transient clear failure");
    }
  }
  async restoreLayout() {
    return "restored-window";
  }
  async restoreRecoveries() {}
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for controller recovery state");
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function makePreflightFixture(options: { autoResumeEnabled?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "session-atlas-preflight-storm-"));
  temporaryDirectories.push(directory);
  const config = loadConfig({
    homeDir: directory,
    projectDir: directory,
    applicationSupportDir: join(directory, "state"),
    allowedProjectRoots: [directory],
    deniedProjectRoots: [],
    development: false,
    autoResumeEnabled: options.autoResumeEnabled ?? false,
    port: 4_317,
    env: { NODE_ENV: "production" },
  });
  const registry = new SessionRegistry(
    new AttentionStore(config.attentionStateFile),
    new RecoveryStore(config.recoveryStateFile),
    config.staleAfterMs,
  );
  const iterm = new FakeIterm([]);
  const observer = new LegacyCodexObserver({ readCommand: async () => "" });
  const controller = new SessionAtlasController({ config, registry, codex: new EmptyCodex(), iterm, legacyCodexObserver: observer });
  await controller.start();
  const snapshot = (round: number): ItermSessionSnapshot => ({
    sessionId: "inventory-pane",
    name: `Inventory round ${round}`,
    cwd: directory,
    tty: "/dev/ttys001",
    jobName: "node",
    jobPid: 42,
    commandLine: "node worker.js",
    focused: round % 2 === 0,
    buried: false,
    windowId: "inventory-window",
    tabId: "inventory-tab",
    windowIndex: round % 2 + 1,
    tabIndex: round % 3 + 1,
    paneIndex: 1,
    observedAt: new Date(Date.parse("2026-09-10T08:00:00.000Z") + round * 1_000).toISOString(),
  });
  const emit = (sessions: ItermSessionSnapshot[]) => {
    iterm.sessions = sessions;
    iterm.emit("snapshot", sessions);
  };
  const input = {
    conversationId: "01234567-89ab-cdef-8123-456789abcdef",
    terminalSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  };
  return { config, controller, registry, iterm, observer, snapshot, emit, input };
}

async function ingestSnapshot(
  fixture: Awaited<ReturnType<typeof makePreflightFixture>>,
  sessions: ItermSessionSnapshot[],
  updateCurrentInventory = true,
): Promise<void> {
  const ingested = deferred();
  const replaceWhere = fixture.registry.replaceWhere.bind(fixture.registry);
  const replacement = vi.spyOn(fixture.registry, "replaceWhere").mockImplementationOnce(async (...args) => {
    await replaceWhere(...args);
    ingested.resolve();
  });
  try {
    if (updateCurrentInventory) fixture.iterm.sessions = sessions;
    fixture.iterm.emit("snapshot", sessions);
    await ingested.promise;
  } finally {
    replacement.mockRestore();
  }
}

describe("SessionAtlasController recovery ingestion", () => {
  it("rearms a fresh cleared profile after a queued stale helper snapshot was positively linked", async () => {
    const f = await makePreflightFixture({ autoResumeEnabled: true });
    const conversationId = f.input.conversationId;
    const helper: ItermSessionSnapshot = {
      ...f.snapshot(1), jobName: "codex", commandLine: `codex resume ${conversationId}`,
      autoResumeConversationId: conversationId, autoResumeKind: "helper", autoResumeControllerPort: f.config.port,
    };
    const capturedBeforeClear = { ...helper, observedAt: f.snapshot(2).observedAt };
    const observe = vi.spyOn(f.observer, "observeAll").mockResolvedValue([{ status: "unlinked" }]);
    const clearAutoResume = f.iterm.clearAutoResume.bind(f.iterm);
    vi.spyOn(f.iterm, "clearAutoResume").mockImplementation(async (sessionId, id) => {
      await clearAutoResume(sessionId, id);
      f.iterm.sessions = f.iterm.sessions.map((session) => ({
        ...session, autoResumeConversationId: undefined, autoResumeKind: undefined, autoResumeControllerPort: undefined,
      }));
    });
    const configureAutoResume = f.iterm.configureAutoResume.bind(f.iterm);
    vi.spyOn(f.iterm, "configureAutoResume").mockImplementation(async (session, id, port) => {
      await configureAutoResume(session, id, port);
      f.iterm.sessions = f.iterm.sessions.map((current) => ({
        ...current, autoResumeConversationId: id, autoResumeKind: "helper", autoResumeControllerPort: port,
      }));
    });

    try {
      await ingestSnapshot(f, [helper]);
      expect(f.iterm.cleared).toEqual([{ sessionId: helper.sessionId, conversationId }]);
      expect(f.iterm.sessions[0]?.autoResumeKind).toBeUndefined();
      observe.mockResolvedValue([{ status: "linked", conversationId }]);
      await ingestSnapshot(f, [capturedBeforeClear], false);
      expect(f.iterm.configured).toEqual([]);
      expect(f.iterm.sessions[0]?.autoResumeKind).toBeUndefined();

      f.iterm.configureError = new Error("temporary profile write failure");
      await ingestSnapshot(f, [{ ...f.iterm.sessions[0]!, observedAt: f.snapshot(3).observedAt }]);
      expect(f.iterm.configured).toHaveLength(1);
      expect(f.iterm.sessions[0]?.autoResumeKind).toBeUndefined();
      expect(f.controller.snapshot().health).toMatchObject({ autoResume: "degraded", autoResumeUnarmedSessions: 1 });

      f.iterm.configureError = undefined;
      await ingestSnapshot(f, [{ ...f.iterm.sessions[0]!, observedAt: f.snapshot(4).observedAt }]);
      expect(f.iterm.configured).toHaveLength(2);
      expect(f.iterm.sessions[0]).toMatchObject({
        autoResumeKind: "helper", autoResumeConversationId: conversationId, autoResumeControllerPort: f.config.port,
      });
      expect(f.controller.snapshot().health).toMatchObject({ autoResume: "online", autoResumeUnarmedSessions: 0 });
      expect(f.iterm.cleared).toHaveLength(1);
    } finally {
      await f.controller.stop();
    }
  });

  it("does not endlessly retry a fixed configuration failure as timestamps, titles, and focus change", async () => {
    const f = await makePreflightFixture({ autoResumeEnabled: true });
    const conversationId = f.input.conversationId;
    vi.spyOn(f.observer, "observeAll").mockResolvedValue([{ status: "linked", conversationId }]);
    f.iterm.configureError = new Error("unrelated custom command must remain unchanged");
    const terminal = { ...f.snapshot(1), jobName: "codex", commandLine: `codex resume ${conversationId}` };
    try {
      for (let round = 1; round <= 32; round += 1) {
        const metadata = f.snapshot(round);
        await ingestSnapshot(f, [{ ...terminal, name: metadata.name, focused: metadata.focused, observedAt: metadata.observedAt }]);
        expect(f.iterm.configured).toHaveLength(Math.min(round, 2));
        expect(f.controller.snapshot().health).toMatchObject({ autoResume: "degraded", autoResumeUnarmedSessions: 1 });
      }
      expect(f.iterm.cleared).toEqual([]);
      expect(f.iterm.sessions[0]?.autoResumeKind).toBeUndefined();
    } finally {
      await f.controller.stop();
    }
  });

  it("returns preflight while an ongoing metadata-only snapshot storm continues", async () => {
    const f = await makePreflightFixture();
    const stages = Array.from({ length: 3 }, () => ({ entered: deferred(), gate: deferred() }));
    let stormActive = true;
    let inspections = 0;
    vi.spyOn(f.observer, "observeAll").mockImplementation(async (sessions) => {
      const stage = stages[inspections++];
      if (stormActive) f.emit([f.snapshot(inspections + 1)]);
      stage?.entered.resolve();
      if (stage) await stage.gate.promise;
      return sessions.map(() => ({ status: "unlinked" as const }));
    });
    f.emit([f.snapshot(1)]);
    await stages[0]!.entered.promise;
    let result: unknown;
    const preflight = f.controller.preflightAutoResume(f.input).then(
      (value) => { result = value; },
      (error: unknown) => { result = error; },
    );
    try {
      stages[0]!.gate.resolve();
      await stages[1]!.entered.promise;
      stages[1]!.gate.resolve();
      await stages[2]!.entered.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(stormActive).toBe(true);
      expect(inspections).toBe(3);
      expect(result).toEqual({ activeElsewhere: false, duplicateProfileCleared: false });
      expect(f.iterm.cleared).toEqual([]);
    } finally {
      stormActive = false;
      stages.forEach((stage) => stage.gate.resolve());
      await preflight;
      await f.controller.preflightAutoResume(f.input);
      await f.controller.stop();
    }
  });

  it("rejects a preflight when a new owner arrives during its own ingestion and retries against that owner", async () => {
    const f = await makePreflightFixture();
    const stages = Array.from({ length: 3 }, () => ({ entered: deferred(), gate: deferred() }));
    let inspections = 0;
    const ownerId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    vi.spyOn(f.observer, "observeAll").mockImplementation(async (sessions) => {
      const stage = stages[inspections++];
      stage?.entered.resolve();
      if (stage) await stage.gate.promise;
      return sessions.map((session) => session.sessionId === ownerId
        ? { status: "linked" as const, conversationId: f.input.conversationId }
        : { status: "unlinked" as const });
    });
    f.emit([f.snapshot(1)]);
    await stages[0]!.entered.promise;
    f.emit([f.snapshot(2)]);
    let result: unknown;
    const preflight = f.controller.preflightAutoResume(f.input).then(
      (value) => { result = value; },
      (error: unknown) => { result = error; },
    );
    try {
      stages[0]!.gate.resolve();
      await stages[1]!.entered.promise;
      f.emit([{
        ...f.snapshot(3),
        sessionId: ownerId,
        name: "New live Codex owner",
        tty: "/dev/ttys002",
        jobName: "codex",
        jobPid: 43,
        commandLine: `codex resume ${f.input.conversationId}`,
      }]);
      stages[1]!.gate.resolve();
      await stages[2]!.entered.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(result).toMatchObject({ status: 503, code: "ITERM_SNAPSHOT_UNAVAILABLE" });
      expect(f.iterm.cleared).toEqual([]);
      stages[2]!.gate.resolve();
      await preflight;
      await expect(f.controller.preflightAutoResume(f.input)).resolves.toEqual({
        activeElsewhere: true,
        duplicateProfileCleared: true,
      });
      expect(f.registry.requireRecovery(f.input.conversationId).terminalSessionId).toBe(ownerId);
      expect(f.iterm.cleared).toEqual([{ sessionId: f.input.terminalSessionId, conversationId: f.input.conversationId }]);
    } finally {
      stages.forEach((stage) => stage.gate.resolve());
      await preflight;
      await f.controller.preflightAutoResume(f.input);
      await f.controller.stop();
    }
  });

  it("drains a newer pending owner snapshot before granting a preflight claim", async () => {
    const directory = await mkdtemp(join(tmpdir(), "session-atlas-preflight-ordering-"));
    temporaryDirectories.push(directory);
    const config = loadConfig({
      homeDir: directory,
      projectDir: directory,
      applicationSupportDir: join(directory, "state"),
      allowedProjectRoots: [directory],
      deniedProjectRoots: [],
      development: false,
      port: 4_317,
      env: { NODE_ENV: "production" },
    });
    const registry = new SessionRegistry(
      new AttentionStore(config.attentionStateFile),
      new RecoveryStore(config.recoveryStateFile),
      config.staleAfterMs,
    );
    const iterm = new FakeIterm([]);
    let markInspectionStarted!: () => void;
    let releaseInspection!: () => void;
    const inspectionStarted = new Promise<void>((resolve) => { markInspectionStarted = resolve; });
    const inspectionGate = new Promise<void>((resolve) => { releaseInspection = resolve; });
    const controller = new SessionAtlasController({
      config,
      registry,
      codex: new EmptyCodex(),
      iterm,
      legacyCodexObserver: new LegacyCodexObserver({
        readCommand: async (file) => {
          if (file.endsWith("/ps")) {
            if (iterm.sessions[0]?.sessionId === "inventory-pane") {
              markInspectionStarted();
              await inspectionGate;
              return " 42 1 ttys001 node worker.js\n";
            }
            return " 43 1 ttys002 codex resume 01234567-89ab-cdef-8123-456789abcdef\n";
          }
          return "p42\n";
        },
      }),
    });
    await controller.start();
    iterm.sessions = [{
      sessionId: "inventory-pane",
      name: "Node child",
      cwd: directory,
      tty: "/dev/ttys001",
      jobName: "node",
      jobPid: 42,
      commandLine: "node worker.js",
      focused: true,
      buried: false,
      observedAt: "2026-09-02T00:00:00.000Z",
    }];
    iterm.emit("snapshot", iterm.sessions);
    await inspectionStarted;

    let firstSettled = false;
    const first = controller.preflightAutoResume({
      conversationId: "01234567-89ab-cdef-8123-456789abcdef",
      terminalSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    }).then((value) => {
      firstSettled = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(firstSettled).toBe(false);
    iterm.sessions = [{
      sessionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      name: "Existing Codex owner",
      cwd: directory,
      tty: "/dev/ttys002",
      jobName: "codex",
      jobPid: 43,
      commandLine: "codex resume 01234567-89ab-cdef-8123-456789abcdef",
      focused: true,
      buried: false,
      observedAt: "2026-09-02T00:00:02.000Z",
    }];
    iterm.emit("snapshot", iterm.sessions);
    releaseInspection();
    await expect(first).resolves.toMatchObject({ activeElsewhere: true });
    await expect(controller.preflightAutoResume({
      conversationId: "01234567-89ab-cdef-8123-456789abcdef",
      terminalSessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    })).resolves.toMatchObject({ activeElsewhere: true });

    await controller.stop();
  });

  it("records automatically and closes only after an online authoritative snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "session-atlas-controller-recovery-"));
    temporaryDirectories.push(directory);
    const config = loadConfig({
      homeDir: directory,
      projectDir: directory,
      applicationSupportDir: join(directory, "state"),
      allowedProjectRoots: [directory],
      deniedProjectRoots: [],
      development: false,
      port: 4_317,
      env: { NODE_ENV: "production" },
    });
    const registry = new SessionRegistry(
      new AttentionStore(config.attentionStateFile),
      new RecoveryStore(config.recoveryStateFile),
      config.staleAfterMs,
    );
    const terminal: ItermSessionSnapshot = {
      sessionId: "terminal-one",
      name: "Code (codex)",
      cwd: directory,
      tty: "/dev/ttys001",
      jobName: "codex",
      jobPid: 42,
      commandLine: "codex",
      focused: true,
      buried: false,
      observedAt: "2026-08-27T12:00:00.000Z",
    };
    const iterm = new FakeIterm([terminal]);
    const observer = new LegacyCodexObserver({
      codexHome: join(directory, ".codex"),
      readCommand: async (file) =>
        file === "ps"
          ? " 42 1 ttys001 codex\n"
          : `p42\nn${join(
              directory,
              ".codex/sessions/rollout-01234567-89ab-cdef-8123-456789abcdef.jsonl",
            )}\n`,
    });
    const controller = new SessionAtlasController({
      config,
      registry,
      codex: new EmptyCodex(),
      iterm,
      legacyCodexObserver: observer,
    });

    await controller.start();
    expect(controller.snapshot().recoveries[0]?.status).toBe("active");
    await expect(controller.readRecoveryPreviews({
      sessionIds: ["01234567-89ab-cdef-8123-456789abcdef"],
    })).rejects.toMatchObject({
      status: 409,
      code: "RECOVERY_STILL_ACTIVE",
    });

    iterm.health = { status: "offline", message: "bridge unavailable" };
    iterm.emit("health", iterm.health);
    iterm.sessions = [];
    iterm.emit("snapshot", []);
    await waitFor(() => controller.snapshot().sessions.length === 0);
    expect(controller.snapshot().recoveries[0]?.status).toBe("active");

    iterm.health = { status: "online" };
    iterm.emit("health", iterm.health);
    iterm.emit("snapshot", []);
    await waitFor(() => controller.snapshot().recoveries[0]?.status === "closed");
    expect(controller.snapshot().recoveries[0]?.closedAt).toBeDefined();
    await expect(controller.readRecoveryPreviews({
      sessionIds: ["01234567-89ab-cdef-8123-456789abcdef"],
    })).resolves.toEqual({
      previews: [{
        sessionId: "01234567-89ab-cdef-8123-456789abcdef",
        status: "missing",
      }],
    });

    await controller.stop();
  });

  it("arms each uniquely linked visible Codex pane once without creating a layout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "session-atlas-controller-auto-resume-"));
    temporaryDirectories.push(directory);
    const config = loadConfig({
      homeDir: directory,
      projectDir: directory,
      applicationSupportDir: join(directory, "state"),
      allowedProjectRoots: [directory],
      deniedProjectRoots: [],
      development: false,
      autoResumeEnabled: true,
      port: 5_432,
      env: { NODE_ENV: "production" },
    });
    const registry = new SessionRegistry(
      new AttentionStore(config.attentionStateFile),
      new RecoveryStore(config.recoveryStateFile),
      config.staleAfterMs,
    );
    const terminal: ItermSessionSnapshot = {
      sessionId: "terminal-one",
      name: "Code (codex)",
      cwd: directory,
      tty: "/dev/ttys001",
      jobName: "codex",
      jobPid: 42,
      commandLine: "codex",
      autoResumeConversationId: "01234567-89ab-cdef-8123-456789abcdef",
      autoResumeKind: "helper",
      autoResumeControllerPort: 4_317,
      focused: true,
      buried: false,
      observedAt: "2026-08-27T12:00:00.000Z",
    };
    const iterm = new FakeIterm([terminal]);
    const observer = new LegacyCodexObserver({
      codexHome: join(directory, ".codex"),
      readCommand: async (file) =>
        file === "ps"
          ? " 42 1 ttys001 codex\n"
          : `p42\nn${join(
              directory,
              ".codex/sessions/rollout-01234567-89ab-cdef-8123-456789abcdef.jsonl",
            )}\n`,
    });
    const controller = new SessionAtlasController({
      config,
      registry,
      codex: new EmptyCodex(),
      iterm,
      legacyCodexObserver: observer,
    });

    await controller.start();
    expect(iterm.configured).toEqual([
      {
        sessionId: "terminal-one",
        cwd: directory,
        conversationId: "01234567-89ab-cdef-8123-456789abcdef",
        controllerPort: 5_432,
      },
    ]);
    expect(controller.snapshot().health.autoResume).toBe("online");

    iterm.emit("snapshot", [
      {
        ...terminal,
        autoResumeConversationId: "01234567-89ab-cdef-8123-456789abcdef",
        autoResumeKind: "marker",
        observedAt: "2026-08-27T12:00:01.000Z",
      },
    ]);
    await waitFor(() => iterm.configured.length === 2);
    iterm.emit("snapshot", [
      {
        ...terminal,
        autoResumeConversationId: "01234567-89ab-cdef-8123-456789abcdef",
        autoResumeKind: "marker",
        observedAt: "2026-08-27T12:00:01.500Z",
      },
    ]);
    await waitFor(() =>
      controller.snapshot().sessions[0]?.observedAt.endsWith("01.500Z") === true
    );
    expect(iterm.configured).toHaveLength(2);

    iterm.clearFailuresRemaining = 1;
    iterm.emit("snapshot", [
      { ...terminal, observedAt: "2026-08-27T12:00:02.000Z" },
    ]);
    await waitFor(() => controller.snapshot().sessions[0]?.observedAt.endsWith("02.000Z") === true);
    expect(iterm.configured).toHaveLength(2);

    iterm.emit("snapshot", [
      {
        ...terminal,
        jobName: "zsh",
        commandLine: "-zsh",
        autoResumeConversationId: "01234567-89ab-cdef-8123-456789abcdef",
        observedAt: "2026-08-27T12:00:04.000Z",
      },
    ]);
    await waitFor(() => iterm.cleared.length === 1);
    iterm.emit("snapshot", [
      {
        ...terminal,
        jobName: "zsh",
        commandLine: "-zsh",
        autoResumeConversationId: "01234567-89ab-cdef-8123-456789abcdef",
        observedAt: "2026-08-27T12:00:06.000Z",
      },
    ]);
    await waitFor(() => iterm.cleared.length === 2);
    iterm.emit("snapshot", [
      {
        ...terminal,
        jobName: "zsh",
        commandLine: "-zsh",
        autoResumeConversationId: "01234567-89ab-cdef-8123-456789abcdef",
        observedAt: "2026-08-27T12:00:08.000Z",
      },
    ]);
    await waitFor(() => controller.snapshot().sessions[0]?.observedAt.endsWith("08.000Z") === true);
    expect(iterm.cleared).toHaveLength(2);

    await controller.stop();
  });

  it("retries a failed session-local auto-resume configuration once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "session-atlas-controller-auto-failure-"));
    temporaryDirectories.push(directory);
    const config = loadConfig({
      homeDir: directory,
      projectDir: directory,
      applicationSupportDir: join(directory, "state"),
      allowedProjectRoots: [directory],
      deniedProjectRoots: [],
      development: false,
      autoResumeEnabled: true,
      port: 4_317,
      env: { NODE_ENV: "production" },
    });
    const registry = new SessionRegistry(
      new AttentionStore(config.attentionStateFile),
      new RecoveryStore(config.recoveryStateFile),
      config.staleAfterMs,
    );
    const terminal: ItermSessionSnapshot = {
      sessionId: "terminal-one",
      name: "Code (codex)",
      cwd: directory,
      tty: "/dev/ttys001",
      jobName: "codex",
      jobPid: 42,
      commandLine: "codex",
      focused: true,
      buried: false,
      observedAt: "2026-08-27T12:00:00.000Z",
    };
    const iterm = new FakeIterm([terminal]);
    iterm.configureError = new Error("custom command already exists");
    const controller = new SessionAtlasController({
      config,
      registry,
      codex: new EmptyCodex(),
      iterm,
      legacyCodexObserver: new LegacyCodexObserver({
        codexHome: join(directory, ".codex"),
        readCommand: async (file) =>
          file === "ps"
            ? " 42 1 ttys001 codex\n"
            : `p42\nn${join(
                directory,
                ".codex/sessions/rollout-01234567-89ab-cdef-8123-456789abcdef.jsonl",
              )}\n`,
      }),
    });

    await controller.start();
    expect(controller.snapshot().health).toMatchObject({
      controller: "degraded",
      autoResume: "degraded",
      autoResumeUnarmedSessions: 1,
      message: "Automatic recovery could not be armed for 1 Codex session.",
    });
    iterm.configureError = undefined;
    iterm.emit("snapshot", [
      { ...terminal, observedAt: "2026-08-27T12:00:02.000Z" },
    ]);
    await waitFor(() => iterm.configured.length === 2);
    await waitFor(() => controller.snapshot().health.autoResume === "online");
    iterm.emit("snapshot", [
      { ...terminal, observedAt: "2026-08-27T12:00:04.000Z" },
    ]);
    await waitFor(() => controller.snapshot().sessions[0]?.observedAt.endsWith("04.000Z") === true);
    expect(iterm.configured).toHaveLength(2);

    await controller.stop();
  });

  it("releases a claim after the owner is no longer linked or armed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "session-atlas-controller-claim-release-"));
    temporaryDirectories.push(directory);
    const conversationId = "01234567-89ab-cdef-8123-456789abcdef";
    const config = loadConfig({
      homeDir: directory,
      projectDir: directory,
      applicationSupportDir: join(directory, "state"),
      allowedProjectRoots: [directory],
      deniedProjectRoots: [],
      development: false,
      autoResumeEnabled: true,
      port: 4_317,
      env: { NODE_ENV: "production" },
    });
    const registry = new SessionRegistry(
      new AttentionStore(config.attentionStateFile),
      new RecoveryStore(config.recoveryStateFile, { now: () => new Date("2026-08-27T12:05:00.000Z") }),
      config.staleAfterMs,
    );
    const terminalId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const terminal: ItermSessionSnapshot = {
      sessionId: terminalId,
      name: "Code (codex)",
      cwd: directory,
      tty: "/dev/ttys001",
      jobName: "codex",
      jobPid: 42,
      commandLine: "codex",
      autoResumeConversationId: conversationId,
      autoResumeKind: "helper",
      autoResumeControllerPort: 4_317,
      focused: true,
      buried: false,
      observedAt: "2026-08-27T12:00:00.000Z",
    };
    const iterm = new FakeIterm([terminal]);
    let linked = true;
    const controller = new SessionAtlasController({
      config,
      registry,
      codex: new EmptyCodex(),
      iterm,
      legacyCodexObserver: new LegacyCodexObserver({
        codexHome: join(directory, ".codex"),
        readCommand: async (file) => {
          if (file === "ps") return linked ? " 42 1 ttys001 codex\n" : " 42 1 ttys001 -zsh\n";
          return linked
            ? `p42\nn${join(directory, `.codex/sessions/rollout-${conversationId}.jsonl`)}\n`
            : "p42\n";
        },
      }),
    });

    await controller.start();
    iterm.emit("snapshot", iterm.sessions);
    await expect(controller.preflightAutoResume({
      conversationId,
      terminalSessionId: terminalId,
    })).resolves.toMatchObject({ activeElsewhere: false });

    linked = false;
    iterm.sessions = [{
      ...terminal,
      jobName: "zsh",
      commandLine: "-zsh",
      autoResumeConversationId: undefined,
      autoResumeKind: undefined,
      observedAt: "2026-08-27T12:00:02.000Z",
    }];
    iterm.emit("snapshot", iterm.sessions);
    await waitFor(() => controller.snapshot().recoveries[0]?.status === "closed");

    await expect(controller.preflightAutoResume({
      conversationId,
      terminalSessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    })).resolves.toMatchObject({ activeElsewhere: false });
    await controller.stop();
  });

  it("clears a marked recovery command when Codex is no longer positively linked", async () => {
    const directory = await mkdtemp(join(tmpdir(), "session-atlas-controller-unlinked-marker-"));
    temporaryDirectories.push(directory);
    const conversationId = "01234567-89ab-cdef-8123-456789abcdef";
    const config = loadConfig({
      homeDir: directory,
      projectDir: directory,
      applicationSupportDir: join(directory, "state"),
      allowedProjectRoots: [directory],
      deniedProjectRoots: [],
      development: false,
      autoResumeEnabled: true,
      port: 4_317,
      env: { NODE_ENV: "production" },
    });
    const registry = new SessionRegistry(
      new AttentionStore(config.attentionStateFile),
      new RecoveryStore(config.recoveryStateFile),
      config.staleAfterMs,
    );
    const iterm = new FakeIterm([
      {
        sessionId: "terminal-one",
        name: "Code (codex)",
        cwd: directory,
        tty: "/dev/ttys001",
        jobName: "codex",
        jobPid: 42,
        commandLine: "codex",
        focused: true,
        buried: false,
        autoResumeConversationId: conversationId,
        autoResumeKind: "legacy",
        observedAt: "2026-08-27T12:00:00.000Z",
      },
    ]);
    const controller = new SessionAtlasController({
      config,
      registry,
      codex: new EmptyCodex(),
      iterm,
      legacyCodexObserver: new LegacyCodexObserver({
        codexHome: join(directory, ".codex"),
        readCommand: async (file) => file === "ps" ? " 42 1 ttys001 codex\n" : "p42\n",
      }),
    });

    await controller.start();

    expect(iterm.cleared).toEqual([
      { sessionId: "terminal-one", conversationId },
    ]);
    expect(iterm.configured).toEqual([]);
    await controller.stop();
  });
});
