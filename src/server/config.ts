import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

export interface ServerConfig {
  host: "127.0.0.1";
  port: number;
  development: boolean;
  allowedProjectRoots: string[];
  deniedProjectRoots: string[];
  applicationSupportDir: string;
  attentionStateFile: string;
  recoveryStateFile: string;
  itermSocketPath: string;
  staticDir: string;
  maxJsonBytes: number;
  staleAfterMs: number;
  autoResumeEnabled: boolean;
}

export interface ConfigOverrides extends Partial<ServerConfig> {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  projectDir?: string;
}

const DEFAULT_PORT = 4317;
const DEFAULT_MAX_JSON_BYTES = 64 * 1024;
const DEFAULT_STALE_AFTER_MS = 45_000;

function booleanSetting(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value === "") return fallback;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  throw new Error(`${name} must be one of: 1, 0, true, false.`);
}

function integerSetting(
  value: string | undefined,
  fallback: number,
  name: string,
  min: number,
  max: number,
): number {
  if (value === undefined || value === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

export function loadConfig(overrides: ConfigOverrides = {}): ServerConfig {
  const env = overrides.env ?? process.env;
  const homeDir = overrides.homeDir ?? homedir();
  const projectDir = overrides.projectDir ?? env.SESSION_ATLAS_PROJECT_DIR ?? process.cwd();
  const applicationSupportDir =
    overrides.applicationSupportDir ??
    env.SESSION_ATLAS_STATE_DIR ??
    join(homeDir, "Library", "Application Support", "SessionAtlas");
  const configuredProjectRoots =
    overrides.allowedProjectRoots ??
    env.SESSION_ATLAS_PROJECT_ROOTS?.split(delimiter).filter(Boolean) ??
    (env.SESSION_ATLAS_PROJECT_ROOT ? [env.SESSION_ATLAS_PROJECT_ROOT] : [join(homeDir, "Code")]);
  if (configuredProjectRoots.length === 0) {
    throw new Error("At least one project root must be configured.");
  }
  const allowedProjectRoots = configuredProjectRoots.map((root) => resolve(root));

  const config: ServerConfig = {
    host: "127.0.0.1",
    port:
      overrides.port ??
      integerSetting(env.SESSION_ATLAS_PORT, DEFAULT_PORT, "SESSION_ATLAS_PORT", 1, 65_535),
    development:
      overrides.development ??
      (env.NODE_ENV !== "production" && env.SESSION_ATLAS_ENV !== "production"),
    allowedProjectRoots,
    deniedProjectRoots:
      overrides.deniedProjectRoots ?? [join(homeDir, "Code", "windows_outdated_dev_code")],
    applicationSupportDir: resolve(applicationSupportDir),
    attentionStateFile:
      overrides.attentionStateFile ?? join(resolve(applicationSupportDir), "state.json"),
    recoveryStateFile:
      overrides.recoveryStateFile ?? join(resolve(applicationSupportDir), "recovery.json"),
    itermSocketPath:
      overrides.itermSocketPath ?? join(resolve(applicationSupportDir), "bridge.sock"),
    staticDir: overrides.staticDir ?? join(projectDir, "dist", "client"),
    maxJsonBytes:
      overrides.maxJsonBytes ??
      integerSetting(
        env.SESSION_ATLAS_MAX_JSON_BYTES,
        DEFAULT_MAX_JSON_BYTES,
        "SESSION_ATLAS_MAX_JSON_BYTES",
        1_024,
        1_048_576,
      ),
    staleAfterMs:
      overrides.staleAfterMs ??
      integerSetting(
        env.SESSION_ATLAS_STALE_AFTER_MS,
        DEFAULT_STALE_AFTER_MS,
        "SESSION_ATLAS_STALE_AFTER_MS",
        5_000,
        3_600_000,
      ),
    autoResumeEnabled:
      overrides.autoResumeEnabled ??
      booleanSetting(env.SESSION_ATLAS_AUTO_RESUME, false, "SESSION_ATLAS_AUTO_RESUME"),
  };

  return config;
}
