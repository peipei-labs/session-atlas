import { afterEach, describe, expect, it, vi } from "vitest";

import { BOARD_GROUPING_STORAGE_KEY, persistBoardGrouping, readBoardGrouping, type BoardGrouping } from "./board-preferences";

afterEach(() => vi.unstubAllGlobals());

describe("board grouping preference", () => {
  it("round-trips only the grouping value without unrelated data", () => {
    const data = new Map<string, string>(), setItem = vi.fn((key: string, value: string) => { data.set(key, value); });
    vi.stubGlobal("window", { localStorage: { getItem: (key: string) => data.get(key) ?? null, setItem } });
    expect(readBoardGrouping()).toBe("project");
    for (const grouping of ["window", "project"] as const) {
      persistBoardGrouping(grouping); expect(readBoardGrouping()).toBe(grouping);
    }
    expect([...data.keys()]).toEqual([BOARD_GROUPING_STORAGE_KEY]);
    expect(setItem.mock.calls).toEqual([[BOARD_GROUPING_STORAGE_KEY, "window"], [BOARD_GROUPING_STORAGE_KEY, "project"]]);
  });

  it.each([null, "", "WINDOW", '"window"', '{"sessionId":"private"}', "invalid"])("ignores malformed stored value %s", (value) => {
    const setItem = vi.fn();
    vi.stubGlobal("window", { localStorage: { getItem: () => value, setItem } });
    expect(readBoardGrouping()).toBe("project");
    persistBoardGrouping(value as BoardGrouping);
    expect(setItem).not.toHaveBeenCalled();
  });

  it("safely falls back when storage access is denied or the browser is absent", () => {
    vi.stubGlobal("window", { get localStorage() { throw new Error("Storage denied"); } });
    expect(readBoardGrouping()).toBe("project"); expect(() => persistBoardGrouping("window")).not.toThrow();
    vi.stubGlobal("window", undefined);
    expect(readBoardGrouping()).toBe("project"); expect(() => persistBoardGrouping("project")).not.toThrow();
  });
});
