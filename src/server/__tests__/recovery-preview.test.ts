import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readRecoveryPreviews } from "../recovery-preview.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

function userMessage(text: string): string {
  return JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    },
  });
}

describe("recovery previews", () => {
  it("reads the first and latest real user requests without returning injected context", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "session-atlas-preview-"));
    temporaryDirectories.push(codexHome);
    const sessionId = "01234567-89ab-cdef-8123-456789abcdef";
    const directory = join(codexHome, "sessions", "2026", "09", "02");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, `rollout-2026-09-02T00-00-00-${sessionId}.jsonl`),
      [
        userMessage("# AGENTS.md instructions\n<environment_context>internal setup</environment_context>"),
        userMessage("检查 Windows 那边新增的两个代理设置，看看怎么合并过来。"),
        JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
        userMessage("先只合并不冲突的设置。"),
      ].join("\n"),
    );

    await expect(
      readRecoveryPreviews(codexHome, [sessionId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]),
    ).resolves.toEqual([
      {
        sessionId,
        status: "available",
        firstRequest: "检查 Windows 那边新增的两个代理设置，看看怎么合并过来。",
        latestRequest: "先只合并不冲突的设置。",
      },
      {
        sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        status: "missing",
      },
    ]);
  });

  it("finds the latest request even when a large event follows it", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "session-atlas-preview-"));
    temporaryDirectories.push(codexHome);
    const sessionId = "11234567-89ab-cdef-8123-456789abcdef";
    const directory = join(codexHome, "archived_sessions");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, `rollout-${sessionId}.jsonl`),
      [
        JSON.stringify({ type: "event_msg", payload: { detail: "y".repeat(3_000_000) } }),
        userMessage("第一个要求"),
        userMessage("最后一个要求"),
        JSON.stringify({ type: "event_msg", payload: { detail: "x".repeat(9_000_000) } }),
      ].join("\n"),
    );

    await expect(readRecoveryPreviews(codexHome, [sessionId])).resolves.toEqual([
      {
        sessionId,
        status: "available",
        firstRequest: "第一个要求",
        latestRequest: "最后一个要求",
      },
    ]);
  });

  it("stops searching when the latest request is beyond the scan budget", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "session-atlas-preview-"));
    temporaryDirectories.push(codexHome);
    const sessionId = "21234567-89ab-cdef-8123-456789abcdef";
    const directory = join(codexHome, "archived_sessions");
    await mkdir(directory, { recursive: true });
    const event = `${JSON.stringify({
      type: "event_msg",
      payload: { detail: "x".repeat(1_000) },
    })}\n`;
    await writeFile(
      join(directory, `rollout-${sessionId}.jsonl`),
      `${userMessage("预算之外的要求")}\n${event.repeat(Math.ceil(17_000_000 / event.length))}`,
    );

    await expect(readRecoveryPreviews(codexHome, [sessionId])).resolves.toEqual([
      { sessionId, status: "missing" },
    ]);
  });
});
