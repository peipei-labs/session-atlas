import { describe, expect, it } from "vitest";

import type { ItermWindowLayoutRecord, SessionSummary } from "../shared/types";
import { EMPTY_CAPABILITIES } from "../shared/types";
import {
  buildAttentionQueue,
  buildNavigationQueue,
  chooseInitialSessionId,
  continuityLaneLabel,
  deriveContinuityLane,
  displaySessionName,
  findClosedWindowLayouts,
  groupContinuityLanes,
  groupSessionsByProject,
  groupSessionsByWindow,
  isLayoutRestorable,
  sessionIdentity,
} from "./attention-model";
import { groupTerminalTabs } from "./attention-model";

function makeSession(
  id: string,
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    id,
    provider: "codex",
    surface: "legacy",
    title: id,
    cwd: `/Users/demo/Code/${id}`,
    projectKey: id,
    projectName: id,
    activityState: "idle",
    attentionReason: null,
    lastActivityAt: "2026-08-23T00:00:00.000Z",
    observedAt: "2026-08-23T00:00:00.000Z",
    stale: false,
    activities: [],
    capabilities: { ...EMPTY_CAPABILITIES },
    pinned: false,
    parked: false,
    ...overrides,
  };
}

describe("deriveContinuityLane", () => {
  it("classifies all four continuity lanes and keeps unavailable work for later", () => {
    expect(deriveContinuityLane(makeSession("approval", { activityState: "awaiting_approval" }))).toBe(
      "attention",
    );
    expect(deriveContinuityLane(makeSession("failed", { activityState: "failed" }))).toBe(
      "attention",
    );
    expect(deriveContinuityLane(makeSession("running", { activityState: "running" }))).toBe(
      "running",
    );
    expect(deriveContinuityLane(makeSession("idle"))).toBe("returnable");
    expect(
      deriveContinuityLane(
        makeSession("parked-attention", {
          parked: true,
          attentionReason: "needs_input",
        }),
      ),
    ).toBe("later");
    expect(
      deriveContinuityLane(
        makeSession("stale-running", { stale: true, activityState: "running" }),
      ),
    ).toBe("later");
    expect(
      deriveContinuityLane(
        makeSession("offline-attention", {
          activityState: "offline",
          attentionReason: "failed",
        }),
      ),
    ).toBe("later");
    expect(
      deriveContinuityLane(
        makeSession("buried-running", {
          buried: true,
          activityState: "running",
        }),
      ),
    ).toBe("later");
  });

  it("uses concise Chinese labels", () => {
    expect([
      continuityLaneLabel("attention"),
      continuityLaneLabel("running"),
      continuityLaneLabel("returnable"),
      continuityLaneLabel("later"),
    ]).toEqual(["等待你", "后台推进", "可随时返回", "稍后"]);
  });
});

