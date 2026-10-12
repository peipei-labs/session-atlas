import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ItermWindowLayoutRecord, SessionAtlasHealth } from "../shared/types";
import { restoreWindowLayout } from "./api";
import { WindowLayoutSection } from "./WindowLayoutSection";

Object.assign(globalThis, { React });

afterEach(() => {
  vi.unstubAllGlobals();
});

const onlineHealth: SessionAtlasHealth = {
  controller: "online",
  codex: "online",
  iterm: "online",
};

function makeLayout(
  overrides: Partial<ItermWindowLayoutRecord> = {},
): ItermWindowLayoutRecord {
  return {
    windowId: "window-1",
    windowIndex: 3,
    status: "closed",
    firstSeenAt: "2026-08-19T00:00:00.000Z",
    lastSeenAt: "2026-08-19T01:00:00.000Z",
    closedAt: "2026-08-19T01:00:00.000Z",
    tabs: [
      {
        tabId: "tab-1",
        tabIndex: 1,
        panes: [
          {
            sessionId: "pane-1",
            title: "session-atlas (codex)",
            cwd: "/tmp/session-atlas",
            jobName: "codex",
            splitPath: [],
          },
        ],
      },
    ],
    ...overrides,
  };
}

function renderSection(
  layouts: ItermWindowLayoutRecord[],
  health: SessionAtlasHealth = onlineHealth,
  onRestore = vi.fn(),
): string {
  return renderToStaticMarkup(
    <WindowLayoutSection
      layouts={layouts}
      health={health}
      busyId={null}
      onRestore={onRestore}
    />,
  );
}

describe("WindowLayoutSection", () => {
  it("enables restore for a closed layout while iTerm is online", () => {
    const markup = renderSection([makeLayout()]);

    expect(markup).toContain('data-testid="layout-section"');
    expect(markup).toContain("窗口 3");
    expect(markup).toContain("1 个标签 · 1 个分屏");
    expect(markup).toContain("session-atlas (codex)");
    const button = markup.match(/<button[^>]*data-testid="layout-restore-button"[^>]*>/)?.[0];
    expect(button).toBeDefined();
    expect(button).not.toContain("disabled");
    expect(markup).toContain("恢复窗口布局");
  });

  it("disables restore and shows the partial notice for an uncertain restore", () => {
    const markup = renderSection([
      makeLayout({
        restoreStatus: "partial",
        restoreMessage: "部分分屏未能恢复",
      }),
    ]);

    const button = markup.match(/<button[^>]*data-testid="layout-restore-button"[^>]*>/)?.[0];
    expect(button).toContain('disabled=""');
    expect(markup).toContain("上次恢复未完全确认");
    expect(markup).toContain("部分分屏未能恢复");
  });

  it("disables every restore button while iTerm is offline", () => {
    const markup = renderSection(
      [makeLayout(), makeLayout({ windowId: "window-2", windowIndex: 4 })],
      { ...onlineHealth, iterm: "offline" },
    );

    const buttons = markup.match(/<button[^>]*data-testid="layout-restore-button"[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button).toContain('disabled=""');
    }
  });

  it("does not render anything without closed layouts", () => {
    expect(renderSection([])).toBe("");
  });
});

describe("restoreWindowLayout api", () => {
  it("posts an empty JSON object to the layout restore route", async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await restoreWindowLayout("window 1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/layouts/window%201/restore");
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{}");
  });

  it("surfaces the server's conflict message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { code: "WINDOW_LAYOUT_RESTORE_UNCERTAIN", message: "上次恢复结果不确定" } }),
            { status: 409 },
          ),
      ),
    );

    await expect(restoreWindowLayout("window-1")).rejects.toMatchObject({
      status: 409,
      message: "上次恢复结果不确定",
    });
  });
});
