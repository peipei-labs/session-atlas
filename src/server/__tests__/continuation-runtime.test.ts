import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readContinuationRuntime } from "../continuation-runtime.js";

const ID = "11111111-1111-4111-8111-111111111111";
const temporaryDirectories: string[] = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture(events: unknown[], options: { archived?: boolean; source?: unknown; fragment?: string } = {}) {
  const home = await mkdtemp(join(tmpdir(), "atlas-continuation-runtime-"));
  temporaryDirectories.push(home);
  const dir = join(home, options.archived ? "archived_sessions" : "sessions", "2026", "09", "10");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `rollout-${ID}.jsonl`);
  await writeFile(path, [
    { type: "session_meta", payload: { id: ID, cwd: "/project", source: options.source ?? "cli" } },
    ...events,
  ].map((value) => JSON.stringify(value)).join("\n") + "\n" + (options.fragment ?? ""));
  return { home, path };
}

const start = { type: "event_msg", timestamp: "2026-09-09T01:00:00Z", payload: { type: "task_started", turn_id: "turn-1" } };
const done = { type: "event_msg", timestamp: "2026-09-09T01:01:00Z", payload: { type: "task_complete", turn_id: "turn-1" } };

describe("continuation runtime inspection", () => {
  it("reads exact root identity and completed turn metadata without returning conversation content", async () => {
    const { home } = await fixture([start, { type: "response_item", payload: { role: "user", content: "private sentinel" } }, done]);
    const result = await readContinuationRuntime(home, ID);
    expect(result).toMatchObject({ cwd: "/project", state: "idle", turnId: "turn-1", turnStartedAt: start.timestamp });
    expect(JSON.stringify(result)).not.toContain("private sentinel");
  });

  it("a later started turn overrides a previous completion", async () => {
    const { home } = await fixture([start, done, { ...start, payload: { type: "task_started", turn_id: "turn-2" } }]);
    expect(await readContinuationRuntime(home, ID)).toMatchObject({ state: "running", turnId: "turn-2" });
  });

  it("uses the latest turn cwd for an explicitly resumed worktree", async () => {
    const { home } = await fixture([{ type: "turn_context", payload: { cwd: "/worktree" } }, start, done]);
    expect(await readContinuationRuntime(home, ID)).toMatchObject({ cwd: "/worktree", state: "idle" });
  });

  it.each(["", '{"type":"turn_context","payload":{"cwd":"/unfinished"'])("finds the latest resumed worktree before oversized output with trailing fragment %j", async (fragment) => {
    const { home } = await fixture([
      { type: "turn_context", payload: { cwd: "/older-worktree" } },
      { type: "turn_context", payload: { cwd: "/恢复/worktree", instructions: "x".repeat(320_000) } },
      start, { type: "response_item", payload: { type: "function_call_output", output: "x".repeat(3 * 1024 * 1024) } }, done,
    ], { fragment });
    expect(await readContinuationRuntime(home, ID)).toMatchObject({ cwd: "/恢复/worktree", state: fragment ? "unknown" : "idle" });
  });

  it("falls back to the original cwd only after scanning to the beginning", async () => {
    const { home } = await fixture([start, { type: "response_item", payload: "x".repeat(3 * 1024 * 1024) }, done]);
    expect(await readContinuationRuntime(home, ID)).toMatchObject({ cwd: "/project", state: "idle" });
  });

  it("rejects unavailable cwd evidence when the backward scan budget is exhausted", async () => {
    const { home } = await fixture([
      { type: "turn_context", payload: { cwd: "/worktree" } }, start,
      { type: "response_item", payload: "x".repeat(17 * 1024 * 1024) }, done,
    ]);
    await expect(readContinuationRuntime(home, ID)).rejects.toMatchObject({ code: "SESSION_RECORD_UNAVAILABLE" });
  });

  it("fails closed on unfinished concurrent appends and missing lifecycle evidence", async () => {
    const partial = await fixture([start, done], { fragment: '{"type":"event_msg"' });
    expect((await readContinuationRuntime(partial.home, ID)).state).toBe("unknown");
    const absent = await fixture([]);
    expect((await readContinuationRuntime(absent.home, ID)).state).toBe("unknown");
  });

  it("finds archived records and rejects child threads or ambiguous file copies", async () => {
    const archived = await fixture([start, done], { archived: true });
    expect((await readContinuationRuntime(archived.home, ID)).state).toBe("idle");
    const child = await fixture([start, done], { source: { subagent: { thread_spawn: { parent_thread_id: ID } } } });
    await expect(readContinuationRuntime(child.home, ID)).rejects.toMatchObject({ code: "SESSION_IDENTITY_MISMATCH" });
    const ambiguous = await fixture([start, done]);
    await writeFile(join(ambiguous.home, "sessions", `copy-${ID}.jsonl`), "{}");
    await expect(readContinuationRuntime(ambiguous.home, ID)).rejects.toMatchObject({ code: "SESSION_RECORD_UNAVAILABLE" });
  });

  it("does not use an arbitrary path or latest-session fallback", async () => {
    const { home } = await fixture([start, done]);
    await expect(readContinuationRuntime(home, "../../other")).rejects.toMatchObject({ code: "INVALID_SESSION_ID" });
    await expect(readContinuationRuntime(home, "22222222-2222-4222-8222-222222222222")).rejects.toMatchObject({ code: "SESSION_RECORD_UNAVAILABLE" });
  });
});
