import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { basename } from "node:path";

import type { ItermSessionSnapshot } from "./provider-ports.js";

export interface LegacyCodexMatch {
  conversationId?: string;
  status: "linked" | "unlinked" | "ambiguous" | "error";
  reason?: "process-snapshot-failed" | "process-inspection-failed";
}

interface ProcessRow {
  pid: number;
  ppid: number;
  tty: string;
  command: string;
}

export type ReadCommand = (file: string, args: readonly string[]) => Promise<string>;
export type ReadSessionMeta = (file: string) => Promise<unknown>;

interface CachedMatch {
  identity: string;
  checkedAt: number;
  match: LegacyCodexMatch;
}

const DEFAULT_RETRY_AFTER_MS = 30_000;
const MAX_SESSION_META_BYTES = 256 * 1024;
const PS_PATH = "/bin/ps";
const LSOF_PATH = "/usr/sbin/lsof";
const PROCESS_COMMAND_TIMEOUT_MS = 3_000;

function defaultReadCommand(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: PROCESS_COMMAND_TIMEOUT_MS }, (error, stdout, stderr) => {
      const exitedPid = file === LSOF_PATH && error?.code === 1 &&
        !error.killed && !error.signal && stderr.trim() === "";
      if (error && !exitedPid) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

async function defaultReadSessionMeta(file: string): Promise<unknown> {
  const handle = await open(file, "r");
  try {
    const chunks: Buffer[] = [];
    let offset = 0;
    let complete = false;
    while (offset < MAX_SESSION_META_BYTES) {
      const buffer = Buffer.alloc(Math.min(8 * 1024, MAX_SESSION_META_BYTES - offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) {
        complete = true;
        break;
      }
      const chunk = buffer.subarray(0, bytesRead);
      const newline = chunk.indexOf(0x0a);
      if (newline >= 0) {
        chunks.push(chunk.subarray(0, newline));
        complete = true;
        break;
      }
      chunks.push(chunk);
      offset += bytesRead;
    }
    if (!complete || chunks.length === 0) {
      return undefined;
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

function parseProcesses(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      tty: match[3]!,
      command: match[4]!,
    });
  }
  return rows;
}

function normalizeTty(tty: string | undefined): string | undefined {
  if (!tty || tty === "??" || tty === "?") {
    return undefined;
  }
  return basename(tty);
}

export function isCodexCommand(command: string): boolean {
  return /(?:^|[\s/])codex(?:[\s-]|$)/i.test(command);
}

function sessionIdentity(session: ItermSessionSnapshot): string {
  return JSON.stringify([
    session.sessionId,
    normalizeTty(session.tty),
    session.jobName ?? "",
    session.jobPid ?? null,
    session.commandLine ?? "",
  ]);
}

function descendantPids(processes: readonly ProcessRow[], rootPid: number | undefined): Set<number> {
  const descendants = new Set<number>();
  if (!rootPid) {
    return descendants;
  }
  descendants.add(rootPid);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of processes) {
      if (descendants.has(process.ppid) && !descendants.has(process.pid)) {
        descendants.add(process.pid);
        changed = true;
      }
    }
  }
  return descendants;
}

function rolloutReferences(lsofOutput: string, codexHome: string): Map<string, string> {
  const references = new Map<string, string>();
  const sessionsPrefix = `${codexHome}/sessions/`;
  const archivedPrefix = `${codexHome}/archived_sessions/`;
  const idPattern = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
  for (const line of lsofOutput.split("\n")) {
    if (!line.startsWith("n")) {
      continue;
    }
    const path = line.slice(1);
    if (!path.startsWith(sessionsPrefix) && !path.startsWith(archivedPrefix)) {
      continue;
    }
    const match = idPattern.exec(path);
    if (match?.[1]) {
      references.set(match[1], path);
    }
  }
  return references;
}

function rolloutReferencesByProcess(
  output: string,
  requestedPids: ReadonlySet<number>,
  codexHome: string,
): Map<number, Map<string, string> | null> {
  const blocks = new Map<number, string[]>();
  let currentPid: number | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      const match = /^p([1-9]\d*)$/u.exec(line);
      const pid = match ? Number(match[1]) : undefined;
      currentPid = pid !== undefined && Number.isSafeInteger(pid) && requestedPids.has(pid)
        ? pid
        : undefined;
      if (currentPid !== undefined && !blocks.has(currentPid)) blocks.set(currentPid, []);
    } else if (currentPid !== undefined && line.startsWith("n")) {
      blocks.get(currentPid)!.push(line);
    }
  }
  return new Map([...requestedPids].map((pid) => {
    const lines = blocks.get(pid);
    return [pid, lines ? rolloutReferences(lines.join("\n"), codexHome) : null];
  }));
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : undefined;
}

