import type { ActivityState, AttentionReason, SessionSummary } from "../shared/types";

const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const fullTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export function formatTime(value: string, seconds = false): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--:--";
  }
  return seconds ? fullTimeFormatter.format(date) : timeFormatter.format(date);
}

export function attentionLabel(reason: AttentionReason): string {
  switch (reason) {
    case "needs_approval":
      return "等待审批";
    case "needs_input":
      return "等待回答";
    case "failed":
      return "执行失败";
    case "newly_completed":
      return "刚刚完成";
    default:
      return "";
  }
}

export function activityLabel(state: ActivityState): string {
  switch (state) {
    case "running":
      return "运行中";
    case "idle":
      return "空闲";
    case "awaiting_input":
      return "等待回答";
    case "awaiting_approval":
      return "等待审批";
    case "failed":
      return "执行失败";
    case "offline":
      return "离线";
    default:
      return "未关联";
  }
}

export function sessionTone(session: SessionSummary): string {
  if (session.stale || session.activityState === "offline") {
    return "muted";
  }
  if (session.attentionReason === "failed" || session.activityState === "failed") {
    return "danger";
  }
  if (session.attentionReason === "newly_completed") {
    return "success";
  }
  if (session.attentionReason) {
    return "attention";
  }
  if (session.activityState === "running") {
    return "accent";
  }
  return "default";
}

export function isManaged(session: SessionSummary): boolean {
  return session.surface === "managed";
}

export function shortId(value?: string): string {
  if (!value) {
    return "—";
  }
  return value.length > 15 ? `${value.slice(0, 12)}…` : value;
}

export function planFraction(session: SessionSummary): string | null {
  const plan = session.plan;
  return plan && plan.total > 0 ? `${plan.done} / ${plan.total}` : null;
}
