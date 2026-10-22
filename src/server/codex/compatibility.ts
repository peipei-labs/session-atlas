import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import { baseline } from "./compatibility-baseline.js";
import { changedContractPaths, contractSignatures, ContractShapeError } from "./compatibility-contract.js";

const exec = promisify(execFile);
export interface CompatibilityResult {
  executable: string;
  version?: string;
  compatible: boolean;
  reason?: string;
}
export interface CompatibilityOptions {
  executable?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}
const cache = new Map<string, CompatibilityResult>();

async function executablePath(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const paths = command.includes("/") ? [resolve(cwd, command)]
    : (env.PATH ?? "").split(delimiter).map((directory) => resolve(cwd, directory, command));
  for (const path of paths) {
    try { await access(path, constants.X_OK); return await realpath(path); } catch { /* Try the next PATH entry. */ }
  }
  throw new Error("Executable unavailable");
}
async function identity(executable: string): Promise<string> {
  const info = await stat(executable, { bigint: true });
  return `${executable}:${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

export async function probeCodexCompatibility(options: CompatibilityOptions = {}): Promise<CompatibilityResult> {
  const cwd = options.cwd ?? process.cwd();
  const env = { ...process.env, ...options.env };
  let executable = options.executable ?? "codex";
  let version: string | undefined;
  let directory: string | undefined;
  let phase = "executable lookup";
  try {
    executable = await executablePath(executable, cwd, env);
    const before = await identity(executable);
    phase = "version probe";
    const { stdout } = await exec(executable, ["--version"], { cwd, env, timeout: 5_000, maxBuffer: 64 * 1024 });
    version = /^codex-cli (\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\s*$/.exec(stdout.trim())?.[1];
    if (!version) return { executable, compatible: false, reason: "Codex version could not be identified." };
    const key = `${before}:${version}`;
    const cached = cache.get(key);
    if (cached) {
      if (before !== await identity(executable)) return { executable, version, compatible: false, reason: "Codex changed during compatibility detection; reconnect to retry." };
      return { ...cached };
    }
    phase = "schema generation";
    directory = await mkdtemp(join(tmpdir(), "session-atlas-protocol-"));
    await exec(executable, ["app-server", "generate-json-schema", "--experimental", "--out", directory], {
      cwd, env, timeout: 20_000, maxBuffer: 1024 * 1024,
    });
    phase = "schema validation";
    const bundle = JSON.parse(await readFile(join(directory, "codex_app_server_protocol.schemas.json"), "utf8"));
    const changes = changedContractPaths(baseline, contractSignatures(bundle));
    if (before !== await identity(executable)) {
      return { executable, version, compatible: false, reason: "Codex changed during compatibility detection; reconnect to retry." };
    }
    const result: CompatibilityResult = {
      executable, version, compatible: changes.length === 0,
      ...(changes.length ? { reason: `Codex protocol differs from the verified contract at ${changes.slice(0, 3).join(", ")}${changes.length > 3 ? ` (${changes.length} differences)` : ""}.` } : {}),
    };
    // Keep only successful process-local checks. A transient failure must be retried on reconnect.
    if (result.compatible) {
      if (cache.size >= 8) cache.delete(cache.keys().next().value!);
      cache.set(key, { ...result });
    }
    return result;
  } catch (error) {
    return { executable, version, compatible: false, reason: error instanceof ContractShapeError ? error.message : `Codex compatibility ${phase} failed; writes remain disabled.` };
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
