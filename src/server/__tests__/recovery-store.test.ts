import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { BookmarkTitleMarker, UpsertHandoffInput } from "../../shared/types.js";
import type { LegacyCodexMatch } from "../legacy-codex-observer.js";
import type { ItermSessionSnapshot } from "../provider-ports.js";
import { buildResumeCommand, RecoveryStore, type RecoveryStoreOptions } from "../recovery-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

async function makeStore(options: RecoveryStoreOptions = {}): Promise<{ directory: string; store: RecoveryStore }> {
  const directory = await mkdtemp(join(tmpdir(), "session-atlas-recovery-"));
  temporaryDirectories.push(directory);
  const store = new RecoveryStore(join(directory, "private", "recovery.json"), options);
  await store.load();
  return { directory, store };
}

function terminal(
  overrides: Partial<ItermSessionSnapshot> = {},
): ItermSessionSnapshot {
  return {
    sessionId: "terminal-one",
    name: "Code (codex)",
    cwd: "/Users/example/Code/session-atlas",
    tty: "/dev/ttys001",
    jobName: "codex",
    jobPid: 42,
    commandLine: "/opt/homebrew/bin/codex",
    focused: true,
    buried: false,
    observedAt: "2026-08-27T12:00:00.000Z",
    ...overrides,
  };
}

const linked: LegacyCodexMatch = {
  status: "linked",
  conversationId: "01234567-89ab-cdef-8123-456789abcdef",
};

function handoff(overrides: Partial<UpsertHandoffInput> = {}): UpsertHandoffInput {
  return {
    expectedVersion: null,
    cwd: terminal().cwd,
    summary: "等待约定的后续核验",
    source: "thread",
    sourceTurnId: "turn-one",
    items: [{
      id: "verify",
      title: "检查上线运行结果",
      kind: "time",
      nextAction: "核对上线后一天的记录",
      status: "pending",
      anchorLabel: "上线",
      anchorAt: "2026-09-09T18:00:00+08:00",
      delayHours: 24,
    }],
    ...overrides,
  };
}

const version = (store: RecoveryStore) => store.getHandoff(linked.conversationId!)?.version ?? store.getHandoff(linked.conversationId!)?.updatedAt ?? null;

