import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { UpsertHandoffInput } from "../../shared/types.js";
import { AttentionStore } from "../attention-store.js";
import type { ItermSessionSnapshot } from "../provider-ports.js";
import { RecoveryStore } from "../recovery-store.js";
import { SessionRegistry } from "../session-registry.js";

const temporaryDirectories: string[] = [];
const START = "2026-09-10T08:00:00.000Z";
const DAY = 24 * 60 * 60 * 1_000;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

function sessionId(index: number): string {
  return `aaaaaaaa-aaaa-4aaa-8aaa-${index.toString(16).padStart(12, "0")}`;
}

function handoff(index: number, revision = 0): UpsertHandoffInput {
  return {
    expectedVersion: null,
    cwd: `/tmp/session-atlas-load/project-${index % 8}`,
    summary: `线程 ${index} 的登记版本 ${revision}：完成已约定的核验和后续要求`,
    source: "thread",
    sourceTurnId: `turn-${index}-${revision}`,
    items: [
      { id: "time", kind: "time", title: `线程 ${index} 上线核验`, nextAction: `版本 ${revision}：核对约定的运行记录`, status: "pending", anchorLabel: "上线完成", anchorAt: START, delayHours: 24 },
      { id: "condition", kind: "condition", title: "等待新数据", nextAction: `版本 ${revision}：读取已到达的数据`, status: "pending", condition: "约定的新数据已经到达" },
      { id: "input", kind: "input", title: "等待用户补充要求", nextAction: `版本 ${revision}：按确认的要求继续`, status: "pending", condition: "收到最终验收要求" },
      { id: "later", kind: "later", title: "稍后继续检查", nextAction: `版本 ${revision}：继续剩余的检查`, status: "pending" },
    ],
  };
}

function terminal(index: number, round = 0): ItermSessionSnapshot {
  return {
    sessionId: `terminal-${index}`,
    name: `Observed ${index}:${round}`,
    cwd: handoff(index).cwd,
    jobName: "codex",
    focused: false,
    buried: false,
    windowId: `window-${index % 2}`,
    tabId: `tab-${index}`,
    windowIndex: index % 2 + 1,
    tabIndex: index + 1,
    paneIndex: 1,
    profileName: "Work",
    splitPath: [{ vertical: true, index: 0 }],
    observedAt: new Date(Date.parse(START) + round * 60_000).toISOString(),
  };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "session-atlas-continuation-load-"));
  temporaryDirectories.push(directory);
  let now = new Date(START);
  const createRegistry = async () => {
    const registry = new SessionRegistry(
      new AttentionStore(join(directory, "attention.json")),
      new RecoveryStore(join(directory, "recovery.json"), { now: () => now }),
      45_000,
    );
    await registry.load();
    return registry;
  };
  return {
    directory,
    registry: await createRegistry(),
    createRegistry,
    advanceDays(days: number) { now = new Date(Date.parse(START) + days * DAY); },
  };
}