describe("displaySessionName", () => {
  it("uses the cleaned real terminal title as the primary name and keeps project separate", () => {
    const legacy = makeSession("legacy", {
      title: "  ⠙  Code (codex) ",
      projectName: "project-catalog",
      cwd: "/Users/demo/Code/Workstation/project-catalog",
      terminal: { tty: "/dev/ttys041" },
    });
    const managed = makeSession("managed", {
      surface: "managed",
      title: "Implement the plan",
      projectName: "session-atlas",
    });

    expect(displaySessionName(legacy)).toBe("Code (codex)");
    expect(sessionIdentity(legacy)).toMatchObject({
      primary: "Code (codex)",
      secondary: "Workstation/project-catalog",
      tty: "ttys041",
    });
    expect(displaySessionName(managed)).toBe("Implement the plan");
    expect(sessionIdentity(managed).secondary).toBe("session-atlas");
  });

  it("keeps identically titled tabs distinguishable through project, tab, and TTY identity", () => {
    const sessions = [
      ["one", "test-runner", 1, "ttys021"],
      ["two", "session-atlas", 2, "ttys022"],
      ["three", "project-catalog", 3, "ttys023"],
    ].map(([id, projectName, tabIndex, tty]) =>
      makeSession(String(id), {
        title: "⠋ Code (codex)",
        projectName: String(projectName),
        cwd: `/Users/demo/Code/${projectName}`,
        terminal: {
          tty: `/dev/${tty}`,
          windowId: "window-1",
          tabId: `tab-${tabIndex}`,
          windowIndex: 1,
          tabIndex: Number(tabIndex),
          tabCount: 3,
          paneIndex: 1,
          paneCount: 1,
          currentWindow: true,
        },
      }),
    );
    const identities = sessions.map(sessionIdentity);

    expect(identities.map((identity) => identity.primary)).toEqual([
      "Code (codex)",
      "Code (codex)",
      "Code (codex)",
    ]);
    expect(identities.map((identity) => identity.secondary)).toEqual([
      "Code/test-runner",
      "Code/session-atlas",
      "Code/project-catalog",
    ]);
    expect(identities.map((identity) => identity.locator)).toEqual([
      "1·01",
      "1·02",
      "1·03",
    ]);
  });

  it("prefixes the locator with the window index only when a tab number exists", () => {
    expect(
      sessionIdentity(
        makeSession("tabbed", {
          terminal: { windowId: "w2", windowIndex: 2, tabIndex: 4, currentWindow: false },
        }),
      ).locator,
    ).toBe("2·04");
    expect(
      sessionIdentity(makeSession("tabbed-no-window", { terminal: { tabIndex: 4 } })).locator,
    ).toBe("04");
  });

  it("distinguishes same-title panes in one tab and provides a complete readable location", () => {
    const identities = [1, 3].map((paneIndex) => sessionIdentity(makeSession(`pane-${paneIndex}`, {
      title: "数据处理", terminal: { windowIndex: 2, tabIndex: 5, paneIndex, paneCount: 3 },
    })));
    expect(identities.map((identity) => identity.locator)).toEqual(["2·05/P1", "2·05/P3"]);
    expect(identities.map((identity) => identity.fullLocator)).toEqual(["窗口 2 · Tab 5 · 分屏 1", "窗口 2 · Tab 5 · 分屏 3"]);
    expect(sessionIdentity(makeSession("unknown-count", { terminal: { tabIndex: 5, paneIndex: 3 } })).locator).toBe("05/P3");
    expect(sessionIdentity(makeSession("single", { terminal: { windowIndex: 2, tabIndex: 5, paneIndex: 1, paneCount: 1 } }))).toMatchObject({
      locator: "2·05", fullLocator: "窗口 2 · Tab 5 · 分屏 1",
    });
  });

  it("maps only real iTerm numeric shortcuts across a ten-tab window", () => {
    const shortcuts = Array.from({ length: 10 }, (_, index) =>
      sessionIdentity(
        makeSession(`tab-${index + 1}`, {
          terminal: {
            tabIndex: index + 1,
            tabCount: 10,
            paneIndex: 1,
            paneCount: 1,
            currentWindow: true,
          },
        }),
      ).shortcut,
    );

    expect(shortcuts).toEqual([
      "⌘1",
      "⌘2",
      "⌘3",
      "⌘4",
      "⌘5",
      "⌘6",
      "⌘7",
      "⌘8",
      undefined,
      "⌘9 · LAST",
    ]);
  });

  it("does not invent a tab number without hierarchy metadata", () => {
    const identity = sessionIdentity(
      makeSession("plain", {
        title: "Plain shell",
        terminal: { tty: "/dev/ttys099" },
      }),
    );

    expect(identity.tabIndex).toBeUndefined();
    expect(identity.shortcut).toBeUndefined();
    expect(identity.hasHierarchy).toBe(false);
    expect(identity.locator).toBe("ttys099");
    expect(identity.fullLocator).toBe("ttys099");
  });

  it("falls back through cwd, tty, title, and a short id for unknown projects", () => {
    expect(
      displaySessionName(
        makeSession("cwd", {
          projectName: " Unknown project ",
          cwd: "/Users/demo/Code/alpha/",
          terminal: { tty: "/dev/ttys020" },
          title: "Terminal",
        }),
      ),
    ).toBe("alpha");
    expect(
      displaySessionName(
        makeSession("tty", {
          projectName: "Unknown project",
          cwd: "",
          terminal: { tty: "/dev/ttys021" },
          title: "Terminal",
        }),
      ),
    ).toBe("ttys021");
    expect(
      displaySessionName(
        makeSession("title", {
          projectName: "Unknown project",
          cwd: "",
          title: "Plain shell",
        }),
      ),
    ).toBe("Plain shell");
    expect(
      displaySessionName(
        makeSession("1234567890abcdefghijkl", {
          projectName: "Unknown project",
          cwd: "",
          title: "",
        }),
      ),
    ).toBe("iTerm · 1234567890ab…");
  });

  it("keeps otherwise unknown legacy terminals distinguishable", () => {
    const first = makeSession("legacy-a", {
      projectName: "Unknown project",
      cwd: "",
      title: "Shell",
      terminal: { tty: "/dev/ttys021" },
    });
    const second = makeSession("legacy-b", {
      projectName: "Unknown project",
      cwd: "",
      title: "Shell",
      terminal: { tty: "/dev/ttys022" },
    });

    expect(displaySessionName(first)).toBe("ttys021");
    expect(displaySessionName(second)).toBe("ttys022");
  });

  it("uses a stable terminal identity when iTerm reports no path, tty, or useful name", () => {
    const first = makeSession("iterm:first", {
      projectName: "Unknown project",
      cwd: "",
      title: "iTerm session",
      terminalSessionId: "00000001-0000-4000-8000-000000000001",
    });
    const second = makeSession("iterm:second", {
      projectName: "Unknown project",
      cwd: "",
      title: "iTerm session",
      terminalSessionId: "00000002-0000-4000-8000-000000000002",
    });

    expect(displaySessionName(first)).toBe("iTerm · 00000001-000…");
    expect(displaySessionName(second)).toBe("iTerm · 00000002-000…");
  });
});

