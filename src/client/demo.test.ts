import { describe, expect, it } from "vitest";

import { sessionIdentity } from "./attention-model";
import { createDemoSnapshot } from "./demo";
import { groupTerminalTabs } from "./attention-model";

const SHELL_JOB_NAMES = new Set(["bash", "dash", "fish", "nu", "sh", "tcsh", "zsh"]);

describe("Calm Focus Studio demo fixture", () => {
  it("keeps the acceptance inventory truthful and stable", () => {
    const snapshot = createDemoSnapshot();
    const tabs = groupTerminalTabs(snapshot.sessions);
    const shellTabs = tabs.filter((tab) =>
      tab.sessions.every((session) => {
        const jobName = session.terminal?.jobName?.trim().toLocaleLowerCase("en-US");
        return Boolean(jobName && SHELL_JOB_NAMES.has(jobName)) &&
          !/(?:codex|claude)/i.test(session.title);
      }),
    );
    const buried = snapshot.sessions.filter((session) => session.buried);
    const otherWindow = snapshot.sessions.filter(
      (session) =>
        session.surface === "legacy" &&
        !session.buried &&
        session.terminal?.currentWindow === false,
    );
    const staleLegacy = snapshot.sessions.filter(
      (session) => session.surface === "legacy" && session.stale,
    );
    const splitTabs = tabs.filter((tab) => tab.paneCount > 1);
    const identicalCodeTabs = tabs.filter(
      (tab) => sessionIdentity(tab.representative).primary === "Code (codex)",
    );

    expect({
      tabs: tabs.length,
      work: tabs.length - shellTabs.length,
      shells: shellTabs.length,
      buried: buried.length,
      splitTabs: splitTabs.length,
      otherWindow: otherWindow.length,
      staleLegacy: staleLegacy.length,
      identicalCodeTabs: identicalCodeTabs.length,
    }).toEqual({
      tabs: 10,
      work: 9,
      shells: 1,
      buried: 2,
      splitTabs: 1,
      otherWindow: 1,
      staleLegacy: 1,
      identicalCodeTabs: 3,
    });

    expect(identicalCodeTabs.map((tab) => tab.identity.locator)).toEqual(["1·05", "1·06", "1·09"]);
    expect(new Set(identicalCodeTabs.map((tab) => tab.identity.secondary)).size).toBe(3);
    expect(splitTabs[0]?.sessions).toHaveLength(2);
  });

  it("includes closed window layouts for the restore shelf, one of them partial", () => {
    const snapshot = createDemoSnapshot();
    const closed = snapshot.windowLayouts.filter((layout) => layout.status === "closed");

    expect(closed).toHaveLength(2);
    expect(closed.every((layout) => layout.tabs.length > 0)).toBe(true);
    expect(closed.some((layout) => layout.restoreStatus === "partial" && layout.restoreMessage)).toBe(
      true,
    );
    expect(closed.some((layout) => !layout.restoreStatus)).toBe(true);
  });
});
