import type { MemorySnapshot, SessionSummary } from "../shared/types";

export type SessionMemory = MemorySnapshot["sessions"][number] & { bridgeOffline?: boolean };
export interface MemoryPresentation {
  byTerminal: ReadonlyMap<string, SessionMemory>;
  highlighted: ReadonlySet<string>;
  sampledAt?: string;
}

export const MEMORY_EXPLANATION = "Footprint 包含压缩内存记账；RSS 仅为常驻内存，两者不可相加。包含可追溯的后台子进程，不代表整机或 iTerm2 应用总量。";

export function memorySize(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GiB` : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

export function memoryOffline(session: SessionSummary, memory?: SessionMemory): boolean {
  return Boolean(memory?.bridgeOffline) || session.stale || session.activityState === "offline";
}

export function presentMemory(snapshot: MemorySnapshot | undefined, sessions: readonly SessionSummary[], bridgeOnline = true): MemoryPresentation {
  const byTerminal = new Map(snapshot?.sessions.map((s) => [s.terminalSessionId, { ...s, bridgeOffline: !bridgeOnline }]));
  const onlineIds = new Set(sessions.filter((s) => !memoryOffline(s)).map((s) => s.terminalSessionId));
  const top = [...byTerminal.values()]
    .filter((s) => !s.bridgeOffline && onlineIds.has(s.terminalSessionId) && s.missingFootprints === 0 && s.footprintBytes !== null && s.footprintBytes > 0)
    .sort((a, b) => b.footprintBytes! - a.footprintBytes! || a.terminalSessionId.localeCompare(b.terminalSessionId))
    .slice(0, 3);
  return { byTerminal, sampledAt: snapshot?.sampledAt, highlighted: new Set(top.map((s) => s.terminalSessionId)) };
}
