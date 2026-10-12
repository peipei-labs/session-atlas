import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { AppError } from "./errors.js";

export interface ProjectMetadata {
  projectKey: string;
  projectName: string;
  branch?: string;
}

const PROJECT_METADATA_CACHE_MS = 10_000;
const projectMetadataCache = new Map<
  string,
  { expiresAt: number; promise: Promise<ProjectMetadata> }
>();

export function isPathInside(candidate: string, root: string): boolean {
  const pathFromRoot = relative(resolve(root), resolve(candidate));
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..");
}

export async function validateProjectCwd(
  requestedCwd: string,
  allowedProjectRoots: readonly string[],
  deniedProjectRoots: readonly string[] = [],
): Promise<string> {
  if (!isAbsolute(requestedCwd)) {
    throw new AppError(400, "INVALID_PROJECT_PATH", "Project cwd must be an absolute path.");
  }

  let canonicalCwd: string;
  let canonicalRoots: string[];
  try {
    canonicalCwd = await realpath(requestedCwd);
    canonicalRoots = await Promise.all(allowedProjectRoots.map((root) => realpath(root)));
    const details = await stat(canonicalCwd);
    if (!details.isDirectory()) {
      throw new AppError(400, "INVALID_PROJECT_PATH", "Project cwd must be a directory.");
    }
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(400, "INVALID_PROJECT_PATH", "Project cwd does not exist.", {
      cause: error,
    });
  }

  if (!canonicalRoots.some((root) => isPathInside(canonicalCwd, root))) {
    throw new AppError(
      403,
      "PROJECT_PATH_FORBIDDEN",
      "Project cwd is outside the configured project root.",
    );
  }

  for (const deniedRoot of deniedProjectRoots) {
    let canonicalDeniedRoot = resolve(deniedRoot);
    try {
      canonicalDeniedRoot = await realpath(deniedRoot);
    } catch {
      // A missing denied path is still compared in resolved form.
    }
    if (isPathInside(canonicalCwd, canonicalDeniedRoot)) {
      throw new AppError(403, "PROJECT_PATH_FORBIDDEN", "Project cwd is read-only.");
    }
  }

  return canonicalCwd;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function findGitRoot(cwd: string): Promise<string | undefined> {
  let current = cwd;
  while (true) {
    if (await pathExists(join(current, ".git"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

async function resolveGitDirectory(projectRoot: string): Promise<string | undefined> {
  const dotGit = join(projectRoot, ".git");
  try {
    const details = await lstat(dotGit);
    if (details.isDirectory()) {
      return dotGit;
    }
    if (!details.isFile()) {
      return undefined;
    }

    const pointer = (await readFile(dotGit, "utf8")).trim();
    const match = /^gitdir:\s*(.+)$/i.exec(pointer);
    if (!match?.[1]) {
      return undefined;
    }
    return resolve(projectRoot, match[1]);
  } catch {
    return undefined;
  }
}

async function readBranch(projectRoot: string): Promise<string | undefined> {
  const gitDirectory = await resolveGitDirectory(projectRoot);
  if (!gitDirectory) {
    return undefined;
  }

  try {
    const head = (await readFile(join(gitDirectory, "HEAD"), "utf8")).trim();
    const branchPrefix = "ref: refs/heads/";
    if (head.startsWith(branchPrefix)) {
      return head.slice(branchPrefix.length);
    }
    return head.length >= 7 ? head.slice(0, 7) : undefined;
  } catch {
    return undefined;
  }
}

async function readProjectMetadata(cwd: string): Promise<ProjectMetadata> {
  if (!cwd.trim()) {
    return { projectKey: "unknown", projectName: "Unknown project" };
  }
  let canonicalCwd = resolve(cwd);
  try {
    canonicalCwd = await realpath(cwd);
  } catch {
    // Legacy terminal sessions may report a directory that has since disappeared.
  }

  const projectRoot = (await findGitRoot(canonicalCwd)) ?? canonicalCwd;
  return {
    projectKey: projectRoot,
    projectName: basename(projectRoot) || projectRoot,
    branch: await readBranch(projectRoot),
  };
}

export async function getProjectMetadata(cwd: string): Promise<ProjectMetadata> {
  if (!cwd.trim()) return { projectKey: "unknown", projectName: "Unknown project" };
  const key = resolve(cwd || ".");
  const now = Date.now();
  const cached = projectMetadataCache.get(key);
  if (cached && cached.expiresAt > now) {
    return { ...(await cached.promise) };
  }
  const promise = readProjectMetadata(cwd);
  projectMetadataCache.set(key, { expiresAt: now + PROJECT_METADATA_CACHE_MS, promise });
  try {
    return { ...(await promise) };
  } catch (error) {
    if (projectMetadataCache.get(key)?.promise === promise) {
      projectMetadataCache.delete(key);
    }
    throw error;
  }
}