describe("continuation persistence under load", () => {
  it("retains 260 concurrent four-item cards across observations, restart, and ordinary history expiry", async () => {
    const f = await fixture();
    const count = 260;
    const observedCount = 8;
    const matches = Array.from({ length: observedCount }, (_, index) => ({ status: "linked" as const, conversationId: sessionId(index) }));
    await f.registry.observeRecoveries(Array.from({ length: observedCount }, (_, index) => terminal(index)), matches);
    const writes: Promise<unknown>[] = [];
    for (let index = 0; index < count; index += 1) {
      writes.push(f.registry.upsertHandoff(sessionId(index), handoff(index)));
      if ((index + 1) % 20 === 0) {
        writes.push(f.registry.observeRecoveries(
          Array.from({ length: observedCount }, (_, observed) => terminal(observed, (index + 1) / 20)),
          matches,
        ));
      }
    }
    await Promise.all(writes);
    await f.registry.observeRecoveries([], []);
    const beforeRestart = f.registry.snapshot().recoveries;
    expect(beforeRestart).toHaveLength(count);
    expect(beforeRestart.reduce((total, record) => total + (record.handoff?.items.length ?? 0), 0)).toBe(1_040);
    for (let index = 0; index < count; index += 1) {
      const record = f.registry.requireRecovery(sessionId(index));
      expect(record.status).toBe("closed");
      expect(record.handoff).toMatchObject({
        summary: handoff(index).summary,
        sourceTurnId: `turn-${index}-0`,
        items: handoff(index).items,
      });
      expect(record.handoff?.items[0]?.dueAt).toBe("2026-09-11T08:00:00.000Z");
      if (index < observedCount) {
        expect(record).toMatchObject({ title: `Observed ${index}:13`, savedLocation: { tabId: `tab-${index}`, profileName: "Work" } });
      }
    }

    f.advanceDays(40);
    const reloaded = await f.createRegistry();
    await reloaded.observeRecoveries([], []);
    expect(reloaded.snapshot().recoveries).toHaveLength(count);
    for (const record of beforeRestart) expect(reloaded.requireRecovery(record.sessionId)).toEqual(record);
    const raw = JSON.parse(await readFile(join(f.directory, "recovery.json"), "utf8"));
    expect(Object.keys(raw.recoveries)).toHaveLength(count);

    await Promise.all(Array.from({ length: 20 }, (_, index) => reloaded.upsertHandoff(sessionId(index), {
      ...handoff(index, 1),
      expectedVersion: reloaded.getHandoff(sessionId(index))!.version!,
      items: handoff(index, 1).items.map((item) => ({ ...item, status: "done" as const })),
    })));
    await reloaded.observeRecoveries([], []);
    expect(reloaded.snapshot().recoveries).toHaveLength(240);
    expect(reloaded.snapshot().recoveries.every((record) => record.handoff?.items.every((item) => item.status === "pending"))).toBe(true);
    const finalReload = await f.createRegistry();
    expect(finalReload.snapshot().recoveries).toHaveLength(240);
    for (let index = 20; index < count; index += 1) {
      expect(finalReload.getHandoff(sessionId(index))?.summary).toBe(handoff(index).summary);
    }
  }, 30_000);

  it("rejects 63 stale same-card updates while 32 other cards and 16 observations interleave", async () => {
    const f = await fixture();
    await f.registry.observeRecoveries([terminal(0)], [{ status: "linked", conversationId: sessionId(0) }]);
    const writes: Promise<unknown>[] = [];
    for (let revision = 0; revision < 64; revision += 1) {
      const input = handoff(0, revision);
      if (revision % 2 === 1) input.items.pop();
      writes.push(f.registry.upsertHandoff(sessionId(0), input));
      if (revision % 2 === 0) writes.push(f.registry.upsertHandoff(sessionId(1_000 + revision / 2), handoff(1_000 + revision / 2)));
      if ((revision + 1) % 4 === 0) {
        writes.push(f.registry.observeRecoveries([terminal(0, revision + 1)], [{ status: "linked", conversationId: sessionId(0) }]));
      }
    }
    const results = await Promise.allSettled(writes);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(63);
    for (const result of results.filter((result) => result.status === "rejected")) expect(result).toMatchObject({ reason: { code: "HANDOFF_CONFLICT" } });
    const latest = f.registry.requireRecovery(sessionId(0));
    expect(latest).toMatchObject({
      title: "Observed 0:64",
      handoff: { summary: handoff(0).summary, sourceTurnId: "turn-0-0" },
      savedLocation: { tabId: "tab-0", profileName: "Work" },
    });
    expect(latest.handoff?.items).toHaveLength(4);
    expect(latest.handoff?.items.map((item) => item.nextAction)).toEqual(handoff(0).items.map((item) => item.nextAction));
    expect(f.registry.snapshot().recoveries).toHaveLength(33);
    const reloaded = await f.createRegistry();
    expect(reloaded.requireRecovery(sessionId(0))).toEqual(latest);
    for (let index = 0; index < 32; index += 1) {
      expect(reloaded.getHandoff(sessionId(1_000 + index))?.summary).toBe(handoff(1_000 + index).summary);
    }
  }, 30_000);
});
