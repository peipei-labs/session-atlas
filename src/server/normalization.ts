import { basename } from "node:path";

import {
  EMPTY_CAPABILITIES,
  type SessionCapabilities,
  type SessionPlan,
  type SessionSummary,
} from "../shared/types.js";
import type { ItermSessionSnapshot } from "./provider-ports.js";
import { getProjectMetadata } from "./project-path.js";
import type { LegacyCodexMatch } from "./legacy-codex-observer.js";

const SHELL_JOB_NAMES = new Set(["bash", "dash", "fish", "nu", "sh", "tcsh", "zsh"]);

function validIsoDate(value: string | undefined, fallback: string): string {
  if (value && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return fallback;
}

function normalizeCapabilities(
  capabilities: Partial<SessionCapabilities> | undefined,
): SessionCapabilities {
  return {
    ...EMPTY_CAPABILITIES,
    ...capabilities,
  };
}

function normalizePlan(plan: SessionPlan | undefined): SessionPlan | undefined {
  if (!plan || plan.steps.length === 0) {
    return undefined;
  }
  const steps = plan.steps.map((step, index) => ({
    id: step.id || `step-${index + 1}`,
    label: step.label,
    status: step.status,
  }));
  return {
    steps,
    done: steps.filter((step) => step.status === "completed").length,
    total: steps.length,
  };
}

export async function normalizeProviderSession(
  input: SessionSummary,
  now = new Date(),
): Promise<SessionSummary> {
  const timestamp = now.toISOString();
  const metadata =
    input.projectKey && input.projectName
      ? {
          projectKey: input.projectKey,
          projectName: input.projectName,
          branch: input.branch,
        }
      : await getProjectMetadata(input.cwd);
  return {
    ...input,
    title: input.title.trim() || input.projectName || basename(input.cwd) || "Untitled session",
    projectKey: metadata.projectKey,
    projectName: metadata.projectName,
    branch: metadata.branch ?? input.branch,
    lastActivityAt: validIsoDate(input.lastActivityAt, timestamp),
    observedAt: validIsoDate(input.observedAt, timestamp),
    stale: Boolean(input.stale),
    focused: input.focused,
    plan: normalizePlan(input.plan),
    activities: Array.isArray(input.activities) ? input.activities.slice(0, 50) : [],
    capabilities: normalizeCapabilities(input.capabilities),
    pinned: Boolean(input.pinned),
    parked: Boolean(input.parked),
  };
}

export function normalizeItermTitle(value: string, fallback: string): string {
  const withoutSpinner = value.replace(/^\s*[\u2800-\u28ff]\s*/u, "").trim();
  return withoutSpinner || fallback;
}

export async function normalizeItermSession(
  input: ItermSessionSnapshot,
  legacyCodex?: LegacyCodexMatch,
  now = new Date(),
): Promise<SessionSummary> {
  const timestamp = now.toISOString();
  const observedAt = validIsoDate(input.observedAt, timestamp);
  const metadata = await getProjectMetadata(input.cwd);
  const jobName = input.jobName?.trim();
  const shellIdle = jobName ? SHELL_JOB_NAMES.has(jobName.toLowerCase()) : true;
  const isAgentProcess =
    legacyCodex?.status === "linked" ||
    /(?:^|\s|\/)(?:codex|claude)(?:\s|$)/i.test(
      `${jobName ?? ""} ${input.commandLine ?? ""}`,
    );
  const activityLabel = shellIdle
    ? `Shell ready (${jobName ?? "unknown"})`
    : isAgentProcess
      ? legacyCodex?.status === "linked"
        ? "Codex legacy session · terminal activity only"
        : legacyCodex?.status === "error"
          ? "Codex recovery capture failed"
          : "Agent process detected · session not uniquely linked"
      : jobName
        ? `Terminal process: ${jobName}`
        : "Terminal state unavailable";

  return {
    id: `iterm:${input.sessionId}`,
    provider: legacyCodex?.status === "linked" ? "codex" : "terminal",
    conversationId: legacyCodex?.conversationId,
    terminalSessionId: input.sessionId,
    surface: "legacy",
    title: normalizeItermTitle(input.name, metadata.projectName),
    cwd: input.cwd,
    projectKey: metadata.projectKey,
    projectName: metadata.projectName,
    branch: metadata.branch,
    activityState: shellIdle ? "idle" : isAgentProcess ? "unknown" : "running",
    attentionReason: null,
    rawState: isAgentProcess ? `legacy-${legacyCodex?.status ?? "unlinked"}` : jobName,
    lastTurnStatus: isAgentProcess ? `legacy-${legacyCodex?.status ?? "unlinked"}` : undefined,
    currentActivity: activityLabel,
    lastActivityAt: observedAt,
    observedAt,
    recoveryStatus: isAgentProcess
      ? legacyCodex?.status === "linked"
        ? "recorded"
        : legacyCodex?.status === "ambiguous"
          ? "ambiguous"
          : legacyCodex?.status === "error"
            ? "failed"
            : "pending"
      : undefined,
    recoveryMessage:
      legacyCodex?.reason === "process-snapshot-failed"
        ? "Process inventory could not be read."
        : legacyCodex?.reason === "process-inspection-failed"
          ? "A Codex process ended or could not be inspected."
          : undefined,
    stale: false,
    focused: input.focused,
    buried: input.buried,
    terminal: {
      windowId: input.windowId,
      tabId: input.tabId,
      tty: input.tty,
      jobName,
      jobPid: input.jobPid,
      windowIndex: input.windowIndex,
      tabIndex: input.tabIndex,
      paneIndex: input.paneIndex,
      tabCount: input.tabCount,
      paneCount: input.paneCount,
      currentWindow: input.currentWindow,
    },
    activities: [
      {
        id: `terminal:${input.sessionId}:${observedAt}`,
        at: observedAt,
        label: activityLabel,
      },
    ],
    capabilities: {
      ...EMPTY_CAPABILITIES,
      open: true,
      focus: true,
    },
    pinned: false,
    parked: false,
  };
}
