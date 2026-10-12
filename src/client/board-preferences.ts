export type BoardGrouping = "project" | "window";

export const BOARD_GROUPING_STORAGE_KEY = "session-atlas.board-grouping.v1";

export function readBoardGrouping(): BoardGrouping {
  try {
    return window.localStorage.getItem(BOARD_GROUPING_STORAGE_KEY) === "window" ? "window" : "project";
  } catch {
    return "project";
  }
}

export function persistBoardGrouping(grouping: BoardGrouping): void {
  if (grouping !== "project" && grouping !== "window") return;
  try {
    window.localStorage.setItem(BOARD_GROUPING_STORAGE_KEY, grouping);
  } catch {
    // A denied storage write must not block grouping changes.
  }
}
