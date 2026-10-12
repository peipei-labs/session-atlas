import { describe, expect, it } from "vitest";

import { hasPendingHandoff, hasSavedHandoff, parseStoredHandoff, parseUpsertHandoffInput } from "../handoff.js";

function input(item: Record<string, unknown> = {}) {
  return {
    expectedVersion: null,
    cwd: "/tmp/project",
    summary: "等待上线后的核验",
    source: "thread",
    items: [{
      id: "verification",
      title: "核验运行结果",
      kind: "time",
      nextAction: "检查约定时间段内的运行结果",
      status: "pending",
      ...item,
    }],
  };
}

describe("handoff validation", () => {
  it("accepts a bounded reference without inventing a pending continuation item", () => {
    const reference = { title: "藏".repeat(200), reason: "供".repeat(1_000) };
    const parsed = parseUpsertHandoffInput({ ...input(), summary: reference.title, items: [], reference });
    expect(parsed.reference).toEqual(reference);
    const { cwd: _cwd, expectedVersion: _version, ...content } = parsed;
    const stored = parseStoredHandoff({ ...content, updatedAt: "2026-09-09T18:30:00+08:00" });
    expect(stored.reference).toEqual(reference);
    expect(stored.items).toEqual([]);
    expect(hasSavedHandoff(stored)).toBe(true);
    expect(hasPendingHandoff(stored)).toBe(false);
  });

  it("rejects empty, oversized, or unsupported reference fields", () => {
    for (const reference of [
      {}, [], "bookmark",
      { title: " ", reason: "复用解法" },
      { title: "解法", reason: "\n\t" },
      { title: "藏".repeat(201), reason: "复用解法" },
      { title: "解法", reason: "供".repeat(1_001) },
      { title: "解法", reason: "复用解法", transcript: "raw conversation" },
      { title: "解法\0", reason: "复用解法" },
    ]) {
      expect(() => parseUpsertHandoffInput({ ...input(), reference })).toThrow();
    }
  });

  it("distinguishes an omitted reference from an explicit removal and never stores null", () => {
    expect(parseUpsertHandoffInput(input())).not.toHaveProperty("reference");
    const parsed = parseUpsertHandoffInput({ ...input(), reference: null });
    expect(parsed.reference).toBeNull();
    const { cwd: _cwd, expectedVersion: _version, ...content } = parsed;
    expect(() => parseStoredHandoff({ ...content, updatedAt: "2026-09-09T10:30:00Z" })).toThrow();
  });

  it("keeps legacy handoffs valid and separates saved references from unfinished work", () => {
    const { cwd: _cwd, expectedVersion: _version, ...legacy } = parseUpsertHandoffInput(input());
    const pending = parseStoredHandoff({ ...legacy, updatedAt: "2026-09-09T10:30:00Z" });
    expect(pending).not.toHaveProperty("reference");
    expect(hasSavedHandoff(pending)).toBe(true);
    expect(hasPendingHandoff(pending)).toBe(true);
    const finished = { ...pending, items: pending.items.map((item) => ({ ...item, status: "done" as const })) };
    const saved = { ...finished, reference: { title: "保留解法", reason: "相同问题再出现时参考" } };
    expect(hasSavedHandoff(finished)).toBe(false);
    expect(hasSavedHandoff(saved)).toBe(true);
    expect(hasPendingHandoff(saved)).toBe(false);
    expect(hasSavedHandoff(undefined)).toBe(false);
  });

  it("calculates the due time from the actual event, independently for each item", () => {
    const first = input({ anchorAt: "2026-09-09T18:30:00+08:00", delayHours: 24 }).items[0]!;
    const second = { ...first, id: "second", anchorAt: "2026-09-10T09:00:00+08:00", delayHours: 0.5 };
    const parsed = parseUpsertHandoffInput({ ...input(), items: [first, second] });

    expect(parsed.items[0]).toMatchObject({
      anchorAt: "2026-09-09T10:30:00.000Z",
      dueAt: "2026-09-10T10:30:00.000Z",
    });
    expect(parsed.items[1]?.dueAt).toBe("2026-09-10T01:30:00.000Z");
  });

  it("does not use registration or a guessed deadline as a missing relative anchor", () => {
    const parsed = parseUpsertHandoffInput(input({
      delayHours: 24,
      anchorLabel: "上线时间待确认",
      dueAt: "2026-09-10T12:00:00Z",
    }));
    expect(parsed.items[0]).not.toHaveProperty("dueAt");
    expect(parsed.items[0]).not.toHaveProperty("anchorAt");
    expect(parsed.items[0]?.delayHours).toBe(24);
  });

  it("accepts an explicit absolute deadline without a relative duration", () => {
    expect(parseUpsertHandoffInput(input({ dueAt: "2026-09-10T09:00:00+08:00" })).items[0]?.dueAt)
      .toBe("2026-09-10T01:00:00.000Z");
  });

  it.each([
    { anchorAt: "2026-09-09T18:30:00" },
    { anchorAt: "2026-02-29T18:30:00Z" },
    { anchorAt: "2026-09-31T18:30:00Z" },
    { anchorAt: "2026-09-09T24:00:00Z" },
    { anchorAt: "0000-01-01T00:00:00+08:00" },
    { dueAt: "9999-12-31T23:00:00-08:00" },
    { delayHours: -1 },
    { delayHours: Number.POSITIVE_INFINITY },
    { delayHours: Number.MAX_VALUE, anchorAt: "2026-09-09T18:30:00Z" },
    { delayHours: 24, anchorAt: "9999-12-31T18:30:00Z" },
    { anchorAt: "2026-09-09T18:30:00Z", delayHours: 24, dueAt: "2026-09-11T18:30:00Z" },
  ])("rejects ambiguous or inconsistent time metadata: %j", (item) => {
    expect(() => parseUpsertHandoffInput(input(item))).toThrow();
  });

  it("rejects unsupported payloads, duplicate ids, and oversized content", () => {
    expect(() => parseUpsertHandoffInput({ ...input(), transcript: "raw conversation" })).toThrow();
    expect(() => parseUpsertHandoffInput(input({ command: "arbitrary shell command" }))).toThrow();
    expect(() => parseUpsertHandoffInput({ ...input(), items: [input().items[0], input().items[0]] })).toThrow();
    expect(() => parseUpsertHandoffInput({ ...input(), items: Array.from({ length: 21 }, (_, id) => ({ ...input().items[0], id: String(id) })) })).toThrow();
    expect(() => parseUpsertHandoffInput({ ...input(), summary: "a".repeat(1_001) })).toThrow();
    expect(() => parseUpsertHandoffInput(input({ title: "a".repeat(201) }))).toThrow();
    expect(() => parseUpsertHandoffInput(input({ nextAction: "a".repeat(1_001) }))).toThrow();
    expect(() => parseUpsertHandoffInput(input({ condition: "a".repeat(1_001) }))).toThrow();
    expect(() => parseUpsertHandoffInput({ ...input(), cwd: "relative/project" })).toThrow();
  });

  it("accepts clearing all items and treats only pending items as unfinished", () => {
    const parsed = parseUpsertHandoffInput({ ...input(), items: [] });
    const handoff = parseStoredHandoff({
      summary: parsed.summary,
      items: parsed.items,
      source: parsed.source,
      updatedAt: "2026-09-09T18:30:00+08:00",
    });
    expect(handoff.updatedAt).toBe("2026-09-09T10:30:00.000Z");
    expect(hasPendingHandoff(handoff)).toBe(false);
    expect(hasPendingHandoff(undefined)).toBe(false);
    expect(hasPendingHandoff({ ...handoff, items: parseUpsertHandoffInput(input()).items })).toBe(true);
    expect(hasPendingHandoff({ ...handoff, items: parseUpsertHandoffInput(input({ status: "done" })).items })).toBe(false);
  });
});
