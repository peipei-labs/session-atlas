import type { RecoveryRecord, SessionSummary } from "../shared/types";
import { sessionIdentity } from "./attention-model";
import { Icon } from "./icons";

export function openThreadLocations(sessions: readonly SessionSummary[], sessionId: string): SessionSummary[] {
  return sessions.filter((session) => !session.stale &&
    (session.conversationId === sessionId || (session.surface === "managed" && session.id === sessionId)))
    .sort((a, b) => (a.terminal?.windowIndex ?? Infinity) - (b.terminal?.windowIndex ?? Infinity) ||
      (a.terminal?.tabIndex ?? Infinity) - (b.terminal?.tabIndex ?? Infinity) ||
      (a.terminal?.paneIndex ?? Infinity) - (b.terminal?.paneIndex ?? Infinity) || a.id.localeCompare(b.id));
}

export function threadLocationStatus(record: RecoveryRecord, locations: readonly SessionSummary[]): string {
  if (locations.length > 1) return `已在 ${locations.length} 处打开`;
  if (locations[0]) return locations[0].surface === "managed" ? "工作台会话仍然打开" : sessionIdentity(locations[0]).fullLocator;
  return record.status === "active" ? "打开位置待核对" : "已关闭，可恢复";
}

interface OpenThreadActionProps {
  record: RecoveryRecord;
  sessions: readonly SessionSummary[];
  canUseIterm: boolean;
  busy: boolean;
  submitted?: boolean;
  onResume?: () => void;
  onFocusSession?: (sessionId: string) => Promise<boolean>;
  onOpenSession?: (sessionId: string) => void;
}

export function OpenThreadAction({ record, sessions, canUseIterm, busy, submitted, onResume, onFocusSession, onOpenSession }: OpenThreadActionProps) {
  const locations = openThreadLocations(sessions, record.sessionId);
  if (locations.length > 1) {
    return <div className="thread-open-choices">
      <small>同一线程在 {locations.length} 处打开，请选择已有位置</small>
      {locations.map((session) => <button key={session.id} type="button"
        disabled={busy || (session.surface === "managed" ? !onOpenSession : !canUseIterm || !session.capabilities.focus || !onFocusSession)}
        onClick={() => {
          if (session.surface === "managed") onOpenSession?.(session.id);
          else void onFocusSession?.(session.id);
        }}><Icon name="arrow" /><span>{session.surface === "managed" ? "打开工作台" : `回到${sessionIdentity(session).fullLocator}`}</span></button>)}
    </div>;
  }
  const current = locations[0];
  const managed = current?.surface === "managed";
  const label = managed ? "打开工作台" : current ? `回到${sessionIdentity(current).fullLocator}`
    : submitted ? "等待恢复确认" : record.status === "active" ? "检查并回到原线程" : "恢复原线程";
  return <button className="continuation-primary" type="button"
    disabled={busy || (managed ? !onOpenSession : !canUseIterm || (!current && submitted) || !onResume)}
    onClick={() => { if (managed) onOpenSession?.(current.id); else onResume?.(); }}>
    <Icon name="arrow" /><span>{label}</span>
  </button>;
}