describe("terminal tab grouping", () => {
  it("uses current-window tab order and combines split panes under the focused representative", () => {
    const firstPane = makeSession("pane-1", {
      title: "Build server",
      terminal: {
        windowId: "window-1",
        tabId: "tab-2",
        windowIndex: 1,
        tabIndex: 2,
        tabCount: 2,
        paneIndex: 1,
        paneCount: 2,
        currentWindow: true,
        tty: "/dev/ttys030",
      },
    });
    const focusedPane = makeSession("pane-2", {
      title: "Watch tests",
      focused: true,
      terminal: {
        windowId: "window-1",
        tabId: "tab-2",
        windowIndex: 1,
        tabIndex: 2,
        tabCount: 2,
        paneIndex: 2,
        paneCount: 2,
        currentWindow: true,
        tty: "/dev/ttys031",
      },
    });
    const firstTab = makeSession("tab-1", {
      title: "Notes",
      terminal: {
        windowId: "window-1",
        tabId: "tab-1",
        windowIndex: 1,
        tabIndex: 1,
        tabCount: 2,
        paneIndex: 1,
        paneCount: 1,
        currentWindow: true,
      },
    });
    const otherWindow = makeSession("other-window", {
      terminal: {
        windowId: "window-2",
        tabId: "tab-1",
        windowIndex: 2,
        tabIndex: 1,
        tabCount: 1,
        paneIndex: 1,
        paneCount: 1,
        currentWindow: false,
      },
    });
    const buried = makeSession("buried", { buried: true });

    const groups = groupTerminalTabs([
      firstPane,
      otherWindow,
      focusedPane,
      buried,
      firstTab,
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.tabIndex)).toEqual([1, 2]);
    expect(groups[1]).toMatchObject({
      representative: { id: "pane-2" },
      paneCount: 2,
      focused: true,
    });
    expect(groups[1]?.sessions.map((session) => session.id)).toEqual(["pane-2", "pane-1"]);
  });

  it("keeps older visible sessions but leaves their tab index absent", () => {
    const groups = groupTerminalTabs([
      makeSession("legacy-b", { terminal: { tty: "/dev/ttys052" } }),
      makeSession("legacy-a", { terminal: { tty: "/dev/ttys051" } }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.every((group) => group.tabIndex === undefined)).toBe(true);
  });
});

describe("attention and navigation queues", () => {
  it("prioritizes pinned attention, then approval, question, failure, and completion", () => {
    const sessions = [
      makeSession("completed", { attentionReason: "newly_completed" }),
      makeSession("failed", { attentionReason: "failed" }),
      makeSession("question", { attentionReason: "needs_input" }),
      makeSession("approval", { attentionReason: "needs_approval" }),
      makeSession("pinned-completed", {
        attentionReason: "newly_completed",
        pinned: true,
      }),
    ];

    expect(buildAttentionQueue(sessions, 5).map((session) => session.id)).toEqual([
      "pinned-completed",
      "approval",
      "question",
      "failed",
      "completed",
    ]);
  });

  it("uses managed activity time only within the same attention priority", () => {
    const managedOld = makeSession("managed-old", {
      surface: "managed",
      attentionReason: "needs_input",
      lastActivityAt: "2026-08-23T01:00:00.000Z",
    });
    const managedNew = makeSession("managed-new", {
      surface: "managed",
      attentionReason: "needs_input",
      lastActivityAt: "2026-08-23T02:00:00.000Z",
    });

    expect(buildAttentionQueue([managedOld, managedNew]).map((session) => session.id)).toEqual([
      "managed-new",
      "managed-old",
    ]);
  });

  it("keeps legacy attention stable while grouping managed recency deterministically", () => {
    const sessions = [
      makeSession("zulu-legacy", {
        attentionReason: "needs_input",
        observedAt: "2030-01-01T00:00:00.000Z",
      }),
      makeSession("managed-old", {
        surface: "managed",
        attentionReason: "needs_input",
        lastActivityAt: "2026-08-23T01:00:00.000Z",
      }),
      makeSession("alpha-legacy", {
        attentionReason: "needs_input",
        observedAt: "2020-01-01T00:00:00.000Z",
      }),
      makeSession("managed-new", {
        surface: "managed",
        attentionReason: "needs_input",
        lastActivityAt: "2026-08-23T02:00:00.000Z",
      }),
    ];

    expect(buildAttentionQueue(sessions).map((session) => session.id)).toEqual([
      "managed-new",
      "managed-old",
      "alpha-legacy",
      "zulu-legacy",
    ]);
  });

  it("returns no attention items for nineteen idle legacy sessions", () => {
    const sessions = Array.from({ length: 19 }, (_, index) =>
      makeSession(`legacy-${String(index + 1).padStart(2, "0")}`),
    );

    expect(buildAttentionQueue(sessions)).toEqual([]);
    expect(buildNavigationQueue(sessions)).toHaveLength(19);
  });

  it("keeps non-attention sessions grouped for navigation without promoting them", () => {
    const sessions = [
      makeSession("returnable-zulu"),
      makeSession("later", { parked: true, focused: true }),
      makeSession("returnable-alpha", { pinned: true }),
      makeSession("running", { activityState: "running" }),
    ];

    expect(buildAttentionQueue(sessions)).toEqual([]);
    expect(buildNavigationQueue(sessions).map((session) => session.id)).toEqual([
      "running",
      "returnable-alpha",
      "returnable-zulu",
      "later",
    ]);
  });

  it("places queue entries first and de-duplicates navigation by id", () => {
    const approval = makeSession("approval", { attentionReason: "needs_approval" });
    const running = makeSession("running", { activityState: "running" });
    const sessions = [running, approval, approval, makeSession("idle")];

    expect(buildNavigationQueue(sessions).map((session) => session.id)).toEqual([
      "approval",
      "running",
      "idle",
    ]);
  });

  it("does not treat a legacy bridge observation as recent activity", () => {
    const alpha = makeSession("alpha", {
      attentionReason: "needs_input",
      observedAt: "2026-08-23T00:00:00.000Z",
      lastActivityAt: "2026-08-23T00:00:00.000Z",
    });
    const zulu = makeSession("zulu", {
      attentionReason: "needs_input",
      observedAt: "2026-08-23T23:59:59.000Z",
      lastActivityAt: "2026-08-23T23:59:59.000Z",
    });

    expect(buildAttentionQueue([zulu, alpha]).map((session) => session.id)).toEqual([
      "alpha",
      "zulu",
    ]);
    expect(
      buildAttentionQueue([
        { ...zulu, observedAt: "2024-01-01T00:00:00.000Z" },
        { ...alpha, observedAt: "2030-01-01T00:00:00.000Z" },
      ]).map((session) => session.id),
    ).toEqual(["alpha", "zulu"]);
  });
});

describe("initial selection and grouping", () => {
  it("chooses persisted, then attention, then focused, then pinned, then stable", () => {
    const sessions = [
      makeSession("zulu", { focused: true }),
      makeSession("approval", { attentionReason: "needs_approval" }),
      makeSession("alpha", { pinned: true }),
    ];

    expect(chooseInitialSessionId(sessions, "alpha")).toBe("alpha");
    expect(chooseInitialSessionId(sessions, "missing")).toBe("approval");
    expect(chooseInitialSessionId(sessions.filter((session) => !session.attentionReason))).toBe(
      "zulu",
    );
    expect(chooseInitialSessionId(sessions.filter((session) => !session.focused))).toBe("approval");
    expect(chooseInitialSessionId([makeSession("zulu"), makeSession("alpha", { pinned: true })])).toBe(
      "alpha",
    );
    expect(chooseInitialSessionId([makeSession("zulu"), makeSession("alpha")])).toBe("alpha");
  });

  it("returns every lane with all sessions in stable order", () => {
    const groups = groupContinuityLanes([
      makeSession("return-zulu"),
      makeSession("later", { parked: true }),
      makeSession("running", { activityState: "running" }),
      makeSession("return-alpha"),
      makeSession("attention", { attentionReason: "needs_input" }),
    ]);

    expect(Object.keys(groups)).toEqual(["attention", "running", "returnable", "later"]);
    expect(groups.attention.map((session) => session.id)).toEqual(["attention"]);
    expect(groups.running.map((session) => session.id)).toEqual(["running"]);
    expect(groups.returnable.map((session) => session.id)).toEqual([
      "return-alpha",
      "return-zulu",
    ]);
    expect(groups.later.map((session) => session.id)).toEqual(["later"]);
  });

  it("clusters sessions by iTerm window with unlocated sessions last", () => {
    const clusters = groupSessionsByWindow([
      makeSession("w2-idle", {
        terminal: { windowId: "window-2", windowIndex: 2, tabIndex: 1, currentWindow: false },
      }),
      makeSession("w1-running", {
        activityState: "running",
        terminal: { windowId: "window-1", windowIndex: 1, tabIndex: 2, currentWindow: true },
      }),
      makeSession("w1-attention", {
        attentionReason: "needs_input",
        terminal: { windowId: "window-1", windowIndex: 1, tabIndex: 1, currentWindow: true },
      }),
      makeSession("no-window", {}),
    ]);

    expect(clusters.map((cluster) => cluster.name)).toEqual([
      "窗口 1",
      "窗口 2",
      "未定位窗口",
    ]);
    expect(clusters[0]?.sessions.map((session) => session.id)).toEqual([
      "w1-attention",
      "w1-running",
    ]);
    expect(clusters[0]?.urgency).toBe("attention");
    expect(clusters[1]?.urgency).toBe("returnable");
  });

  it("keeps physical tab/pane order across activity, focus and pin changes while retaining project priority", () => {
    const at = (id: string, tabIndex: number, paneIndex: number, overrides: Partial<SessionSummary> = {}) => makeSession(id, {
      projectKey: "project", terminal: { windowId: "window-2", windowIndex: 2, tabIndex, paneIndex }, ...overrides,
    });
    const source = [at("pane-3", 1, 3, { attentionReason: "needs_input" }), at("tab-2", 2, 1, { activityState: "running", focused: true }), at("pane-1", 1, 1)];
    const originalOrder = source.map((session) => session.id);
    const cluster = groupSessionsByWindow(source)[0]!;
    expect(cluster.sessions.map((session) => session.id)).toEqual(["pane-1", "pane-3", "tab-2"]);
    expect(cluster.urgency).toBe("attention");
    const changed = source.map((session) => ({ ...session, activityState: "idle" as const, attentionReason: null, focused: !session.focused, pinned: !session.pinned }));
    expect(groupSessionsByWindow(changed)[0]!.sessions.map((session) => session.id)).toEqual(["pane-1", "pane-3", "tab-2"]);
    expect(groupSessionsByProject(source)[0]!.sessions.map((session) => session.id)).toEqual(["pane-3", "tab-2", "pane-1"]);
    expect(source.map((session) => session.id)).toEqual(originalOrder);
  });

  it("orders numeric windows and recovers a group's known index from any member", () => {
    const groups = groupSessionsByWindow([
      makeSession("w10", { terminal: { windowId: "window-10", windowIndex: 10, tabIndex: 1 } }),
      makeSession("w2-incomplete", { terminal: { windowId: "window-2" } }),
      makeSession("unlocated"),
      makeSession("w2", { terminal: { windowId: "window-2", windowIndex: 2, tabIndex: 1, paneIndex: 1 } }),
    ]);
    expect(groups.map((group) => group.name)).toEqual(["窗口 2", "窗口 10", "未定位窗口"]);
    expect(groups[0]!.sessions.map((session) => session.id)).toEqual(["w2", "w2-incomplete"]);
  });
});

describe("window layout restore gating", () => {
  const onlineHealth = {
    controller: "online",
    codex: "online",
    iterm: "online",
  } as const;

  function makeLayout(
    overrides: Partial<ItermWindowLayoutRecord> = {},
  ): ItermWindowLayoutRecord {
    return {
      windowId: "window-1",
      status: "closed",
      firstSeenAt: "2026-08-19T00:00:00.000Z",
      lastSeenAt: "2026-08-19T01:00:00.000Z",
      closedAt: "2026-08-19T01:00:00.000Z",
      tabs: [],
      ...overrides,
    };
  }

  it("allows restoring a closed layout only while iTerm is online", () => {
    expect(isLayoutRestorable(makeLayout(), onlineHealth)).toBe(true);
    expect(isLayoutRestorable(makeLayout({ status: "active" }), onlineHealth)).toBe(false);
    expect(isLayoutRestorable(makeLayout({ restoreStatus: "partial" }), onlineHealth)).toBe(false);
    expect(isLayoutRestorable(makeLayout({ createdWindowId: "new-window" }), onlineHealth)).toBe(
      false,
    );
    expect(
      isLayoutRestorable(makeLayout(), { ...onlineHealth, iterm: "offline" }),
    ).toBe(false);
  });

  it("lists only closed layouts, newest closure first", () => {
    const older = makeLayout({ windowId: "older", closedAt: "2026-08-19T00:30:00.000Z" });
    const newer = makeLayout({ windowId: "newer", closedAt: "2026-08-19T01:30:00.000Z" });
    const active = makeLayout({ windowId: "active", status: "active" });

    expect(findClosedWindowLayouts([older, active, newer])).toEqual([newer, older]);
    expect(findClosedWindowLayouts([])).toEqual([]);
  });
});
