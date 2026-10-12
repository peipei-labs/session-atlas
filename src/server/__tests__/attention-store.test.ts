import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AttentionStore } from "../attention-store.js";

const temporaryDirectories: string[] = [];
const THREAD_ID = "01234567-89ab-cdef-8123-456789abcdef";

async function makeStore(): Promise<{ directory: string; store: AttentionStore }> {
  const directory = await mkdtemp(join(tmpdir(), "session-atlas-attention-"));
  temporaryDirectories.push(directory);
  const store = new AttentionStore(join(directory, "state.json"));
  await store.load();
  return { directory, store };
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("AttentionStore", () => {
  it("loads v1 attention state and persists independent thread tags across attention writes and reloads", async () => {
    const { directory } = await makeStore();
    const statePath = join(directory, "state.json");
    await writeFile(statePath, JSON.stringify({ version: 1, sessions: { "iterm:one": { pinned: true, title: "Existing title" } } }));
    const store = new AttentionStore(statePath);
    await store.load();
    expect(store.getThreadTags(THREAD_ID)).toEqual([]);
    await store.updateThreadTags(THREAD_ID, { add: [" ＡＩ ", "研究"] });
    await store.update("iterm:one", { parked: true });
    const exposed = store.getThreadTags(THREAD_ID);
    exposed.push("outside mutation");
    const reloaded = new AttentionStore(statePath);
    await reloaded.load();
    expect(reloaded.getThreadTags(THREAD_ID)).toEqual(["AI", "研究"]);
    expect(reloaded.get("iterm:one")).toEqual({ pinned: true, parked: true, title: "Existing title" });
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({
      version: 1, sessions: { "iterm:one": { pinned: true, parked: true, title: "Existing title" } },
      threads: { [THREAD_ID]: { tags: ["AI", "研究"] } },
    });
  });

  it("serializes concurrent tag add/remove and attention changes without lost updates", async () => {
    const { store } = await makeStore();
    await store.updateThreadTags(THREAD_ID, { add: ["Old", "Keep"] });
    await Promise.all([
      store.updateThreadTags(THREAD_ID, { add: ["one"], remove: ["OLD"] }),
      store.update("iterm:one", { pinned: true }),
      store.updateThreadTags(THREAD_ID, { add: ["two"] }),
    ]);
    expect(store.getThreadTags(THREAD_ID)).toEqual(["Keep", "one", "two"]);
    expect(store.get("iterm:one").pinned).toBe(true);
    await store.updateThreadTags(THREAD_ID, { add: Array.from({ length: 9 }, (_, index) => `tag${index}`) });
    await expect(store.updateThreadTags(THREAD_ID, { add: ["overflow"] })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(store.getThreadTags(THREAD_ID)).toHaveLength(12);
  });

  it("removes the last thread tag while retaining ordinary attention state", async () => {
    const { store } = await makeStore();
    await store.update("iterm:one", { pinned: true });
    await store.updateThreadTags(THREAD_ID, { add: ["AI"] });
    expect(await store.updateThreadTags(THREAD_ID, { remove: ["ａｉ"] })).toEqual([]);
    expect(JSON.parse(await readFile(store.filePath, "utf8"))).toEqual({ version: 1, sessions: { "iterm:one": { pinned: true } } });
    const reloaded = new AttentionStore(store.filePath);
    await reloaded.load();
    expect(reloaded.getThreadTags(THREAD_ID)).toEqual([]);
    expect(reloaded.get("iterm:one").pinned).toBe(true);
  });

  it("persists concurrent updates atomically with private permissions", async () => {
    const { directory, store } = await makeStore();
    await Promise.all([
      store.update("managed:one", { pinned: true }),
      store.update("managed:one", { parked: true }),
      store.update("managed:one", { title: "  Focus task  ", acknowledge: true }),
    ]);

    const statePath = join(directory, "state.json");
    const onDisk = JSON.parse(await readFile(statePath, "utf8")) as {
      sessions: Record<string, Record<string, unknown>>;
    };
    expect(onDisk.sessions["managed:one"]).toMatchObject({
      pinned: true,
      parked: true,
      title: "Focus task",
    });
    expect(onDisk.sessions["managed:one"]?.acknowledgedAt).toEqual(expect.any(String));
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);

    const reloaded = new AttentionStore(statePath);
    await reloaded.load();
    expect(reloaded.get("managed:one")).toMatchObject({ pinned: true, parked: true });
  });

  it("quarantines malformed state and continues with an empty store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "session-atlas-attention-bad-"));
    temporaryDirectories.push(directory);
    const statePath = join(directory, "state.json");
    await writeFile(statePath, "not-json\n");
    const store = new AttentionStore(statePath);

    await expect(store.load()).resolves.toBeUndefined();
    expect(store.loadWarning).toContain("Invalid attention state was preserved");
    expect(store.get("managed:one")).toEqual({});
    const quarantined = (await readdir(directory)).find((name) => name.startsWith("state.json.corrupt-"));
    expect(quarantined).toBeDefined();
    expect(await readFile(join(directory, quarantined!), "utf8")).toBe("not-json\n");
  });
});
