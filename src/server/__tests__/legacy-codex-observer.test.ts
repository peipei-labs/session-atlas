import { afterEach, describe, expect, it, vi } from "vitest";

import { LegacyCodexObserver } from "../legacy-codex-observer.js";
import { normalizeItermSession, normalizeProviderSession } from "../normalization.js";
import type { ItermSessionSnapshot } from "../provider-ports.js";

type ProcessResult = Error & { code?: string | number; killed?: boolean; signal?: string };
const execFileMock = vi.hoisted(() => vi.fn<(
  file: string,
  args: string[],
  options: { encoding: string; maxBuffer: number; timeout: number },
  callback: (error: ProcessResult | null, stdout: string, stderr: string) => void,
) => void>());
vi.mock("node:child_process", () => ({ execFile: execFileMock }));
afterEach(() => execFileMock.mockReset());

const snapshot: ItermSessionSnapshot = {
  sessionId: "w0t0p0:ABC",
  name: "Codex",
  cwd: "/tmp/example",
  tty: "/dev/ttys001",
  jobName: "codex",
  jobPid: 42,
  commandLine: "/opt/homebrew/bin/codex",
  focused: false,
  buried: false,
  windowId: "window-2",
  tabId: "tab-3",
  windowIndex: 2,
  tabIndex: 3,
  paneIndex: 2,
  tabCount: 4,
  paneCount: 2,
  currentWindow: true,
  observedAt: "2026-08-20T00:00:00.000Z",
};