function subagentParentId(meta: unknown, expectedId: string): string | undefined {
  const root = objectValue(meta);
  const payload = objectValue(root?.payload);
  if (root?.type !== "session_meta" || payload?.id !== expectedId) {
    return undefined;
  }
  const source = objectValue(payload.source);
  const subagent = objectValue(source?.subagent);
  const threadSpawn = objectValue(subagent?.thread_spawn);
  const parentId = threadSpawn?.parent_thread_id;
  if (typeof parentId !== "string") {
    return undefined;
  }
  const directParentId = payload.parent_thread_id;
  if (directParentId !== undefined && directParentId !== null && directParentId !== parentId) {
    return undefined;
  }
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parentId)
    ? parentId
    : undefined;
}

function rootConversationId(id: string, parents: ReadonlyMap<string, string>): string | undefined {
  const visited = new Set<string>();
  let current = id;
  while (parents.has(current)) {
    if (visited.has(current)) {
      return undefined;
    }
    visited.add(current);
    current = parents.get(current)!;
  }
  return current;
}

function exactResumeConversationId(command: string): string | undefined {
  const resume = /(?:^|[\s/])codex\s+resume(?:\s+.*)?\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/iu.exec(
    command,
  );
  return resume?.[1];
}

export class LegacyCodexObserver {
  readonly codexHome: string;
  readonly readCommand: ReadCommand;
  readonly readSessionMeta: ReadSessionMeta;
  readonly retryAfterMs: number;
  readonly now: () => number;
  readonly trustResumeCommand: boolean;
  #cache = new Map<string, CachedMatch>();

  constructor(
    options: {
      codexHome?: string;
      readCommand?: ReadCommand;
      readSessionMeta?: ReadSessionMeta;
      retryAfterMs?: number;
      now?: () => number;
      trustResumeCommand?: boolean;
    } = {},
  ) {
    this.codexHome = options.codexHome ?? `${homedir()}/.codex`;
    this.readCommand = options.readCommand ?? defaultReadCommand;
    this.readSessionMeta = options.readSessionMeta ?? defaultReadSessionMeta;
    this.retryAfterMs = options.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
    this.now = options.now ?? Date.now;
    this.trustResumeCommand = options.trustResumeCommand ?? true;
  }

  async observe(session: ItermSessionSnapshot): Promise<LegacyCodexMatch> {
    const matches = await this.observeAll([session]);
    return matches[0] ?? { status: "unlinked" };
  }

