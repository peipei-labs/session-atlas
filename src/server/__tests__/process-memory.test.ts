import { describe, expect, it } from "vitest";
import { attributeMemory } from "../process-memory.js";
import type { SessionSummary, ProcessMemory } from "../../shared/types.js";
const session = (id: string, tty: string, stale = false) => ({ id, terminalSessionId: id, title: id, stale, terminal: { tty } } as SessionSummary);
const process = (pid: number, ppid: number, tty: string, footprintBytes: number | null = 100): ProcessMemory => ({ pid, ppid, tty, footprintBytes, rssBytes: 10, name: "python" });

describe("process memory attribution", () => {
  it("includes detached TTY descendants once, without merging a nested terminal", () => {
    const result = attributeMemory([session("a", "/dev/ttys001"), session("b", "ttys002")], [
      process(1, 0, "??"), process(2, 1, "ttys001"), process(3, 2, "??", 90000),
      process(4, 3, "??"), process(5, 2, "ttys002"), process(6, 5, "??"),
    ]);
    expect(result.sessions[0]!.processes.map(p => p.pid).sort()).toEqual([2, 3, 4]);
    expect(result.sessions[0]!.footprintBytes).toBe(90200);
    expect(result.sessions[1]!.processes.map(p => p.pid)).toEqual([5, 6]);
  });
  it("does not turn unreadable footprints into zero or count duplicate aliases", () => {
    const s = session("a", "ttys001");
    const result = attributeMemory([s, { ...s, id: "alias" }], [process(2, 0, "ttys001", null)]);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]!.footprintBytes).toBeNull();
    expect(result.sessions[0]!.missingFootprints).toBe(1);
  });
  it("rejects ambiguous and stale TTY ownership and terminates parent cycles", () => {
    const result = attributeMemory([session("a", "ttys001"), session("b", "ttys001"), session("c", "ttys002", true)], [
      process(2, 0, "ttys001"), process(3, 0, "ttys002"), process(4, 5, "??"), process(5, 4, "??"),
    ]);
    expect(result.sessions.every(s => s.processes.length === 0)).toBe(true);
  });
});