describe("LegacyCodexObserver", () => {
  it("links only a single rollout opened by a matching Codex process", async () => {
    const observer = new LegacyCodexObserver({
      codexHome: "/Users/example/.codex",
      readCommand: async (file) => {
        if (file === "/bin/ps") {
          return " 42 1 ttys001 /opt/homebrew/bin/codex\n 43 42 ttys001 codex app-server\n";
        }
        return "p42\np43\nn/Users/example/.codex/sessions/2026/08/20/rollout-2026-08-20T00-00-00-01234567-89ab-cdef-8123-456789abcdef.jsonl\n";
      },
    });

    await expect(observer.observe(snapshot)).resolves.toEqual({
      status: "linked",
      conversationId: "01234567-89ab-cdef-8123-456789abcdef",
    });
  });

  it("fails closed when multiple rollout IDs are open", async () => {
    const observer = new LegacyCodexObserver({
      codexHome: "/Users/example/.codex",
      readCommand: async (file) =>
        file === "/bin/ps"
          ? " 42 1 ttys001 codex\n"
          : [
              "p42",
              "n/Users/example/.codex/sessions/rollout-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl",
              "n/Users/example/.codex/sessions/rollout-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl",
            ].join("\n"),
    });

    await expect(observer.observe(snapshot)).resolves.toEqual({ status: "ambiguous" });
  });

  it("links a root thread when every extra rollout is one of its subagents", async () => {
    const rootId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const childId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const observer = new LegacyCodexObserver({
      codexHome: "/Users/example/.codex",
      readCommand: async (file) =>
        file === "/bin/ps"
          ? " 42 1 ttys001 codex\n"
          : [
              "p42",
              `n/Users/example/.codex/sessions/rollout-${rootId}.jsonl`,
              `n/Users/example/.codex/sessions/rollout-${childId}.jsonl`,
            ].join("\n"),
      readSessionMeta: async (file) => {
        const id = file.includes(childId) ? childId : rootId;
        return {
          type: "session_meta",
          payload: {
            id,
            parent_thread_id: id === childId ? rootId : null,
            source: id === childId
              ? { subagent: { thread_spawn: { parent_thread_id: rootId } } }
              : "cli",
          },
        };
      },
    });

    await expect(observer.observe(snapshot)).resolves.toEqual({
      status: "linked",
      conversationId: rootId,
    });
  });

  it("keeps independent root threads ambiguous even when their metadata has parent IDs", async () => {
    const firstId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const secondId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const observer = new LegacyCodexObserver({
      codexHome: "/Users/example/.codex",
      readCommand: async (file) =>
        file === "/bin/ps"
          ? " 42 1 ttys001 codex\n"
          : [
              "p42",
              `n/Users/example/.codex/sessions/rollout-${firstId}.jsonl`,
              `n/Users/example/.codex/sessions/rollout-${secondId}.jsonl`,
            ].join("\n"),
      readSessionMeta: async (file) => ({
        type: "session_meta",
        payload: {
          id: file.includes(secondId) ? secondId : firstId,
          parent_thread_id: firstId,
          source: "cli",
        },
      }),
    });

    await expect(observer.observe(snapshot)).resolves.toEqual({ status: "ambiguous" });
  });

  it("fails closed when subagent metadata disagrees about its parent", async () => {
    const rootId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const childId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const otherId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const observer = new LegacyCodexObserver({
      codexHome: "/Users/example/.codex",
      readCommand: async (file) =>
        file === "/bin/ps"
          ? " 42 1 ttys001 codex\n"
          : [
              "p42",
              `n/Users/example/.codex/sessions/rollout-${rootId}.jsonl`,
              `n/Users/example/.codex/sessions/rollout-${childId}.jsonl`,
            ].join("\n"),
      readSessionMeta: async (file) => ({
        type: "session_meta",
        payload: {
          id: file.includes(childId) ? childId : rootId,
          parent_thread_id: file.includes(childId) ? otherId : null,
          source: file.includes(childId)
            ? { subagent: { thread_spawn: { parent_thread_id: rootId } } }
            : "cli",
        },
      }),
    });

    await expect(observer.observe(snapshot)).resolves.toEqual({ status: "ambiguous" });
  });

  it("uses the exact Codex resume ID from the foreground process before ambiguous open files", async () => {
    const calls: string[] = [];
    const observer = new LegacyCodexObserver({
      codexHome: "/Users/example/.codex",
      readCommand: async (file) => {
        calls.push(file);
        if (file === "/bin/ps") {
          return " 42 1 ttys001 codex resume -C /tmp/example 01234567-89ab-cdef-8123-456789abcdef\n";
        }
        return [
          "p42",
          "n/Users/example/.codex/sessions/rollout-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl",
          "n/Users/example/.codex/sessions/rollout-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl",
        ].join("\n");
      },
    });

    await expect(observer.observe(snapshot)).resolves.toEqual({
      status: "linked",
      conversationId: "01234567-89ab-cdef-8123-456789abcdef",
    });
    expect(calls).toEqual(["/bin/ps"]);
  });

  it.each([true, false])(
    "requires actual open-rollout evidence when resume argv is untrusted (open file: %s)",
    async (hasOpenRollout) => {
      const argvId = "01234567-89ab-cdef-8123-456789abcdef";
      const openId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const calls: Array<{ file: string; args: readonly string[] }> = [];
      const observer = new LegacyCodexObserver({
        codexHome: "/Users/example/.codex",
        trustResumeCommand: false,
        readCommand: async (file, args) => {
          calls.push({ file, args });
          if (file === "/bin/ps") {
            return ` 42 1 ttys001 codex resume -C /tmp/example ${argvId}\n`;
          }
          return hasOpenRollout
            ? `p42\nn/Users/example/.codex/sessions/rollout-${openId}.jsonl\n`
            : "p42\n";
        },
      });

      await expect(observer.observe(snapshot)).resolves.toEqual(
        hasOpenRollout ? { status: "linked", conversationId: openId } : { status: "unlinked" },
      );
      expect(calls).toEqual([
        { file: "/bin/ps", args: ["-axo", "pid=,ppid=,tty=,command="] },
        { file: "/usr/sbin/lsof", args: ["-nP", "-Fpn", "-p", "42"] },
      ]);
    },
  );

  it("finds an exact resume process by tty when iTerm reports a descendant node job", async () => {
    const observer = new LegacyCodexObserver({
      readCommand: async (file, args) => {
        if (file === "/bin/ps") {
          return [
            " 42 1 ttys001 codex",
            " 99 1 ttys002 codex resume -C /tmp/hidden aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            " 100 99 ttys002 node worker.js",
          ].join("\n");
        }
        return `p${args.at(-1) ?? ""}\n`;
      },
    });
    const hidden = {
      ...snapshot,
      sessionId: "hidden-codex",
      cwd: "/tmp/hidden",
      tty: "/dev/ttys002",
      jobName: "node",
      jobPid: 100,
      commandLine: "node worker.js",
    };

    await expect(observer.observeAll([hidden])).resolves.toEqual([
      {
        status: "linked",
        conversationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
    ]);
  });

  it("shares one process snapshot and one deduplicated lsof call across the entire batch", async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const observer = new LegacyCodexObserver({
      codexHome: "/Users/example/.codex",
      readCommand: async (file, args) => {
        calls.push({ file, args });
        if (file === "/bin/ps") {
          return [
            " 42 1 ttys001 /opt/homebrew/bin/codex",
            " 43 42 ttys001 codex app-server",
            " 60 1 ttys002 codex",
            " 70 1 ttys003 codex",
            " 80 1 ttys004 zsh",
          ].join("\n");
        }
        return [
          "p42",
          "p43",
          "n/Users/example/.codex/sessions/rollout-01234567-89ab-cdef-8123-456789abcdef.jsonl",
          "p60",
          "n/Users/example/.codex/sessions/rollout-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl",
          "n/Users/example/.codex/sessions/rollout-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl",
        ].join("\n");
      },
    });
    const sessions: ItermSessionSnapshot[] = [
      { ...snapshot, sessionId: "linked-a" },
      { ...snapshot, sessionId: "linked-b" },
      {
        ...snapshot,
        sessionId: "ambiguous",
        tty: "/dev/ttys002",
        jobPid: 60,
      },
      {
        ...snapshot,
        sessionId: "unlinked",
        tty: "/dev/ttys003",
        jobPid: 70,
      },
      {
        ...snapshot,
        sessionId: "terminal",
        tty: "/dev/ttys004",
        jobName: "zsh",
        jobPid: 80,
        commandLine: "-zsh",
      },
    ];

    const matches = await observer.observeAll(sessions);

    expect(matches).toEqual([
      { status: "linked", conversationId: "01234567-89ab-cdef-8123-456789abcdef" },
      { status: "linked", conversationId: "01234567-89ab-cdef-8123-456789abcdef" },
      { status: "ambiguous" },
      { status: "error", reason: "process-inspection-failed" },
      { status: "unlinked" },
    ]);
    expect(calls.filter(({ file }) => file === "/bin/ps")).toHaveLength(1);
    expect(calls.filter(({ file }) => file === "/usr/sbin/lsof")).toEqual([
      { file: "/usr/sbin/lsof", args: ["-nP", "-Fpn", "-p", "42,43,60,70"] },
    ]);
  });

  it("keeps reordered PID blocks and subagent roots separate for each pane", async () => {
    const firstId = "01234567-89ab-cdef-8123-456789abcdef";
    const secondId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const childId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const unrelatedId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const observer = new LegacyCodexObserver({
      codexHome: "/Users/example/.codex",
      trustResumeCommand: false,
      readCommand: async (file, args) => {
        calls.push({ file, args });
        if (file === "/bin/ps") {
          return [
            ` 42 1 ttys001 codex resume ${firstId}`,
            " 43 42 ttys001 codex app-server",
            ` 60 1 ttys002 codex resume ${secondId}`,
          ].join("\n");
        }
        return [
          `n/Users/example/.codex/sessions/rollout-${unrelatedId}.jsonl`,
          "p60",
          `n/Users/example/.codex/archived_sessions/rollout-${secondId}.jsonl`,
          "p999",
          `n/Users/example/.codex/sessions/rollout-${unrelatedId}.jsonl`,
          "p42",
          `n/Users/example/.codex/sessions/rollout-${firstId}.jsonl`,
          "p43",
          `n/Users/example/.codex/sessions/rollout-${childId}.jsonl`,
        ].join("\n");
      },
      readSessionMeta: async (file) => ({
        type: "session_meta",
        payload: {
          id: file.includes(childId) ? childId : firstId,
          source: file.includes(childId)
            ? { subagent: { thread_spawn: { parent_thread_id: firstId } } }
            : "cli",
        },
      }),
    });

    await expect(observer.observeAll([
      snapshot,
      { ...snapshot, sessionId: "second-pane", tty: "/dev/ttys002", jobPid: 60 },
    ])).resolves.toEqual([
      { status: "linked", conversationId: firstId },
      { status: "linked", conversationId: secondId },
    ]);
    expect(calls).toEqual([
      { file: "/bin/ps", args: ["-axo", "pid=,ppid=,tty=,command="] },
      { file: "/usr/sbin/lsof", args: ["-nP", "-Fpn", "-p", "42,43,60"] },
    ]);
  });

  it("accepts exit 1 without stderr for present PIDs and fails missing PIDs closed", async () => {
    const firstId = "01234567-89ab-cdef-8123-456789abcdef";
    execFileMock.mockImplementation((file, _args, _options, callback) => {
      if (file === "/bin/ps") {
        callback(null, " 42 1 ttys001 codex\n 60 1 ttys002 codex\n", "");
      } else {
        callback(
          Object.assign(new Error("Some selected processes exited"), { code: 1 }),
          `p42\nn/Users/example/.codex/sessions/rollout-${firstId}.jsonl\n`,
          "",
        );
      }
    });
    const observer = new LegacyCodexObserver({ codexHome: "/Users/example/.codex", trustResumeCommand: false });

    await expect(observer.observeAll([
      snapshot,
      { ...snapshot, sessionId: "exited-pane", tty: "/dev/ttys002", jobPid: 60 },
    ])).resolves.toEqual([
      { status: "linked", conversationId: firstId },
      { status: "error", reason: "process-inspection-failed" },
    ]);
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(execFileMock.mock.calls.map(([file, args, options]) => ({ file, args, options }))).toEqual([
      { file: "/bin/ps", args: ["-axo", "pid=,ppid=,tty=,command="], options: { encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 3_000 } },
      { file: "/usr/sbin/lsof", args: ["-nP", "-Fpn", "-p", "42,60"], options: { encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 3_000 } },
    ]);
  });

  it.each([
    { label: "exit 1 with stderr", code: 1, stderr: "inspection warning", killed: false, signal: undefined },
    { label: "other exit status", code: 2, stderr: "", killed: false, signal: undefined },
    { label: "command timeout", code: 1, stderr: "", killed: true, signal: "SIGTERM" },
    { label: "signalled exit", code: 1, stderr: "", killed: false, signal: "SIGTERM" },
    { label: "output limit exceeded", code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", stderr: "", killed: true, signal: undefined },
  ])("discards every partial lsof block on $label", async ({ code, stderr, killed, signal }) => {
    execFileMock.mockImplementation((file, _args, _options, callback) => {
      if (file === "/bin/ps") {
        callback(null, " 42 1 ttys001 codex\n 60 1 ttys002 codex\n", "");
      } else {
        callback(Object.assign(new Error("Failed lsof batch"), { code, killed, signal }), [
          "p42",
          "n/Users/example/.codex/sessions/rollout-01234567-89ab-cdef-8123-456789abcdef.jsonl",
          "p60",
          "n/Users/example/.codex/sessions/rollout-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl",
        ].join("\n"), stderr);
      }
    });
    const observer = new LegacyCodexObserver({ codexHome: "/Users/example/.codex", trustResumeCommand: false });

    await expect(observer.observeAll([
      snapshot,
      { ...snapshot, sessionId: "second-pane", tty: "/dev/ttys002", jobPid: 60 },
    ])).resolves.toEqual([
      { status: "error", reason: "process-inspection-failed" },
      { status: "error", reason: "process-inspection-failed" },
    ]);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("does not treat a failed ps exit 1 as a usable partial process snapshot", async () => {
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(Object.assign(new Error("ps failed"), { code: 1 }), " 42 1 ttys001 codex\n", "");
    });
    const observer = new LegacyCodexObserver();

    await expect(observer.observe(snapshot)).resolves.toEqual({ status: "error", reason: "process-snapshot-failed" });
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("reuses a linked identity only until its bounded revalidation interval", async () => {
    const calls: string[] = [];
    let now = 1_000;
    let conversationId = "01234567-89ab-cdef-8123-456789abcdef";
    const observer = new LegacyCodexObserver({
      codexHome: "/Users/example/.codex",
      retryAfterMs: 30_000,
      now: () => now,
      readCommand: async (file) => {
        calls.push(file);
        return file === "/bin/ps"
          ? " 42 1 ttys001 codex\n"
          : `p42\nn/Users/example/.codex/sessions/rollout-${conversationId}.jsonl\n`;
      },
    });

    await expect(observer.observe(snapshot)).resolves.toMatchObject({ status: "linked" });
    await expect(observer.observe(snapshot)).resolves.toMatchObject({ status: "linked" });
    now += 30_001;
    conversationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await expect(observer.observe(snapshot)).resolves.toMatchObject({ conversationId });

  });

  it("inspects every candidate when an exact resume process shares the tty", async () => {
    const observer = new LegacyCodexObserver({
      codexHome: "/Users/example/.codex",
      readCommand: async (file) => {
        if (file === "/bin/ps") {
          return " 42 1 ttys001 codex resume 01234567-89ab-cdef-8123-456789abcdef\n 43 1 ttys001 codex\n";
        }
        return [
          "p42",
          "n/Users/example/.codex/sessions/rollout-01234567-89ab-cdef-8123-456789abcdef.jsonl",
          "p43",
          "n/Users/example/.codex/sessions/rollout-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl",
        ].join("\n");
      },
    });

    await expect(observer.observe(snapshot)).resolves.toEqual({ status: "ambiguous" });
  });

  it("bounds retries for an unchanged unresolved identity and invalidates on pid change", async () => {
    const calls: string[] = [];
    let now = 1_000;
    const observer = new LegacyCodexObserver({
      retryAfterMs: 30_000,
      now: () => now,
      readCommand: async (file) => {
        calls.push(file);
        return file === "/bin/ps" ? " 42 1 ttys001 codex\n 43 1 ttys001 codex\n" : "p42\n";
      },
    });

    await observer.observe(snapshot);
    now += 2_000;
    await observer.observe(snapshot);
    now += 2_000;
    await observer.observe({ ...snapshot, jobPid: 43 });

    expect(calls.filter((file) => file === "/bin/ps")).toHaveLength(2);
  });

  it("does not run process commands for a batch without Codex sessions", async () => {
    const calls: string[] = [];
    const observer = new LegacyCodexObserver({
      readCommand: async (file) => {
        calls.push(file);
        return "";
      },
    });
    const terminal = {
      ...snapshot,
      sessionId: "terminal",
      jobName: "zsh",
      commandLine: "-zsh",
    };

    await expect(observer.observeAll([terminal])).resolves.toEqual([{ status: "unlinked" }]);
    expect(calls).toEqual([]);
  });

  it("fails the whole batch closed when the process snapshot fails", async () => {
    const observer = new LegacyCodexObserver({
      readCommand: async () => {
        throw new Error("ps unavailable");
      },
    });

    await expect(
      observer.observeAll([
        snapshot,
        { ...snapshot, sessionId: "second", tty: "/dev/ttys002", jobPid: 60 },
      ]),
    ).resolves.toEqual([
      { status: "error", reason: "process-snapshot-failed" },
      { status: "error", reason: "process-snapshot-failed" },
    ]);
  });

  it("does not link a session when any requested candidate is absent from the lsof batch", async () => {
    const observer = new LegacyCodexObserver({
      codexHome: "/Users/example/.codex",
      readCommand: async (file) => {
        if (file === "/bin/ps") {
          return " 42 1 ttys001 codex\n 43 42 ttys001 codex app-server\n";
        }
        return "p43\nn/Users/example/.codex/sessions/rollout-01234567-89ab-cdef-8123-456789abcdef.jsonl\n";
      },
    });

    await expect(observer.observe(snapshot)).resolves.toEqual({
      status: "error",
      reason: "process-inspection-failed",
    });
  });

  it("does not claim an agent process is actively working", async () => {
    const normalized = await normalizeItermSession(snapshot, { status: "unlinked" });
    expect(normalized.activityState).toBe("unknown");
    expect(normalized.provider).toBe("terminal");
    expect(normalized.capabilities).toMatchObject({ focus: true, send: false, steer: false });
    expect(normalized.currentActivity).toContain("not uniquely linked");
    expect(normalized.recoveryStatus).toBe("pending");
    expect(normalized.terminal).toEqual({
      windowId: "window-2",
      tabId: "tab-3",
      tty: "/dev/ttys001",
      jobName: "codex",
      jobPid: 42,
      windowIndex: 2,
      tabIndex: 3,
      paneIndex: 2,
      tabCount: 4,
      paneCount: 2,
      currentWindow: true,
    });
  });

  it("surfaces recovery capture failures on the affected terminal session", async () => {
    const normalized = await normalizeItermSession(snapshot, {
      status: "error",
      reason: "process-snapshot-failed",
    });

    expect(normalized).toMatchObject({
      recoveryStatus: "failed",
      recoveryMessage: "Process inventory could not be read.",
      currentActivity: "Codex recovery capture failed",
    });
  });

  it.each([true, false])(
    "preserves focused=%s through iTerm and provider normalization without changing capabilities",
    async (focused) => {
      const normalized = await normalizeItermSession(
        { ...snapshot, focused },
        { status: "unlinked" },
      );

      expect(normalized.focused).toBe(focused);
      expect(normalized.capabilities).toEqual({
        open: true,
        focus: true,
        send: false,
        steer: false,
        interrupt: false,
        approve: false,
        answer: false,
      });

      const providerNormalized = await normalizeProviderSession(normalized);
      expect(providerNormalized.focused).toBe(focused);
      expect(providerNormalized.capabilities).toEqual(normalized.capabilities);
    },
  );
});