  async observeAll(
    sessions: readonly ItermSessionSnapshot[],
  ): Promise<LegacyCodexMatch[]> {
    const matches: LegacyCodexMatch[] = sessions.map(() => ({ status: "unlinked" }));
    const observedIds = new Set(sessions.map((session) => session.sessionId));
    for (const sessionId of this.#cache.keys()) {
      if (!observedIds.has(sessionId)) this.#cache.delete(sessionId);
    }
    const checkedAt = this.now();
    const hasReportedCodex = sessions.some(
      (session) =>
        isCodexCommand(`${session.jobName ?? ""} ${session.commandLine ?? ""}`) ||
        session.jobName?.toLowerCase() === "node",
    );
    if (!hasReportedCodex) {
      return matches;
    }
    const entriesToClassify = sessions
      .map((session, index) => ({ index, session, identity: sessionIdentity(session) }))
      .filter(({ index, session, identity }) => {
        const cached = this.#cache.get(session.sessionId);
        if (
          cached?.identity === identity &&
          checkedAt - cached.checkedAt < this.retryAfterMs
        ) {
          matches[index] = { ...cached.match };
          return false;
        }
        return true;
      });
    if (entriesToClassify.length === 0) {
      return matches;
    }

    let processes: ProcessRow[];
    try {
      processes = parseProcesses(
        await this.readCommand(PS_PATH, ["-axo", "pid=,ppid=,tty=,command="]),
      );
    } catch {
      for (const { index, session, identity } of entriesToClassify) {
        const match: LegacyCodexMatch = {
          status: "error",
          reason: "process-snapshot-failed",
        };
        matches[index] = match;
        this.#cache.set(session.sessionId, {
          identity,
          checkedAt,
          match,
        });
      }
      return matches;
    }

    const candidatesByIndex = new Map<number, Set<number>>();
    const entriesNeedingInspection = entriesToClassify.filter(
      ({ index, session, identity }) => {
        const tty = normalizeTty(session.tty);
        const descendants = descendantPids(processes, session.jobPid);
        const candidatePids = new Set<number>();
        for (const process of processes) {
          const sameTty = tty !== undefined && normalizeTty(process.tty) === tty;
          if ((sameTty || descendants.has(process.pid)) && isCodexCommand(process.command)) {
            candidatePids.add(process.pid);
          }
        }
        const reportedCodex = isCodexCommand(
          `${session.jobName ?? ""} ${session.commandLine ?? ""}`,
        );
        if (reportedCodex && session.jobPid) {
          candidatePids.add(session.jobPid);
        }
        if (candidatePids.size === 0) {
          const match: LegacyCodexMatch = { status: "unlinked" };
          matches[index] = match;
          this.#cache.set(session.sessionId, {
            identity,
            checkedAt,
            match,
          });
          return false;
        }
        const exactCandidates = [...candidatePids].map((pid) => {
          const process = processes.find((candidate) => candidate.pid === pid);
          return process ? exactResumeConversationId(process.command) : undefined;
        });
        const exactIds = new Set(exactCandidates.filter((value): value is string => Boolean(value)));
        if (!this.trustResumeCommand || exactIds.size !== 1 || exactCandidates.some((value) => value === undefined)) {
          candidatesByIndex.set(index, candidatePids);
          return true;
        }
        const conversationId = [...exactIds][0]!;
        const match: LegacyCodexMatch = { status: "linked", conversationId };
        matches[index] = match;
        this.#cache.set(session.sessionId, {
          identity,
          checkedAt,
          match,
        });
        return false;
      },
    );
    if (entriesNeedingInspection.length === 0) {
      return matches;
    }

    const allCandidatePids = new Set<number>();
    for (const { index } of entriesNeedingInspection) {
      const candidatePids = candidatesByIndex.get(index) ?? new Set<number>();
      for (const pid of candidatePids) {
        allCandidatePids.add(pid);
      }
    }

    let rolloutReferencesByPid = new Map<number, Map<string, string> | null>(
      [...allCandidatePids].map((pid) => [pid, null]),
    );
    try {
      const output = await this.readCommand(LSOF_PATH, [
        "-nP", "-Fpn", "-p", [...allCandidatePids].sort((left, right) => left - right).join(","),
      ]);
      rolloutReferencesByPid = rolloutReferencesByProcess(output, allCandidatePids, this.codexHome);
    } catch {
      // A failed or truncated batch cannot establish any candidate's identity.
    }

    const ambiguousReferences = new Map<string, string>();
    for (const { index } of entriesNeedingInspection) {
      const references = new Map<string, string>();
      for (const pid of candidatesByIndex.get(index) ?? []) {
        for (const [id, path] of rolloutReferencesByPid.get(pid) ?? []) {
          references.set(id, path);
        }
      }
      if (references.size > 1) {
        for (const [id, path] of references) {
          ambiguousReferences.set(id, path);
        }
      }
    }
    const subagentParents = new Map<string, string>();
    await Promise.all(
      [...ambiguousReferences].map(async ([id, path]) => {
        try {
          const parentId = subagentParentId(await this.readSessionMeta(path), id);
          if (parentId) {
            subagentParents.set(id, parentId);
          }
        } catch {
          // Missing or changing metadata leaves the candidate unresolved.
        }
      }),
    );

    for (const { index, session, identity } of entriesNeedingInspection) {
      const references = new Map<string, string>();
      const candidatePids = candidatesByIndex.get(index) ?? new Set<number>();
      const incomplete = [...candidatePids].some(
        (pid) => rolloutReferencesByPid.get(pid) === null,
      );
      if (incomplete) {
        matches[index] = { status: "error", reason: "process-inspection-failed" };
      } else {
        for (const pid of candidatePids) {
          for (const [id, path] of rolloutReferencesByPid.get(pid) ?? []) {
            references.set(id, path);
          }
        }
        if (references.size === 1) {
          matches[index] = {
            status: "linked",
            conversationId: [...references.keys()][0],
          };
        } else if (references.size > 1) {
          const roots = new Set(
            [...references.keys()].map((id) => rootConversationId(id, subagentParents)),
          );
          if (roots.size === 1 && !roots.has(undefined)) {
            matches[index] = {
              status: "linked",
              conversationId: [...roots][0],
            };
          } else {
            matches[index] = { status: "ambiguous" };
          }
        }
      }
      this.#cache.set(session.sessionId, {
        identity,
        checkedAt,
        match: { ...matches[index]! },
      });
    }

    return matches;
  }
}
