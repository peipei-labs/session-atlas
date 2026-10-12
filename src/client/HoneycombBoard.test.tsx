import { describe, expect, it } from "vitest";

import { getHoneyTipPlacement, measureHoneyTipHeight } from "./HoneycombBoard";

const viewport = { width: 1200, height: 800 };
const board = { left: 0, right: 1200, top: 240, bottom: 740 };

describe("board tooltip positioning", () => {
  it("preserves the scrolled button position when measuring an already open long tooltip", () => {
    const tooltip = {
      scrollTop: 413, scrollLeft: 7,
      getBoundingClientRect: () => ({ height: 700 }),
      style: {
        cssText: "max-height: 200px; overflow-y: auto", display: "grid", width: "240px",
        set maxHeight(value: string) { if (value === "none") { tooltip.scrollTop = 0; tooltip.scrollLeft = 0; } },
      },
    };
    expect(measureHoneyTipHeight(tooltip as unknown as HTMLDivElement, 240)).toBe(700);
    expect(tooltip.scrollTop).toBe(413);
    expect(tooltip.scrollLeft).toBe(7);
    expect(tooltip.style.cssText).toBe("max-height: 200px; overflow-y: auto");
  });
  it("opens below the first visible row using the board edge after a tall filter strip", () => {
    const cell = { left: 40, right: 136, top: 265, bottom: 395 };
    const placement = getHoneyTipPlacement(cell, board, 220, viewport);
    expect(placement.below).toBe(true);
    expect(cell.top + placement.style.top).toBe(395);
    expect(cell.top + placement.style.top + 220).toBeLessThanOrEqual(board.bottom - 8);
  });

  it("keeps tips above bottom rows and inside both horizontal edges", () => {
    for (const cell of [
      { left: 4, right: 100, top: 600, bottom: 730 },
      { left: 1110, right: 1190, top: 600, bottom: 730 },
    ]) {
      const placement = getHoneyTipPlacement(cell, board, 220, viewport);
      expect(placement.below).toBe(false);
      expect(cell.top + placement.style.top + 220).toBeLessThanOrEqual(cell.top);
      expect(cell.left + placement.style.left).toBeGreaterThanOrEqual(8);
      expect(cell.left + placement.style.left + placement.style.width).toBeLessThanOrEqual(1192);
    }
  });

  it("constrains multi-line tag content to the visible board on narrow short screens", () => {
    const cell = { left: 280, right: 352, top: 220, bottom: 350 };
    const placement = getHoneyTipPlacement(cell, { left: 0, right: 390, top: 180, bottom: 460 }, 420, { width: 390, height: 500 });
    expect(placement.style.overflowY).toBe("auto");
    expect(placement.style.maxHeight).toBe(102);
    expect(cell.top + placement.style.top).toBe(350);
    expect(cell.left + placement.style.left + placement.style.width).toBeLessThanOrEqual(382);
  });

  it.each([
    { left: 280, right: 352, top: 220, bottom: 350 },
    { left: 280, right: 352, top: 310, bottom: 440 },
  ])("keeps a long tooltip off its originating click target at $top", (cell) => {
    const placement = getHoneyTipPlacement(cell, { left: 0, right: 390, top: 180, bottom: 460 }, 700, { width: 390, height: 500 });
    const top = cell.top + placement.style.top;
    const bottom = top + placement.style.maxHeight;
    expect(placement.below ? top >= cell.bottom : bottom <= cell.top).toBe(true);
    expect(top).toBeGreaterThanOrEqual(188);
    expect(bottom).toBeLessThanOrEqual(452);
  });
});
