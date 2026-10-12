import { describe, expect, it } from "vitest";

import type { RecoveryRecord, SessionSummary } from "../shared/types";
import { createDemoSnapshot } from "./demo";
import { collectThreadTags, matchesThreadTags, tagKey } from "./thread-tags-model";

const firstId = "01234567-89ab-cdef-8123-456789abcdef";
const secondId = "11234567-89ab-cdef-8123-456789abcdef";
const session = (overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  ...createDemoSnapshot().sessions[0]!, provider: "codex", surface: "legacy", id: "iterm:pane-one",
  conversationId: firstId, recoveryStatus: "recorded", tags: ["React", "排障"], ...overrides,
});
const record = (id: string, tags: string[]): RecoveryRecord => ({
  sessionId: id, tags, cwd: "/tmp/tags", title: "Tag fixture", projectName: "tags", status: "closed",
  firstSeenAt: "2026-09-14T00:00:00Z", lastSeenAt: "2026-09-14T00:00:00Z", resumeCommand: "fixture",
});

describe("thread tag matching", () => {
  it("normalizes compatibility characters and case without changing technical punctuation", () => {
    expect(tagKey(" Ｒｅａｃｔ ")).toBe("react");
    expect(tagKey("C++")).toBe("c++");
    expect(tagKey("C#")).toBe("c#");
  });

  it("requires every selected label and keeps untagged threads when no filter is selected", () => {
    expect(matchesThreadTags(["React", "排障"], ["Ｒｅａｃｔ", "排障"])).toBe(true);
    expect(matchesThreadTags(["React"], ["React", "排障"])).toBe(false);
    expect(matchesThreadTags(undefined, ["React"])).toBe(false);
    expect(matchesThreadTags(undefined, [])).toBe(true);
  });

  it("counts each exact thread once across duplicate panes and recovery records", () => {
    const counts = collectThreadTags([
      session(), session({ id: "iterm:pane-two", tags: ["react", "排障"] }),
      session({ id: secondId, conversationId: undefined, surface: "managed", tags: ["React", "Python"] }),
    ], [record(firstId.toUpperCase(), ["Ｒｅａｃｔ", "排障"]), record(secondId, ["Python"])]);
    expect(new Map(counts.map(({ tag, count }) => [tagKey(tag), count]))).toEqual(new Map([
      ["react", 2], ["排障", 1], ["python", 1],
    ]));
  });

  it("does not assign tags by cwd or count shells and ambiguous identities", () => {
    const counts = collectThreadTags([
      session({ provider: "terminal", conversationId: undefined, tags: ["shell"] }),
      session({ recoveryStatus: "ambiguous", tags: ["ambiguous"] }),
      session({ conversationId: "not-a-uuid", tags: ["invalid"] }),
    ], [record(firstId, ["React"]), record(secondId, ["Python"])]);
    expect(counts).toHaveLength(2);
    expect(counts.every(({ count }) => count === 1)).toBe(true);
  });
});