describe("RecoveryStore", () => {
  it("preserves a reference when tasks finish and clears only the reference when explicitly requested", async () => {
    const { store } = await makeStore();
    const reference = { title: "发布核验方法", reason: "以后处理类似发布问题时可复用" };
    await store.upsertHandoff(linked.conversationId!, handoff({ reference }), terminal({ windowId: "window-one", profileName: "Work" }));
    await store.observe([], []);
    const reloaded = new RecoveryStore(store.filePath);
    await reloaded.load();
    const finished = await reloaded.upsertHandoff(linked.conversationId!, handoff({ expectedVersion: version(reloaded), items: handoff().items.map((item) => ({ ...item, status: "done" })) }));
    expect(finished.handoff).toMatchObject({ reference, items: [{ status: "done" }] });
    const afterCompletion = new RecoveryStore(store.filePath);
    await afterCompletion.load();
    expect(afterCompletion.getHandoff(linked.conversationId!)?.reference).toEqual(reference);

    const cleared = await afterCompletion.upsertHandoff(linked.conversationId!, handoff({ expectedVersion: version(afterCompletion), reference: null }));
    expect(cleared.handoff?.items[0]?.status).toBe("pending");
    expect(cleared.handoff).not.toHaveProperty("reference");
    expect(cleared.savedLocation).toEqual(finished.savedLocation);
    const afterRemoval = new RecoveryStore(store.filePath);
    await afterRemoval.load();
    expect(afterRemoval.getHandoff(linked.conversationId!)).toEqual(cleared.handoff);
    const persisted = JSON.parse(await readFile(store.filePath, "utf8"));
    expect(persisted.recoveries[linked.conversationId!].handoff).not.toHaveProperty("reference");
  });

  it("atomically rejects queued stale writes and deletion while preserving new items, process needs and references", async () => {
    const { store } = await makeStore();
    await store.upsertHandoff(linked.conversationId!, handoff({ items: [], reference: { title: "旧解法", reason: "初步参考" } }));
    const expectedVersion = version(store);
    const reference = { title: "验证后的解法", reason: "保留完整验证结论供以后参考" };
    const items = [...handoff().items, { ...handoff().items[0]!, id: "new-item" }];
    const results = await Promise.allSettled([
      store.upsertHandoff(linked.conversationId!, handoff({ expectedVersion, items, requiresRunningProcess: true, reference })),
      store.upsertHandoff(linked.conversationId!, handoff({ expectedVersion, summary: "过期草稿" })),
      store.removeHandoff(linked.conversationId!, expectedVersion),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected", "rejected"]);
    for (const result of results.slice(1)) expect(result).toMatchObject({ reason: { code: "HANDOFF_CONFLICT" } });
    const reloaded = new RecoveryStore(store.filePath);
    await reloaded.load();
    expect(reloaded.getHandoff(linked.conversationId!)).toMatchObject({
      reference, summary: handoff().summary, requiresRunningProcess: true, items: [{ id: "verify" }, { id: "new-item" }],
    });
  });

  it("uses unique versions within one millisecond and rejects pre-deletion versions after recreation", async () => {
    const fixture = await makeStore(), now = new Date("2026-09-09T12:00:00.000Z");
    const store = new RecoveryStore(fixture.store.filePath, { now: () => now });
    await store.load();
    const first = await store.upsertHandoff(linked.conversationId!, handoff());
    const second = await store.upsertHandoff(linked.conversationId!, handoff({ expectedVersion: first.handoff!.version! }));
    expect(first.handoff!.updatedAt).toBe(second.handoff!.updatedAt);
    expect(first.handoff!.version).not.toBe(second.handoff!.version);
    await store.removeHandoff(linked.conversationId!, second.handoff!.version!);
    const recreated = await store.upsertHandoff(linked.conversationId!, handoff());
    expect(new Set([first, second, recreated].map((record) => record.handoff!.version)).size).toBe(3);
    await expect(store.upsertHandoff(linked.conversationId!, handoff({ expectedVersion: second.handoff!.version! }))).rejects.toMatchObject({ code: "HANDOFF_CONFLICT" });
    await expect(store.removeHandoff(linked.conversationId!, second.handoff!.version!)).rejects.toMatchObject({ code: "HANDOFF_CONFLICT" });
    const reloaded = new RecoveryStore(store.filePath); await reloaded.load();
    expect(reloaded.getHandoff(linked.conversationId!)).toEqual(recreated.handoff);
  });

  it("retains reference-only cards past age and count limits, then resumes ordinary retention after removal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "session-atlas-reference-retention-"));
    temporaryDirectories.push(directory);
    let now = new Date("2026-09-09T12:00:00.000Z");
    const options = { now: () => now, maxClosedRecoveries: 1 };
    const store = new RecoveryStore(join(directory, "recovery.json"), options);
    await store.load();
    const reference = { title: "排查方法", reason: "问题复发时参考" };
    await store.upsertHandoff(linked.conversationId!, handoff({ summary: reference.title, items: [], reference }), terminal({ windowId: "window-one", profileName: "Work" }));
    await store.observe([], []);
    now = new Date("2026-11-09T12:00:00.000Z");
    const recentReferenceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await store.upsertHandoff(recentReferenceId, handoff({ summary: reference.title, items: [], reference }));
    const ordinaryId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await store.observe([terminal({ observedAt: now.toISOString() })], [{ status: "linked", conversationId: ordinaryId }]);
    await store.observe([], []);

    const reloaded = new RecoveryStore(store.filePath, options);
    await reloaded.load();
    expect(reloaded.list().map((record) => record.sessionId).sort()).toEqual([linked.conversationId!, recentReferenceId, ordinaryId].sort());
    expect(reloaded.list().find((record) => record.sessionId === linked.conversationId)).toMatchObject({
      status: "closed", handoff: { items: [], reference }, savedLocation: { windowId: "window-one", profileName: "Work" },
    });

    await reloaded.upsertHandoff(linked.conversationId!, handoff({ expectedVersion: version(reloaded), summary: reference.title, items: [], reference: null }));
    const afterRemoval = new RecoveryStore(store.filePath, options);
    await afterRemoval.load();
    expect(afterRemoval.list().map((record) => record.sessionId).sort()).toEqual([recentReferenceId, ordinaryId].sort());
    expect(afterRemoval.loadWarning).toBeUndefined();
  });

  it("loads the existing handoff format without adding a reference or quarantining old records", async () => {
    const { store } = await makeStore();
    const { cwd, expectedVersion: _version, ...content } = handoff();
    await writeFile(store.filePath, JSON.stringify({
      version: 2,
      recoveries: {
        [linked.conversationId!]: {
          sessionId: linked.conversationId, cwd, title: "Old handoff", projectName: "session-atlas",
          firstSeenAt: "2026-09-09T12:00:00Z", lastSeenAt: "2026-09-09T12:00:00Z", closedAt: "2026-09-09T12:00:00Z",
          handoff: { ...content, updatedAt: "2026-09-09T12:00:00Z" },
        },
      },
      layouts: {},
    }));
    const reloaded = new RecoveryStore(store.filePath);
    await reloaded.load();
    expect(reloaded.loadWarning).toBeUndefined();
    expect(reloaded.getHandoff(linked.conversationId!)).toMatchObject({ summary: content.summary, items: [{ status: "pending" }] });
    expect(reloaded.getHandoff(linked.conversationId!)).not.toHaveProperty("reference");
    expect(await readdir(join(store.filePath, ".."))).not.toEqual(expect.arrayContaining([expect.stringContaining("corrupt")]));
    const expectedVersion = reloaded.getHandoff(linked.conversationId!)!.updatedAt;
    expect(reloaded.getHandoff(linked.conversationId!)).not.toHaveProperty("version");
    const updated = await reloaded.upsertHandoff(linked.conversationId!, handoff({ expectedVersion }));
    expect(updated.handoff!.version).toEqual(expect.any(String));
    await expect(reloaded.upsertHandoff(linked.conversationId!, handoff({ expectedVersion }))).rejects.toMatchObject({ code: "HANDOFF_CONFLICT" });
  });

  it("preserves handoff content and the latest recoverable location across observation and reload", async () => {
    const { store } = await makeStore();
    const first = terminal({ windowId: "window-one", tabId: "tab-one", windowIndex: 1, tabIndex: 2, paneIndex: 1, profileName: "Work", splitPath: [{ vertical: true, index: 0 }] });
    await store.observe([first], [linked]);
    await store.upsertHandoff(linked.conversationId!, handoff(), first);
    const moved = terminal({ ...first, tabId: "tab-two", tabIndex: 3, splitPath: [{ vertical: false, index: 1 }], observedAt: "2026-08-27T12:01:00.000Z" });
    await store.observe([moved], [linked]);
    const buried = terminal({ sessionId: first.sessionId, buried: true, observedAt: "2026-08-27T12:02:00.000Z" });
    await store.observe([buried], [linked]);
    await store.observe([], []);

    const reloaded = new RecoveryStore(store.filePath);
    await reloaded.load();
    expect(reloaded.list()[0]).toMatchObject({
      status: "closed",
      handoff: {
        summary: handoff().summary,
        source: "thread",
        sourceTurnId: "turn-one",
        items: [{ id: "verify", dueAt: "2026-09-10T10:00:00.000Z" }],
      },
      savedLocation: { windowId: "window-one", tabId: "tab-two", tabIndex: 3, profileName: "Work", splitPath: [{ vertical: false, index: 1 }] },
    });
    const state = await readFile(store.filePath, "utf8");
    expect(state).not.toContain("commandLine");
    expect(state).not.toContain("jobPid");
    expect(state).not.toContain("resumeCommand");
  });

  it("creates a closed exact-id recovery when a handoff has no live terminal mapping", async () => {
    const { store } = await makeStore();
    const saved = await store.upsertHandoff(linked.conversationId!, handoff());
    expect(saved).toMatchObject({ sessionId: linked.conversationId, cwd: handoff().cwd, status: "closed" });
    expect(saved.terminalSessionId).toBeUndefined();
    expect(saved.savedLocation).toBeUndefined();
    expect(saved.resumeCommand).toContain(linked.conversationId!);
  });

  it("keeps the verified card directory while observing shell directories and updated terminal locations", async () => {
    const { store } = await makeStore();
    const verifiedCwd = "/Users/example/Code/resumed-project";
    const first = terminal({ windowId: "window-one", tabId: "tab-one", profileName: "Work" });
    const saved = await store.upsertHandoff(linked.conversationId!, handoff({ cwd: verifiedCwd }), first);
    const moved = terminal({ cwd: "/Users/example/Code", windowId: "window-two", tabId: "tab-two", profileName: "Work", observedAt: "2026-08-27T12:02:00.000Z" });
    await store.observe([moved], [linked]);
    expect(store.list()[0]).toMatchObject({
      cwd: verifiedCwd, projectName: "resumed-project", status: "active", handoff: saved.handoff,
      savedLocation: { windowId: "window-two", tabId: "tab-two", profileName: "Work" },
    });
    await store.observe([], []);
    const reloaded = new RecoveryStore(store.filePath);
    await reloaded.load();
    expect(reloaded.list()[0]).toMatchObject({ cwd: verifiedCwd, projectName: "resumed-project", status: "closed", handoff: saved.handoff });
    expect(reloaded.list()[0]!.resumeCommand).toBe(buildResumeCommand(verifiedCwd, linked.conversationId!));
  });

  it("continues tracking observed directories for ordinary recoveries without a handoff", async () => {
    const { store } = await makeStore();
    await store.observe([terminal()], [linked]);
    await store.observe([terminal({ cwd: "/Users/example/Code/other" })], [linked]);
    expect(store.list()[0]).toMatchObject({ cwd: "/Users/example/Code/other", projectName: "other" });
    expect(store.list()[0]!.handoff).toBeUndefined();
  });

  it("durably reconciles only directory metadata without rewriting the card or its lifecycle", async () => {
    const { store } = await makeStore();
    await store.upsertHandoff(linked.conversationId!, handoff({ reference: { title: "复用结论", reason: "以后参考" } }), terminal({ windowId: "window-one", profileName: "Work" }));
    await store.observe([], []);
    await store.markRecoveriesRestoreUncertain([linked.conversationId!], "等待恢复结果");
    const before = JSON.parse(await readFile(store.filePath, "utf8"));
    const cwd = "/Users/example/Code/resumed-project";
    const updated = await store.updateRecoveryCwd(linked.conversationId!, cwd);
    const after = JSON.parse(await readFile(store.filePath, "utf8"));
    expect(after).toEqual({
      ...before,
      recoveries: { ...before.recoveries, [linked.conversationId!]: { ...before.recoveries[linked.conversationId!], cwd, projectName: "resumed-project" } },
    });
    const reloaded = new RecoveryStore(store.filePath);
    await reloaded.load();
    expect(reloaded.list()[0]).toEqual(updated);
    expect(updated.resumeCommand).toBe(buildResumeCommand(cwd, linked.conversationId!));
  });

  it("preserves bookmark title ownership across reloads and fresh terminal observations", async () => {
    const { store } = await makeStore();
    const originalName = "核查 mobile 日志";
    const marker = { originalName, appliedName: `🔖 ${originalName}` };
    const saved = await store.upsertHandoff(linked.conversationId!, handoff({ reference: { title: "复用结论", reason: "以后参考" } }), terminal());
    const marked = await store.updateBookmarkTitleMarker(linked.conversationId!, marker);
    expect(marked.handoff).toEqual(saved.handoff);
    marker.originalName = "Changed by caller";
    marked.bookmarkTitleMarker!.appliedName = "Changed returned value";

    const reloaded = new RecoveryStore(store.filePath);
    await reloaded.load();
    await reloaded.observe([terminal({ name: `🔖 ${originalName}`, observedAt: "2026-08-27T12:02:00.000Z" })], [linked]);
    await reloaded.observe([], []);
    const afterObservation = new RecoveryStore(store.filePath);
    await afterObservation.load();
    expect(afterObservation.list()[0]).toMatchObject({
      bookmarkTitleMarker: { originalName, appliedName: `🔖 ${originalName}` },
      handoff: saved.handoff,
      status: "closed",
    });
  });

  it("clears only bookmark title ownership while preserving the saved card and recovery metadata", async () => {
    const { store } = await makeStore();
    await store.upsertHandoff(linked.conversationId!, handoff({ reference: { title: "复用结论", reason: "以后参考" } }), terminal({ windowId: "window-one", profileName: "Work" }));
    await store.updateRecoveryCwd(linked.conversationId!, "/Users/example/Code/moved-project", true);
    await store.markRecoveriesRestoreUncertain([linked.conversationId!], "等待恢复结果");
    const before = JSON.parse(await readFile(store.filePath, "utf8"));
    await store.updateBookmarkTitleMarker(linked.conversationId!, { originalName: "Saved thread", appliedName: "🔖 Saved thread" });
    const cleared = await store.updateBookmarkTitleMarker(linked.conversationId!);
    expect(cleared).not.toHaveProperty("bookmarkTitleMarker");
    expect(JSON.parse(await readFile(store.filePath, "utf8"))).toEqual(before);
    const reloaded = new RecoveryStore(store.filePath);
    await reloaded.load();
    expect(reloaded.list()[0]).toEqual(cleared);
  });

  it("retains title ownership awaiting removal after a card is deleted, then permits ordinary retention", async () => {
    let now = new Date("2026-09-09T12:00:00.000Z");
    const options = { now: () => now, retentionMs: 24 * 60 * 60 * 1_000, maxClosedRecoveries: 0 };
    const { store } = await makeStore(options);
    await store.upsertHandoff(linked.conversationId!, handoff());
    await store.updateBookmarkTitleMarker(linked.conversationId!, { originalName: "Saved thread", appliedName: "🔖 Saved thread" });
    await store.removeHandoff(linked.conversationId!, version(store));
    now = new Date("2026-11-09T12:00:00.000Z");
    const reloaded = new RecoveryStore(store.filePath, options);
    await reloaded.load();
    await reloaded.observe([], []);
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.list()[0]).toMatchObject({ status: "closed", bookmarkTitleMarker: { originalName: "Saved thread" } });
    expect(reloaded.list()[0]).not.toHaveProperty("handoff");
    await reloaded.updateBookmarkTitleMarker(linked.conversationId!);
    const pruned = await reloaded.observe([], []);
    expect(pruned.records).toEqual([]);
    expect(pruned.removedSessionIds).toEqual([linked.conversationId!]);
  });

  it.each([
    { originalName: " ", appliedName: "🔖  " },
    { originalName: "x".repeat(257), appliedName: `🔖 ${"x".repeat(257)}` },
    { originalName: "line\nbreak", appliedName: "🔖 line\nbreak" },
    { originalName: "control\u0085", appliedName: "🔖 control\u0085" },
    { originalName: "Thread", appliedName: "Other name" },
    { originalName: "Thread", appliedName: "🔖 Thread", extra: "unexpected metadata" },
  ])("rejects invalid bookmark title ownership without modifying saved state: %j", async (marker) => {
    const { store } = await makeStore();
    await store.upsertHandoff(linked.conversationId!, handoff());
    const before = await readFile(store.filePath, "utf8");
    await expect(store.updateBookmarkTitleMarker(linked.conversationId!, marker as BookmarkTitleMarker))
      .rejects.toMatchObject({ code: "INVALID_BOOKMARK_TITLE_MARKER" });
    expect(await readFile(store.filePath, "utf8")).toBe(before);
    expect(store.list()[0]).not.toHaveProperty("bookmarkTitleMarker");
  });

  it("validates persisted bookmark title ownership before accepting the state file", async () => {
    const { store } = await makeStore();
    await store.upsertHandoff(linked.conversationId!, handoff());
    const originalName = "x".repeat(256);
    await store.updateBookmarkTitleMarker(linked.conversationId!, { originalName, appliedName: `🔖 ${originalName}` });
    const valid = new RecoveryStore(store.filePath);
    await valid.load();
    expect(valid.loadWarning).toBeUndefined();
    expect(valid.list()[0]?.bookmarkTitleMarker?.originalName).toBe(originalName);

    const state = JSON.parse(await readFile(store.filePath, "utf8"));
    state.recoveries[linked.conversationId!].bookmarkTitleMarker.appliedName = "Unrelated name";
    await writeFile(store.filePath, JSON.stringify(state));
    const invalid = new RecoveryStore(store.filePath);
    await invalid.load();
    expect(invalid.loadWarning).toContain("Invalid recovery state was preserved");
    expect(invalid.list()).toEqual([]);
  });

  it("retains pending handoffs beyond age and count limits without consuming ordinary history slots", async () => {
    const directory = await mkdtemp(join(tmpdir(), "session-atlas-handoff-retention-"));
    temporaryDirectories.push(directory);
    let now = new Date("2026-09-09T12:00:00.000Z");
    const options = { now: () => now, retentionMs: 24 * 60 * 60 * 1_000, maxClosedRecoveries: 1 };
    const store = new RecoveryStore(join(directory, "recovery.json"), options);
    await store.load();
    const saved = await store.upsertHandoff(linked.conversationId!, handoff(), terminal({ windowId: "window-one", profileName: "Work" }));
    await store.observe([], []);
    now = new Date("2026-11-09T12:00:00.000Z");
    const ordinaryId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await store.observe([terminal({ observedAt: now.toISOString() })], [{ status: "linked", conversationId: ordinaryId }]);
    await store.observe([], []);
    expect(store.list().map((record) => record.sessionId)).toEqual(expect.arrayContaining([ordinaryId, linked.conversationId]));

    const reloaded = new RecoveryStore(store.filePath, options);
    await reloaded.load();
    expect(reloaded.list()).toHaveLength(2);
    expect(reloaded.getHandoff(linked.conversationId!)).toEqual(saved.handoff);
    expect(reloaded.list().find((record) => record.sessionId === linked.conversationId)?.savedLocation).toMatchObject({ windowId: "window-one", profileName: "Work" });

    await reloaded.upsertHandoff(linked.conversationId!, handoff({ expectedVersion: version(reloaded), items: handoff().items.map((item) => ({ ...item, status: "done" })) }));
    const pruned = await reloaded.observe([], []);
    expect(pruned.removedSessionIds).toEqual([linked.conversationId]);
    expect(reloaded.list().map((record) => record.sessionId)).toEqual([ordinaryId]);
  });

  it("removes only the handoff and captures close-time location without copying runtime details", async () => {
    const { store } = await makeStore();
    await store.upsertHandoff(linked.conversationId!, handoff(), terminal());
    const located = await store.saveRecoveryLocation(linked.conversationId!, terminal({ windowId: "window-final", tabId: "tab-final", profileName: "Focused", commandLine: "must not persist" }));
    const removed = await store.removeHandoff(linked.conversationId!, located.handoff!.version!);
    const { handoff: _handoff, ...recovery } = located;
    expect(removed).toEqual(recovery);
    expect(store.getHandoff(linked.conversationId!)).toBeUndefined();
    expect(await readFile(store.filePath, "utf8")).not.toContain("must not persist");
  });

  it("clears a definite rejected restore without removing the handoff or saved location", async () => {
    const { store } = await makeStore();
    const original = await store.upsertHandoff(linked.conversationId!, handoff(), terminal({ windowId: "window-one" }));
    await store.markRecoveriesRestoreUncertain([linked.conversationId!], "Restore dispatched.", "created-window");
    const cleared = await store.clearRecoveryRestoreState(linked.conversationId!);
    expect(cleared).toEqual(original);
    const reloaded = new RecoveryStore(store.filePath);
    await reloaded.load();
    expect(reloaded.list()[0]).toEqual(original);
  });

  it("clears a restore marker only after the exact thread is observed again", async () => {
    const { store } = await makeStore();
    await store.upsertHandoff(linked.conversationId!, handoff());
    await store.markRecoveriesRestoreUncertain([linked.conversationId!], "Restore dispatched.");
    await store.observe([terminal()], [{ status: "ambiguous" }]);
    expect(store.list()[0]?.restoreStatus).toBe("partial");
    await store.observe([terminal()], [linked]);
    expect(store.list()[0]?.restoreStatus).toBeUndefined();
    expect(store.list()[0]?.handoff).toBeDefined();
  });

  it("persists an active mapping before close, then marks it closed", async () => {
    const { directory, store } = await makeStore();

    const active = await store.observe([terminal()], [linked]);
    expect(active.changed).toHaveLength(1);
    expect(active.records[0]).toMatchObject({
      sessionId: linked.conversationId,
      cwd: "/Users/example/Code/session-atlas",
      terminalSessionId: "terminal-one",
      status: "active",
    });
    expect(active.records[0]?.closedAt).toBeUndefined();

    const statePath = join(directory, "private", "recovery.json");
    expect((await stat(join(directory, "private"))).mode & 0o777).toBe(0o700);
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
      version: 2,
      recoveries: {
        [linked.conversationId!]: { sessionId: linked.conversationId },
      },
    });

    const closed = await store.observe([], []);
    expect(closed.records[0]).toMatchObject({
      status: "closed",
      closedAt: expect.any(String),
    });

    const reloaded = new RecoveryStore(statePath);
    await reloaded.load();
    expect(reloaded.list()[0]).toMatchObject({
      sessionId: linked.conversationId,
      status: "closed",
    });
  });

  it("does not close a record while the same terminal still runs an unresolved Codex", async () => {
    const { store } = await makeStore();
    await store.observe([terminal()], [linked]);

    const unresolved = await store.observe(
      [terminal({ observedAt: "2026-08-27T12:01:00.000Z" })],
      [{ status: "ambiguous" }],
    );

    expect(unresolved.records[0]?.status).toBe("active");
    expect(unresolved.changed).toEqual([]);
  });

  it("does not copy a stale Codex id into a layout with an ambiguous match", async () => {
    const { store } = await makeStore();
    const visible = terminal({
      windowId: "window-one",
      tabId: "tab-one",
      windowIndex: 1,
      tabIndex: 1,
      paneIndex: 1,
      splitPath: [{ vertical: true, index: 0 }],
    });
    await store.observe([visible], [linked]);

    const unresolved = await store.observe(
      [terminal({ ...visible, observedAt: "2026-08-27T12:01:00.000Z" })],
      [{ status: "ambiguous" }],
    );
    expect(unresolved.layouts[0]?.tabs[0]?.panes[0]).not.toHaveProperty("conversationId");
    expect(unresolved.layouts[0]?.tabs[0]?.panes[0]).not.toHaveProperty("resumeCommand");

    const closed = await store.observe([], []);
    expect(closed.layouts[0]).toMatchObject({ status: "closed" });
    expect(closed.layouts[0]?.tabs[0]?.panes[0]).not.toHaveProperty("conversationId");
  });

  it("does not close a layout while one of its sessions is buried but still alive", async () => {
    const { store } = await makeStore();
    const visible = terminal({
      windowId: "window-one",
      tabId: "tab-one",
      windowIndex: 1,
      tabIndex: 1,
      paneIndex: 1,
      splitPath: [{ vertical: true, index: 0 }],
    });
    await store.observe([visible], [linked]);

    const buried = await store.observe(
      [
        terminal({
          buried: true,
          windowId: undefined,
          tabId: undefined,
          observedAt: "2026-08-27T12:01:00.000Z",
        }),
      ],
      [{ status: "ambiguous" }],
    );

    expect(buried.layouts[0]).toMatchObject({ windowId: "window-one", status: "active" });
    expect(buried.layouts[0]?.closedAt).toBeUndefined();
  });

  it("does not rewrite an unchanged linked recovery on every bridge snapshot", async () => {
    const { store } = await makeStore();
    await store.observe([terminal()], [linked]);

    const unchanged = await store.observe(
      [terminal({ observedAt: "2026-08-27T12:00:02.000Z" })],
      [linked],
    );

    expect(unchanged.changed).toEqual([]);
    expect(unchanged.records[0]?.lastSeenAt).toBe("2026-08-27T12:00:00.000Z");
  });

  it("ignores transient Codex spinner prefixes in recovery titles", async () => {
    const { store } = await makeStore();
    await store.observe([terminal({ name: "⠋ Code (codex)" })], [linked]);

    const unchanged = await store.observe(
      [terminal({ name: "⠙ Code (codex)", observedAt: "2026-08-27T12:00:02.000Z" })],
      [linked],
    );

    expect(unchanged.changed).toEqual([]);
    expect(unchanged.records[0]?.title).toBe("Code (codex)");
  });

  it("persists window, tab, pane, cwd, profile, and Codex resume metadata", async () => {
    const { store } = await makeStore();
    const shell = terminal({
      sessionId: "terminal-shell",
      name: "Shell",
      jobName: "zsh",
      commandLine: "-zsh",
      windowId: "window-one",
      tabId: "tab-one",
      windowIndex: 1,
      tabIndex: 1,
      paneIndex: 2,
      profileName: "Work",
      splitPath: [
        { vertical: true, index: 1 },
        { vertical: false, index: 0 },
      ],
    });
    const codex = terminal({
      windowId: "window-one",
      tabId: "tab-one",
      windowIndex: 1,
      tabIndex: 1,
      paneIndex: 1,
      profileName: "Work",
      splitPath: [{ vertical: true, index: 0 }],
    });

    const observed = await store.observe([codex, shell], [linked, { status: "unlinked" }]);

    expect(observed.changedLayouts).toHaveLength(1);
    expect(observed.layouts[0]).toMatchObject({
      windowId: "window-one",
      status: "active",
      tabs: [
        {
          tabId: "tab-one",
          panes: [
            {
              sessionId: "terminal-one",
              conversationId: linked.conversationId,
              resumeCommand: expect.stringContaining(linked.conversationId!),
              profileName: "Work",
            },
            { sessionId: "terminal-shell", cwd: "/Users/example/Code/session-atlas" },
          ],
        },
      ],
    });
    for (const pane of observed.layouts[0]!.tabs[0]!.panes) {
      expect(pane).not.toHaveProperty("jobName");
    }

    const closed = await store.observe([], []);
    expect(closed.layouts[0]).toMatchObject({ windowId: "window-one", status: "closed" });
  });

  it("persists an uncertain partial restore and reloads it as blocked history", async () => {
    const { directory, store } = await makeStore();
    await store.observe(
      [
        terminal({
          windowId: "window-one",
          tabId: "tab-one",
          windowIndex: 1,
          tabIndex: 1,
          paneIndex: 1,
          splitPath: [{ vertical: true, index: 0 }],
        }),
      ],
      [linked],
    );
    await store.observe([], []);

    const uncertain = await store.markLayoutRestoreUncertain(
      "window-one",
      "Inspect the partial window before retrying.",
      "created-window",
    );
    expect(uncertain).toMatchObject({
      status: "closed",
      restoreStatus: "partial",
      restoreAttemptedAt: expect.any(String),
      createdWindowId: "created-window",
    });

    const reloaded = new RecoveryStore(join(directory, "private", "recovery.json"));
    await reloaded.load();
    expect(reloaded.listLayouts()[0]).toMatchObject({
      restoreStatus: "partial",
      restoreMessage: "Inspect the partial window before retrying.",
      createdWindowId: "created-window",
    });
  });

  it("persists an uncertain batch recovery on each selected Codex record", async () => {
    const { directory, store } = await makeStore();
    await store.observe([terminal()], [linked]);
    await store.observe([], []);

    const [uncertain] = await store.markRecoveriesRestoreUncertain(
      [linked.conversationId!],
      "Inspect the partial recovery window before retrying.",
      "created-window",
    );
    expect(uncertain).toMatchObject({
      status: "closed",
      restoreStatus: "partial",
      restoreAttemptedAt: expect.any(String),
      restoreMessage: "Inspect the partial recovery window before retrying.",
      createdWindowId: "created-window",
    });

    const reloaded = new RecoveryStore(join(directory, "private", "recovery.json"));
    await reloaded.load();
    expect(reloaded.list()[0]).toMatchObject({
      restoreStatus: "partial",
      createdWindowId: "created-window",
    });
  });

  it("closes a replaced conversation and reopens a resumed one", async () => {
    const { store } = await makeStore({ now: () => new Date("2026-08-27T12:05:00.000Z") });
    await store.observe([terminal()], [linked]);
    const replacement: LegacyCodexMatch = {
      status: "linked",
      conversationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    };

    const replaced = await store.observe(
      [terminal({ observedAt: "2026-08-27T12:02:00.000Z" })],
      [replacement],
    );
    expect(replaced.records.find((item) => item.sessionId === linked.conversationId)?.status).toBe(
      "closed",
    );
    expect(
      replaced.records.find((item) => item.sessionId === replacement.conversationId)?.status,
    ).toBe("active");

    const reopened = await store.observe(
      [
        terminal({
          sessionId: "terminal-two",
          observedAt: "2026-08-27T12:03:00.000Z",
        }),
      ],
      [linked],
    );
    expect(reopened.records.find((item) => item.sessionId === linked.conversationId)).toMatchObject({
      status: "active",
      terminalSessionId: "terminal-two",
      firstSeenAt: "2026-08-27T12:00:00.000Z",
      lastSeenAt: "2026-08-27T12:03:00.000Z",
    });
  });

  it("quotes cwd and session id as valid zsh input", () => {
    const command = buildResumeCommand("/tmp/Pei's work", "session id");
    expect(command).toBe("codex resume -C '/tmp/Pei'\\''s work' 'session id'");
    expect(() => execFileSync("zsh", ["-n", "-c", command])).not.toThrow();
  });

  it("quarantines a malformed state file and continues empty", async () => {
    const directory = await mkdtemp(join(tmpdir(), "session-atlas-recovery-invalid-"));
    temporaryDirectories.push(directory);
    const statePath = join(directory, "recovery.json");
    await writeFile(statePath, '{"version":1,"recoveries":[]}\n');
    const store = new RecoveryStore(statePath);
    await expect(store.load()).resolves.toBeUndefined();
    expect(store.loadWarning).toContain("Invalid recovery state was preserved");
    expect(store.list()).toEqual([]);
    const quarantined = (await readdir(directory)).find((name) =>
      name.startsWith("recovery.json.corrupt-"),
    );
    expect(quarantined).toBeDefined();
    expect(await readFile(join(directory, quarantined!), "utf8")).toBe(
      '{"version":1,"recoveries":[]}\n',
    );
  });

  it("loads the existing version 1 recovery file with an empty layout history", async () => {
    const directory = await mkdtemp(join(tmpdir(), "session-atlas-recovery-v1-"));
    temporaryDirectories.push(directory);
    const statePath = join(directory, "recovery.json");
    await writeFile(
      statePath,
      `${JSON.stringify({
        version: 1,
        recoveries: {
          [linked.conversationId!]: {
            sessionId: linked.conversationId,
            cwd: "/tmp/project",
            title: "Project",
            projectName: "project",
            firstSeenAt: "2026-08-27T12:00:00.000Z",
            lastSeenAt: "2026-08-27T12:00:00.000Z",
          },
        },
      })}\n`,
    );
    const store = new RecoveryStore(statePath);

    await store.load();

    expect(store.list()).toHaveLength(1);
    expect(store.listLayouts()).toEqual([]);
    expect(store.loadWarning).toBeUndefined();
  });

  it("prunes only closed recoveries outside the configured history window", async () => {
    const directory = await mkdtemp(join(tmpdir(), "session-atlas-recovery-retention-"));
    temporaryDirectories.push(directory);
    let now = new Date("2026-08-27T12:05:00.000Z");
    const store = new RecoveryStore(join(directory, "recovery.json"), {
      retentionMs: 24 * 60 * 60 * 1_000,
      now: () => now,
    });
    await store.load();
    await store.observe([terminal()], [linked]);
    await store.observe([], []);
    now = new Date("2026-08-30T12:00:00.000Z");

    const pruned = await store.observe([], []);

    expect(pruned.records).toEqual([]);
    expect(pruned.removedSessionIds).toEqual([linked.conversationId]);
  });

  it("prunes expired closed history during load without waiting for an iTerm snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "session-atlas-recovery-load-retention-"));
    temporaryDirectories.push(directory);
    const statePath = join(directory, "recovery.json");
    const activeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await writeFile(
      statePath,
      `${JSON.stringify({
        version: 2,
        recoveries: {
          [linked.conversationId!]: {
            sessionId: linked.conversationId,
            cwd: "/tmp/old",
            title: "Old",
            projectName: "old",
            firstSeenAt: "2026-08-20T12:00:00.000Z",
            lastSeenAt: "2026-08-20T12:00:00.000Z",
            closedAt: "2026-08-20T12:01:00.000Z",
          },
          [activeId]: {
            sessionId: activeId,
            cwd: "/tmp/active",
            title: "Active",
            projectName: "active",
            firstSeenAt: "2026-08-30T11:00:00.000Z",
            lastSeenAt: "2026-08-30T11:00:00.000Z",
          },
        },
        layouts: {},
      })}\n`,
    );
    const store = new RecoveryStore(statePath, {
      retentionMs: 24 * 60 * 60 * 1_000,
      now: () => new Date("2026-08-30T12:00:00.000Z"),
    });

    await store.load();

    expect(store.list().map((record) => record.sessionId)).toEqual([activeId]);
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
      recoveries: Record<string, unknown>;
    };
    expect(persisted.recoveries).not.toHaveProperty(linked.conversationId!);
    expect(persisted.recoveries).toHaveProperty(activeId);
  });
});
