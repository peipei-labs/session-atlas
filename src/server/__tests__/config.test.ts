import { delimiter, join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig } from "../config.js";

describe("loadConfig", () => {
  it("supports multiple allowed project roots", () => {
    const homeDir = "/Users/example";
    const config = loadConfig({
      homeDir,
      projectDir: "/opt/session-atlas",
      env: {
        NODE_ENV: "production",
        SESSION_ATLAS_PROJECT_ROOTS: ["/work/one", "/work/two"].join(delimiter),
      },
    });

    expect(config.allowedProjectRoots).toEqual(["/work/one", "/work/two"]);
    expect(config.staticDir).toBe("/opt/session-atlas/dist/client");
    expect(config.host).toBe("127.0.0.1");
    expect(config.development).toBe(false);
    expect(config.autoResumeEnabled).toBe(false);
  });

  it("keeps the singular setting as a compatibility fallback", () => {
    const config = loadConfig({
      homeDir: "/Users/example",
      projectDir: "/opt/session-atlas",
      env: { SESSION_ATLAS_PROJECT_ROOT: "/legacy/root" },
    });
    expect(config.allowedProjectRoots).toEqual(["/legacy/root"]);
    expect(config.attentionStateFile).toBe(
      join("/Users/example", "Library", "Application Support", "SessionAtlas", "state.json"),
    );
    expect(config.recoveryStateFile).toBe(
      join("/Users/example", "Library", "Application Support", "SessionAtlas", "recovery.json"),
    );
  });

  it("rejects invalid ports", () => {
    expect(() =>
      loadConfig({
        homeDir: "/Users/example",
        projectDir: "/opt/session-atlas",
        env: { SESSION_ATLAS_PORT: "70000" },
      }),
    ).toThrow("SESSION_ATLAS_PORT");
  });

  it("enables installed automatic recovery only through the explicit setting", () => {
    expect(
      loadConfig({
        homeDir: "/Users/example",
        projectDir: "/opt/session-atlas",
        env: { SESSION_ATLAS_AUTO_RESUME: "1" },
      }).autoResumeEnabled,
    ).toBe(true);
    expect(() =>
      loadConfig({
        homeDir: "/Users/example",
        projectDir: "/opt/session-atlas",
        env: { SESSION_ATLAS_AUTO_RESUME: "sometimes" },
      }),
    ).toThrow("SESSION_ATLAS_AUTO_RESUME");
  });
});
