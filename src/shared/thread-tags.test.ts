import { describe, expect, it } from "vitest";

import { applyThreadTagUpdate, normalizeThreadTag, parseThreadTagUpdate, threadTagKey } from "./thread-tags.js";

describe("thread tags", () => {
  it("normalizes Chinese and compatibility text while retaining stored display spelling", () => {
    expect(normalizeThreadTag("  模型研究  ")).toBe("模型研究");
    expect(normalizeThreadTag(" ＡＩ ")).toBe("AI");
    expect(threadTagKey(" ＡＩ ")).toBe("ai");
    expect(applyThreadTagUpdate(["AI", "量化"], { add: ["ai", " ＡＩ ", "验收"], remove: ["量化"] })).toEqual(["AI", "验收"]);
    expect(applyThreadTagUpdate(["AI"], { add: ["ai"], remove: ["不存在"] })).toEqual(["AI"]);
  });

  it("counts Unicode code points rather than UTF-16 units", () => {
    expect(normalizeThreadTag("🧪".repeat(40))).toBe("🧪".repeat(40));
    expect(() => normalizeThreadTag("🧪".repeat(41))).toThrow("40");
  });

  it.each(["", "   ", "a\nb", "\t标签", "\u0000", "\u0085", "a\u200bb", "a\u2028b", "a\u2029b"])("rejects empty or hidden-control labels: %j", (tag) => {
    expect(() => normalizeThreadTag(tag)).toThrow();
  });

  it.each([null, [], {}, { add: [] }, { remove: [] }, { tags: ["x"] }, { add: "x" }, { add: [1] },
    { add: Array.from({ length: 13 }, () => "same") }, { remove: Array.from({ length: 13 }, () => "same") },
    { add: [" AI "], remove: ["ａｉ"] }])("rejects invalid or conflicting patch %j", (patch) => {
    expect(() => parseThreadTagUpdate(patch)).toThrow();
  });

  it("limits the resulting set while allowing removal and replacement at capacity", () => {
    const current = Array.from({ length: 12 }, (_, index) => `标签${index}`);
    expect(() => applyThreadTagUpdate(current, { add: ["第十三个"] })).toThrow("12");
    expect(applyThreadTagUpdate(current, { add: ["替代"], remove: ["标签0"] })).toEqual([...current.slice(1), "替代"]);
    expect(applyThreadTagUpdate(["AI"], { remove: ["ai"] })).toEqual([]);
  });
});
