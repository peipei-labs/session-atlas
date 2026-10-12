import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getProjectMetadata, validateProjectCwd } from "../project-path.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("project path validation", () => {
  it("accepts existing directories in an allowed root and resolves Git metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "session-atlas-project-"));
    temporaryDirectories.push(directory);
    const root = join(directory, "Code");
    const project = join(root, "demo");
    const nested = join(project, "src");
    await mkdir(join(project, ".git"), { recursive: true });
    await mkdir(nested);
    await writeFile(join(project, ".git", "HEAD"), "ref: refs/heads/feature/atlas\n");

    const canonicalNested = await realpath(nested);
    const canonicalProject = await realpath(project);
    await expect(validateProjectCwd(nested, [root])).resolves.toBe(canonicalNested);
    await expect(getProjectMetadata(nested)).resolves.toEqual({
      projectKey: canonicalProject,
      projectName: "demo",
      branch: "feature/atlas",
    });
  });

  it("does not let blank cwd metadata poison the real current directory cache", async () => {
    await getProjectMetadata("");
    await expect(getProjectMetadata(process.cwd())).resolves.not.toMatchObject({ projectKey: "unknown" });
  });

  it("rejects outside, denied, and symlink-escaped paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "session-atlas-project-"));
    temporaryDirectories.push(directory);
    const root = join(directory, "Code");
    const denied = join(root, "windows_outdated_dev_code");
    const outside = join(directory, "outside");
    await mkdir(denied, { recursive: true });
    await mkdir(outside);
    const escape = join(root, "escape");
    await symlink(outside, escape);

    await expect(validateProjectCwd(outside, [root], [denied])).rejects.toMatchObject({
      code: "PROJECT_PATH_FORBIDDEN",
    });
    await expect(validateProjectCwd(denied, [root], [denied])).rejects.toMatchObject({
      code: "PROJECT_PATH_FORBIDDEN",
    });
    await expect(validateProjectCwd(escape, [root], [denied])).rejects.toMatchObject({
      code: "PROJECT_PATH_FORBIDDEN",
    });
  });
});
