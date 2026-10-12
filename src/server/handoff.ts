import { isAbsolute } from "node:path";

import type {
  ContinuationItem,
  SessionHandoff,
  SessionReference,
  UpsertHandoffInput,
} from "../shared/types.js";
import { AppError } from "./errors.js";

function fail(message: string): never {
  throw new AppError(400, "INVALID_HANDOFF", message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    fail("The handoff contains unsupported fields.");
  }
}

function text(
  value: unknown,
  label: string,
  limit: number,
  optional = false,
): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || value.includes("\0")) {
    fail(`${label} must be text.`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > limit) {
    fail(`${label} must contain 1–${limit} characters.`);
  }
  return normalized;
}

function timestamp(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  const raw = text(value, label, 40)!;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.exec(raw);
  const parsed = Date.parse(raw);
  if (!parts || !Number.isFinite(parsed)) {
    fail(`${label} must be an ISO date and time with an explicit timezone.`);
  }
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month, 0);
  if (month < 1 || month > 12 || day < 1 || day > calendar.getUTCDate()) {
    fail(`${label} must be a valid calendar date.`);
  }
  const date = new Date(parsed);
  if (date.getUTCFullYear() < 0 || date.getUTCFullYear() > 9_999) {
    fail(`${label} must normalize to a year from 0000 through 9999.`);
  }
  return date.toISOString();
}

function parseItem(value: unknown): ContinuationItem {
  const item = record(value, "Each continuation item");
  onlyKeys(item, [
    "id", "title", "kind", "nextAction", "status", "condition",
    "anchorLabel", "anchorAt", "delayHours", "dueAt",
  ]);
  if (!["time", "condition", "input", "later"].includes(item.kind as string)) {
    fail("Each continuation item requires a supported kind.");
  }
  if (!["pending", "done", "cancelled"].includes(item.status as string)) {
    fail("Each continuation item requires a supported status.");
  }
  if (
    item.delayHours !== undefined &&
    (typeof item.delayHours !== "number" || !Number.isFinite(item.delayHours) || item.delayHours < 0)
  ) {
    fail("delayHours must be a finite nonnegative number.");
  }
  const anchorAt = timestamp(item.anchorAt, "anchorAt");
  let dueAt = timestamp(item.dueAt, "dueAt");
  if (item.kind === "time" && item.delayHours !== undefined) {
    if (anchorAt) {
      const dueTime = Date.parse(anchorAt) + (item.delayHours as number) * 60 * 60 * 1_000;
      if (!Number.isFinite(new Date(dueTime).getTime()) || new Date(dueTime).getUTCFullYear() > 9_999) {
        fail("The calculated due time is out of range.");
      }
      const calculatedDueAt = new Date(dueTime).toISOString();
      if (dueAt && dueAt !== calculatedDueAt) {
        fail("dueAt does not match anchorAt plus delayHours.");
      }
      dueAt = calculatedDueAt;
    } else {
      dueAt = undefined;
    }
  }
  const condition = text(item.condition, "condition", 1_000, true);
  const anchorLabel = text(item.anchorLabel, "anchorLabel", 200, true);
  return {
    id: text(item.id, "Item id", 100)!,
    title: text(item.title, "Item title", 200)!,
    kind: item.kind as ContinuationItem["kind"],
    nextAction: text(item.nextAction, "nextAction", 1_000)!,
    status: item.status as ContinuationItem["status"],
    ...(condition !== undefined ? { condition } : {}),
    ...(anchorLabel !== undefined ? { anchorLabel } : {}),
    ...(anchorAt !== undefined ? { anchorAt } : {}),
    ...(item.delayHours !== undefined ? { delayHours: item.delayHours as number } : {}),
    ...(dueAt !== undefined ? { dueAt } : {}),
  };
}

function parseReference(value: unknown): SessionReference {
  const reference = record(value, "Reference");
  onlyKeys(reference, ["title", "reason"]);
  return {
    title: text(reference.title, "Reference title", 200)!,
    reason: text(reference.reason, "Reference reason", 1_000)!,
  };
}

export function parseUpsertHandoffInput(value: unknown): UpsertHandoffInput {
  const input = record(value, "Handoff");
  onlyKeys(input, ["expectedVersion", "cwd", "summary", "items", "reference", "source", "sourceTurnId", "requiresRunningProcess"]);
  const cwd = text(input.cwd, "cwd", 4_096)!;
  if (!isAbsolute(cwd)) fail("cwd must be an absolute path.");
  if (!Array.isArray(input.items) || input.items.length > 20) {
    fail("A handoff may contain at most 20 continuation items.");
  }
  const items = input.items.map(parseItem);
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    fail("Continuation item ids must be unique within a handoff.");
  }
  if (input.source !== undefined && input.source !== "thread" && input.source !== "user") {
    fail("source must be thread or user.");
  }
  if (input.requiresRunningProcess !== undefined && typeof input.requiresRunningProcess !== "boolean") {
    fail("requiresRunningProcess must be a boolean.");
  }
  const sourceTurnId = text(input.sourceTurnId, "sourceTurnId", 200, true);
  return {
    expectedVersion: parseHandoffVersion(input.expectedVersion),
    cwd,
    summary: text(input.summary, "summary", 1_000)!,
    items,
    ...(input.reference !== undefined
      ? { reference: input.reference === null ? null : parseReference(input.reference) }
      : {}),
    source: (input.source as UpsertHandoffInput["source"]) ?? "user",
    ...(sourceTurnId !== undefined ? { sourceTurnId } : {}),
    ...(input.requiresRunningProcess !== undefined
      ? { requiresRunningProcess: input.requiresRunningProcess as boolean }
      : {}),
  };
}

export function parseHandoffVersion(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > 200 || value.includes("\0")) {
    throw new AppError(400, "HANDOFF_VERSION_REQUIRED", "请先读取最新卡片，并提交对应的 expectedVersion；尚无卡片时提交 null。");
  }
  return value;
}

export function parseStoredHandoff(value: unknown): SessionHandoff {
  const handoff = record(value, "Stored handoff");
  onlyKeys(handoff, ["version", "summary", "items", "reference", "updatedAt", "source", "sourceTurnId", "requiresRunningProcess"]);
  if (handoff.reference === null) fail("A stored reference must be an object.");
  const { updatedAt, version, ...input } = handoff;
  const normalized = parseUpsertHandoffInput({ ...input, cwd: "/", expectedVersion: null });
  const normalizedUpdatedAt = timestamp(updatedAt, "updatedAt");
  if (!normalizedUpdatedAt) fail("A stored handoff requires updatedAt.");
  const { cwd: _cwd, expectedVersion: _expectedVersion, reference, ...content } = normalized;
  return {
    ...content,
    ...(version !== undefined ? { version: text(version, "version", 200)! } : {}),
    ...(reference ? { reference } : {}),
    source: normalized.source!, updatedAt: normalizedUpdatedAt,
  };
}

export function hasPendingHandoff(handoff: SessionHandoff | undefined): boolean {
  return handoff?.items.some((item) => item.status === "pending") ?? false;
}

export function hasSavedHandoff(handoff: SessionHandoff | undefined): boolean {
  return hasPendingHandoff(handoff) || Boolean(handoff?.reference);
}
