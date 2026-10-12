import type { RecoveryRecord, SessionSummary } from "../shared/types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function getSavedThreadId(session: SessionSummary): string | undefined {
  if (session.provider !== "codex" || (session.surface === "legacy"
    && session.recoveryStatus !== undefined && session.recoveryStatus !== "recorded")) return undefined;
  return session.conversationId ?? (session.surface === "managed" && UUID.test(session.id) ? session.id : undefined);
}

export function getSavedThreadStatus(session: SessionSummary, recovery?: RecoveryRecord | null) {
  if (session.provider !== "codex" && session.recoveryStatus === undefined) return null;
  const threadId = getSavedThreadId(session);
  if (!threadId || recovery === undefined || (recovery && recovery.sessionId !== threadId)) {
    return { label: "待核对", tone: "unknown" };
  }
  const handoff = recovery?.handoff;
  if (!handoff) return { label: "未登记", tone: "empty" };
  const pending = handoff.items.filter((item) => item.status === "pending").length;
  if (pending > 0) return { label: `待续${pending}项${handoff.reference ? " · 已收藏" : ""}`, tone: "pending" };
  if (handoff.reference) return { label: "已收藏", tone: "reference" };
  if (handoff.items.length > 0) return {
    label: handoff.items.every((item) => item.status === "done") ? "待续已完成" : "待续已结束",
    tone: "complete",
  };
  return { label: "已登记", tone: "complete" };
}

export function SavedThreadStatus({ session, recovery, compact = false }: {
  session: SessionSummary;
  recovery?: RecoveryRecord | null;
  compact?: boolean;
}) {
  const status = getSavedThreadStatus(session, recovery);
  return status ? (
    <span className={`saved-thread-status is-${status.tone}${compact ? " is-compact" : ""}`}
      aria-label={`待续与收藏保存状态：${status.label}`} title={`待续与收藏保存状态：${status.label}`}>
      {status.label}
    </span>
  ) : null;
}
