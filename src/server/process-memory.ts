import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import type { SessionSummary, MemorySnapshot, ProcessMemory } from "../shared/types.js";

const execute = promisify(execFile);
const ttyKey = (tty?: string) => tty?.replace(/^\/dev\//, "");

export function attributeMemory(sessions: SessionSummary[], processes: ProcessMemory[]): MemorySnapshot {
  const active = sessions.filter((s) => !s.stale && s.terminalSessionId && s.terminal?.tty);
  const byTty = new Map<string, string[]>();
  for (const s of active) {
    const tty = ttyKey(s.terminal!.tty)!;
    const ids = byTty.get(tty) ?? [];
    if (!ids.includes(s.terminalSessionId!)) ids.push(s.terminalSessionId!);
    byTty.set(tty, ids);
  }
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  const owners = new Map<number, string | undefined>();
  function owner(process: ProcessMemory): string | undefined {
    const seen = new Set<number>();
    let current: ProcessMemory | undefined = process;
    while (current && !seen.has(current.pid)) {
      seen.add(current.pid);
      const candidates = byTty.get(ttyKey(current.tty)!);
      if (candidates) return candidates.length === 1 ? candidates[0] : undefined;
      current = byPid.get(current.ppid);
    }
    return undefined;
  }
  for (const p of processes) owners.set(p.pid, owner(p));
  const unique = new Map(active.map((s) => [s.terminalSessionId!, s]));
  return {
    sampledAt: new Date().toISOString(),
    sessions: [...unique].map(([terminalSessionId, s]) => {
      const members = processes.filter((p) => owners.get(p.pid) === terminalSessionId);
      const measured = members.filter((p) => p.footprintBytes !== null);
      return {
        sessionId: s.id, terminalSessionId, title: s.title,
        terminal: s.terminal!,
        rssBytes: members.reduce((n, p) => n + p.rssBytes, 0),
        footprintBytes: measured.length ? measured.reduce((n, p) => n + p.footprintBytes!, 0) : null,
        missingFootprints: members.length - measured.length,
        processes: members.sort((a, b) => (b.footprintBytes ?? b.rssBytes) - (a.footprintBytes ?? a.rssBytes)),
      };
    }).sort((a, b) => (b.footprintBytes ?? b.rssBytes) - (a.footprintBytes ?? a.rssBytes)),
  };
}

export async function sampleMemory(sessions: SessionSummary[]): Promise<MemorySnapshot> {
  const { stdout } = await execute("python3", [resolve("scripts/process-memory.py")], {
    timeout: 8_000, maxBuffer: 4 * 1024 * 1024,
  });
  return attributeMemory(sessions, JSON.parse(stdout) as ProcessMemory[]);
}
