import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MemorySnapshot, SessionSummary } from "../shared/types";
import { createDemoSnapshot } from "./demo";
import { HoneycombBoard } from "./HoneycombBoard";
import { MemoryBadge, MemoryDetails } from "./MemoryPanel";
import { presentMemory, type SessionMemory } from "./memory-model";
Object.assign(globalThis, { React });

const base = createDemoSnapshot().sessions[0]!;
const session = (terminalSessionId: string, overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  ...base, id: `session-${terminalSessionId}`, terminalSessionId, title: "同名会话", stale: false, activityState: "idle",
  terminal: { windowIndex: 1, tabIndex: 1, paneIndex: 1 }, ...overrides,
});
const sample = (id: string, bytes: number | null, missingFootprints = 0): SessionMemory => ({
  sessionId: `old-id-${id}`, terminalSessionId: id, title: "旧标题", terminal: {}, footprintBytes: bytes,
  rssBytes: 12, missingFootprints, processes: [],
});
const snapshot = (sessions: SessionMemory[]): MemorySnapshot => ({ sampledAt: "2026-09-25T05:00:00Z", sessions });

describe("memory attached to sessions", () => {
  it("maps split and renamed sessions by terminal identity in both groupings", () => {
    const a = session("a"), b = session("b", { terminal: { windowIndex: 1, tabIndex: 1, paneIndex: 2 } });
    const memory = presentMemory(snapshot([sample("b", 8 * 1024 ** 3), sample("a", 2 * 1024 ** 3)]), [a, b]);
    for (const groupBy of ["project", "window"] as const) {
      const html = renderToStaticMarkup(<HoneycombBoard sessions={[a, b]} memory={memory} groupBy={groupBy} busyAction={null} onSelect={() => {}} onFocus={() => {}} />);
      const labels = [...html.matchAll(/aria-label="内存 ([^"]+)"/g)].map(m => m[1]);
      expect(labels).toEqual(["2.00 GiB", "8.00 GiB"]);
      expect(html).not.toContain("旧标题");
    }
  });
  it("highlights only the top three complete live measurements, deduplicating aliases", () => {
    const sessions = [session("a"), session("a", { id: "alias" }), session("b"), session("c"), session("d"), session("partial"), session("gone", { activityState: "offline" }), session("stale", { stale: true })];
    const memory = presentMemory(snapshot([sample("a", 5), sample("b", 4), sample("c", 3), sample("d", 2), sample("partial", 999, 1), sample("gone", 888), sample("stale", 777), sample("unknown", 666)]), sessions);
    expect([...memory.highlighted]).toEqual(["a", "b", "c"]);
  });
  it("distinguishes unavailable, partial and offline old values without fake zero", () => {
    const render = (s: SessionSummary, m?: SessionMemory) => renderToStaticMarkup(<MemoryBadge session={s} memory={m} highlighted={true} />);
    expect(render(session("a"))).toContain('aria-label="内存 —"');
    expect(render(session("a"), sample("a", null))).toContain('aria-label="内存 —"');
    expect(render(session("a"), sample("a", 1024 ** 3, 1))).toContain('aria-label="内存 1.00 GiB · 部分"');
    const offline = render(session("a", { stale: true }), sample("a", 1024 ** 3));
    expect(offline).toContain('aria-label="内存 1.00 GiB · 旧"');
    expect(offline).not.toContain('is-high');
  });
  it("marks cached values old on a health-only disconnect and restores them on reconnect", () => {
    const s = session("a"), sessions = [s], cached = snapshot([sample("a", 1024 ** 3)]);
    expect(presentMemory(cached, sessions, true).highlighted.has("a")).toBe(true);
    const offline = presentMemory(cached, sessions, false);
    const memory = offline.byTerminal.get("a")!;
    expect(s.stale).toBe(false);
    expect(memory.footprintBytes).toBe(1024 ** 3);
    expect(offline.highlighted.size).toBe(0);
    const badge = renderToStaticMarkup(<MemoryBadge session={s} memory={memory} highlighted={true} />);
    expect(badge).toContain('aria-label="内存 1.00 GiB · 旧"');
    expect(badge).not.toContain('is-high');
    expect(renderToStaticMarkup(<MemoryDetails session={s} memory={memory} sampledAt={offline.sampledAt} />)).toContain("会话离线，仅为旧样本");
    expect(presentMemory(cached, sessions, true).highlighted.has("a")).toBe(true);
    expect(cached.sessions[0]).not.toHaveProperty("bridgeOffline");
  });
  it("hides board values when disabled and renders process details only in the detail section", () => {
    const s = session("a");
    const html = renderToStaticMarkup(<HoneycombBoard sessions={[s]} busyAction={null} onSelect={() => {}} onFocus={() => {}} />);
    expect(html).not.toContain('honey-memory');
    const m = sample("a", 1024 ** 3);
    m.processes = [{ pid: 42, ppid: 1, name: "python", tty: "??", footprintBytes: null, rssBytes: 1024 ** 2 }];
    const detail = renderToStaticMarkup(<MemoryDetails session={s} memory={m} sampledAt="2026-09-25T05:00:00Z" />);
    expect(detail).toContain("python");
    expect(detail).toContain("<td>42</td><td>—</td><td>1.0 MiB</td>");
    expect(detail).not.toContain('open=""');
  });
});
