import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { SessionAtlasEvent, SessionSummary } from "../../shared/types.js";
import { AttentionStore } from "../attention-store.js";
import { RecoveryStore } from "../recovery-store.js";
import { SessionRegistry } from "../session-registry.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

function managedSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "managed:one",
    provider: "codex",
    conversationId: "thread-one",
    surface: "managed",
    title: "Original title",
    cwd: "/tmp/demo",
    projectKey: "/tmp/demo",
    projectName: "demo",
    activityState: "idle",
    attentionReason: "newly_completed",
    lastActivityAt: "2026-08-19T00:00:00.000Z",
    observedAt: new Date().toISOString(),
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
    ...overrides,
  };
}

async function makeRegistry(): Promise<SessionRegistry> {
  const directory = await mkdtemp(join(tmpdir(), "session-atlas-registry-"));
  temporaryDirectories.push(directory);
  const store = new AttentionStore(join(directory, "state.json"));
  const recoveryStore = new RecoveryStore(join(directory, "recovery.json"));
  const registry = new SessionRegistry(store, recoveryStore, 100);
  await registry.load();
  return registry;
}

describe("SessionRegistry", () => {
  it("projects UUID-owned tags across panes, managed sessions, recoveries and SSE without registering a handoff", async () => {
    const registry = await makeRegistry();
    const conversationId = "01234567-89ab-cdef-8123-456789abcdef";
    const terminal = {
      sessionId: "terminal-one", name: "Code (codex)", cwd: "/tmp/demo", jobName: "codex",
      focused: false, buried: false, observedAt: new Date().toISOString(),
    };
    await registry.observeRecoveries([terminal], [{ status: "linked", conversationId }]);
    const managed = managedSession({ id: conversationId, conversationId });
    const firstPane = managedSession({ id: "iterm:one", conversationId, surface: "legacy", terminalSessionId: "terminal-one" });
    const secondPane = managedSession({ id: "iterm:two", conversationId, surface: "legacy", terminalSessionId: "terminal-two" });
    const unrelated = managedSession({ id: "iterm:unknown", conversationId: undefined, provider: "terminal", surface: "legacy", tags: ["untrusted"] });
    const ambiguous = managedSession({ id: "iterm:ambiguous", conversationId: undefined, surface: "legacy", recoveryStatus: "ambiguous" });
    for (const session of [managed, firstPane, secondPane, unrelated, ambiguous]) await registry.upsert(session);
    const beforeRecoveryFile = await readFile(registry.recoveryStore.filePath, "utf8");
    const events: SessionAtlasEvent[] = [];
    registry.subscribe((event) => events.push(event));
    expect(await registry.updateThreadTags(conversationId, { add: ["量化", "AI"] })).toEqual({ sessionId: conversationId, tags: ["量化", "AI"] });
    for (const id of [conversationId, firstPane.id, secondPane.id]) expect(registry.requireSession(id).tags).toEqual(["量化", "AI"]);
    for (const id of [unrelated.id, ambiguous.id]) expect(registry.requireSession(id).tags).toBeUndefined();
    expect(registry.requireRecovery(conversationId).tags).toEqual(["量化", "AI"]);
    expect(registry.getHandoff(conversationId)).toBeUndefined();
    expect(await readFile(registry.recoveryStore.filePath, "utf8")).toBe(beforeRecoveryFile);
    expect(events.filter((event) => event.type === "session-upsert").map((event) => event.session.tags)).toEqual([
      ["量化", "AI"], ["量化", "AI"], ["量化", "AI"],
    ]);
    expect(events.at(-1)).toMatchObject({ type: "recovery-upsert", recovery: { sessionId: conversationId, tags: ["量化", "AI"] } });

    await registry.upsert({ ...firstPane, title: "Provider refresh" });
    expect(events.at(-1)).toMatchObject({ type: "session-upsert", session: { id: firstPane.id, tags: ["量化", "AI"] } });
    await registry.observeRecoveries([], []);
    expect(events.filter((event) => event.type === "recovery-upsert").at(-1)).toMatchObject({ recovery: { tags: ["量化", "AI"] } });
    const reloaded = new SessionRegistry(new AttentionStore(registry.attentionStore.filePath), new RecoveryStore(registry.recoveryStore.filePath), 100);
    await reloaded.load();
    await reloaded.upsert({ ...secondPane, id: "iterm:after-restart" });
    expect(reloaded.requireSession("iterm:after-restart").tags).toEqual(["量化", "AI"]);
    expect(reloaded.requireRecovery(conversationId).tags).toEqual(["量化", "AI"]);
    expect(reloaded.getHandoff(conversationId)).toBeUndefined();

    await registry.updateThreadTags(conversationId, { remove: ["量化", "ai"] });
    expect(registry.requireSession(firstPane.id).tags).toBeUndefined();
    expect(registry.requireRecovery(conversationId).tags).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: "recovery-upsert" });
    expect(events.at(-1)).not.toHaveProperty("recovery.tags");
  });

  it("publishes handoff updates and removal while keeping normal close separate from pending work", async () => {
    const registry = await makeRegistry();
    const events: SessionAtlasEvent[] = [];
    registry.subscribe((event) => events.push(event));
    const terminal = {
      sessionId: "terminal-one",
      name: "Code (codex)",
      cwd: "/tmp/demo",
      jobName: "codex",
      focused: false,
      buried: false,
      observedAt: new Date().toISOString(),
    };
    const conversationId = "01234567-89ab-cdef-8123-456789abcdef";
    await registry.observeRecoveries([terminal], [{ status: "linked", conversationId }]);
    await registry.observeRecoveries([], []);
    expect(registry.getHandoff(conversationId)).toBeUndefined();

    const updated = await registry.upsertHandoff(conversationId, {
      expectedVersion: null,
      cwd: terminal.cwd,
      summary: "等待补充要求",
      source: "thread",
      items: [{ id: "details", title: "补充验收要求", kind: "input", nextAction: "收到要求后继续验证", status: "pending" }],
    });
    expect(registry.getHandoff(conversationId)).toEqual(updated.handoff);
    expect(registry.snapshot().recoveries[0]?.handoff).toEqual(updated.handoff);
    expect(events.at(-1)).toMatchObject({ type: "recovery-upsert", recovery: { handoff: updated.handoff } });
    const exposed = registry.getHandoff(conversationId)!;
    exposed.summary = "changed outside registry";
    expect(registry.getHandoff(conversationId)?.summary).toBe("等待补充要求");

    const removed = await registry.removeHandoff(conversationId, updated.handoff!.version!);
    expect(removed.handoff).toBeUndefined();
    expect(registry.requireRecovery(conversationId).cwd).toBe(terminal.cwd);
    expect(events.at(-1)).toMatchObject({ type: "recovery-upsert", recovery: { sessionId: conversationId } });
    const reloaded = new RecoveryStore(registry.recoveryStore.filePath);
    await reloaded.load();
    expect(reloaded.list()[0]?.handoff).toBeUndefined();
    expect(reloaded.list()[0]?.status).toBe("closed");
  });

  it("projects active managed recovery state across reads, mutations and every recovery event", async () => {
    const registry = await makeRegistry();
    const conversationId = "01234567-89ab-cdef-8123-456789abcdef";
    const events: SessionAtlasEvent[] = [];
    registry.subscribe((event) => events.push(event));
    await registry.upsert(managedSession({ conversationId }));
    const saved = await registry.upsertHandoff(conversationId, {
      expectedVersion: null, cwd: "/tmp/demo", source: "thread", summary: "继续观察",
      items: [{ id: "verify", title: "核验结果", kind: "later", nextAction: "检查结果", status: "pending" }],
    });
    expect(saved).toMatchObject({ status: "active", handoff: { summary: "继续观察" } });
    expect(saved.closedAt).toBeUndefined();
    expect(registry.requireRecovery(conversationId)).toEqual(saved);
    expect(registry.snapshot().recoveries).toEqual([saved]);
    expect(events.at(-1)).toMatchObject({ type: "recovery-upsert", recovery: saved });
    expect(registry.recoveryStore.list()[0]?.status).toBe("closed");
    await registry.observeRecoveries([], []);
    const results = [
      ...await registry.markRecoveriesRestoreUncertain([conversationId], "等待核验"),
      await registry.clearRecoveryRestoreState(conversationId),
      await registry.saveRecoveryLocation(conversationId, {
        sessionId: "terminal-one", name: "Code", cwd: "/tmp/demo", focused: false,
        buried: false, observedAt: new Date().toISOString(),
      }),
      await registry.removeHandoff(conversationId, saved.handoff!.version!),
    ];
    for (const recovery of results) {
      expect(recovery.status).toBe("active");
      expect(recovery.closedAt).toBeUndefined();
    }
    for (const event of events) if (event.type === "recovery-upsert") {
      expect(event.recovery.status).toBe("active");
      expect(event.recovery.closedAt).toBeUndefined();
    }
    expect(registry.requireRecovery(conversationId).handoff).toBeUndefined();
  });

  it("publishes managed reopen, stale, removal and conversation changes without altering stored history", async () => {
    const registry = await makeRegistry();
    const firstId = "01234567-89ab-cdef-8123-456789abcdef";
    const secondId = "11234567-89ab-cdef-8123-456789abcdef";
    for (const sessionId of [firstId, secondId]) await registry.upsertHandoff(sessionId, {
      expectedVersion: null, cwd: "/tmp/demo", source: "thread", summary: "保存参考",
      items: [], reference: { title: "参考", reason: "用户要求保留" },
    });
    const stored = registry.recoveryStore.list();
    const events: SessionAtlasEvent[] = [];
    registry.subscribe((event) => events.push(event));
    const assertStatus = (sessionId: string, status: "active" | "closed") => {
      expect(registry.requireRecovery(sessionId).status).toBe(status);
      expect(events.at(-1)).toMatchObject({ type: "recovery-upsert", recovery: { sessionId, status } });
    };
    const managed = managedSession({ id: firstId, conversationId: undefined });
    await registry.upsert(managed);
    assertStatus(firstId, "active");
    await registry.observeRecoveries([], []);
    expect(registry.snapshot().recoveries.find((record) => record.sessionId === firstId)?.status).toBe("active");
    await registry.upsert({ ...managed, stale: true });
    assertStatus(firstId, "closed");
    await registry.upsert(managed);
    assertStatus(firstId, "active");
    await registry.upsert({ ...managed, conversationId: secondId });
    assertStatus(secondId, "active");
    expect(registry.requireRecovery(firstId).status).toBe("closed");
    expect(events.at(-2)).toMatchObject({ type: "recovery-upsert", recovery: { sessionId: firstId, status: "closed" } });
    registry.remove(managed.id);
    assertStatus(secondId, "closed");
    expect(registry.recoveryStore.list()).toEqual(stored);
  });

  it("merges persistent attention without overwriting provider truth", async () => {
    const registry = await makeRegistry();
    const events: string[] = [];
    registry.subscribe((event) => events.push(event.type));
    await registry.upsert(managedSession());
    await registry.updateAttention("managed:one", {
      pinned: true,
      parked: true,
      title: "My focus",
      acknowledge: true,
    });

    expect(registry.requireSession("managed:one")).toMatchObject({
      title: "My focus",
      pinned: true,
      parked: true,
      attentionReason: null,
      provider: "codex",
    });
    expect(events).toEqual(["session-upsert", "session-upsert"]);
  });

  it("updates legacy liveness without publishing false terminal activity", async () => {
    const registry = await makeRegistry();
    const events: string[] = [];
    registry.subscribe((event) => events.push(event.type));
    const firstObservedAt = "2026-08-30T12:00:00.000Z";
    const secondObservedAt = "2026-08-30T12:00:02.000Z";
    const base = managedSession({
      id: "iterm:one",
      provider: "terminal",
      surface: "legacy",
      terminalSessionId: "one",
      attentionReason: null,
      lastActivityAt: firstObservedAt,
      observedAt: firstObservedAt,
      activities: [{ id: "terminal:one:first", at: firstObservedAt, label: "Shell ready (zsh)" }],
    });

    await registry.upsert(base);
    await registry.upsert({
      ...base,
      lastActivityAt: secondObservedAt,
      observedAt: secondObservedAt,
      activities: [{ id: "terminal:one:second", at: secondObservedAt, label: "Shell ready (zsh)" }],
    });

    expect(events).toEqual(["session-upsert"]);
    expect(registry.requireSession("iterm:one")).toMatchObject({
      lastActivityAt: firstObservedAt,
      observedAt: secondObservedAt,
      activities: [{ id: "terminal:one:first" }],
    });
  });

  it("marks legacy inventory stale when its bridge is offline", async () => {
    const registry = await makeRegistry();
    await registry.upsert(
      managedSession({
        id: "iterm:one",
        provider: "terminal",
        surface: "legacy",
        terminalSessionId: "one",
        attentionReason: null,
      }),
    );
    registry.setItermHealth("offline");
    expect(registry.requireSession("iterm:one").stale).toBe(true);
  });

  it("clears a stale provider message once both providers are online", async () => {
    const registry = await makeRegistry();

    registry.setCodexHealth({
      controller: "degraded",
      codex: "online",
      iterm: "offline",
    });
    registry.setItermHealth("offline", "Waiting for the iTerm2 bridge");
    registry.setItermHealth("online");

    expect(registry.snapshot().health).toMatchObject({
      controller: "online",
      codex: "online",
      iterm: "online",
      message: undefined,
    });
  });

  it("degrades overall health while Codex terminals are not recoverable", async () => {
    const registry = await makeRegistry();
    registry.setCodexHealth({ controller: "online", codex: "online", iterm: "offline" });
    registry.setItermHealth("online");

    registry.setRecoveryHealth(2, 1);
    expect(registry.snapshot().health).toMatchObject({
      controller: "degraded",
      recovery: "degraded",
      unprotectedCodexSessions: 2,
      message: "Recovery capture failed for 1 Codex session.",
    });

    registry.setRecoveryHealth(0, 0);
    expect(registry.snapshot().health).toMatchObject({
      controller: "online",
      recovery: "online",
      unprotectedCodexSessions: 0,
      message: undefined,
    });
  });

  it("reports the provider that is still offline after the other one recovers", async () => {
    const registry = await makeRegistry();

    registry.setCodexHealth({
      controller: "degraded",
      codex: "offline",
      iterm: "offline",
      message: "Codex unavailable",
    });
    registry.setItermHealth("offline", "iTerm unavailable");
    registry.setItermHealth("online");
    expect(registry.snapshot().health.message).toBe("Codex unavailable");

    registry.setCodexHealth({
      controller: "online",
      codex: "online",
      iterm: "online",
    });
    registry.setItermHealth("offline", "iTerm disconnected");
    registry.setCodexHealth({
      controller: "degraded",
      codex: "online",
      iterm: "offline",
    });
    expect(registry.snapshot().health.message).toBe("iTerm disconnected");
  });

  it("removes only sessions selected by replacement", async () => {
    const registry = await makeRegistry();
    await registry.upsert(managedSession());
    await registry.upsert(
      managedSession({
        id: "iterm:one",
        provider: "terminal",
        surface: "legacy",
        terminalSessionId: "one",
      }),
    );
    await registry.replaceWhere((session) => session.surface === "legacy", []);

    expect(registry.getSession("iterm:one")).toBeUndefined();
    expect(registry.getSession("managed:one")).toBeDefined();
  });

  it("publishes durable recovery changes in snapshots and events", async () => {
    const registry = await makeRegistry();
    const eventTypes: string[] = [];
    registry.subscribe((event) => eventTypes.push(event.type));
    const terminal = {
      sessionId: "terminal-one",
      name: "Code (codex)",
      cwd: "/tmp/demo",
      tty: "/dev/ttys001",
      jobName: "codex",
      jobPid: 42,
      commandLine: "codex",
      focused: false,
      buried: false,
      observedAt: "2026-08-27T12:00:00.000Z",
    };
    const conversationId = "01234567-89ab-cdef-8123-456789abcdef";

    await registry.observeRecoveries(
      [terminal],
      [{ status: "linked", conversationId }],
    );
    await registry.observeRecoveries([], []);

    expect(eventTypes).toEqual(["recovery-upsert", "recovery-upsert"]);
    expect(registry.snapshot().recoveries).toEqual([
      expect.objectContaining({
        sessionId: conversationId,
        status: "closed",
        resumeCommand: expect.stringContaining(`'${conversationId}'`),
      }),
    ]);
  });
});
