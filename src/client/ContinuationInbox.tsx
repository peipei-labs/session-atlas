import { useEffect, useState } from "react";

import type { RecoveryRecord, SessionSummary, UpsertHandoffInput } from "../shared/types";
import {
  CONTINUATION_KINDS, completeContinuationInput, continuationInboxEntries, continuationTimeLabel,
  formatContinuationTime, groupContinuationInbox, type ContinuationInboxEntry,
} from "./continuation-model";
import { Icon } from "./icons";
import { OpenThreadAction, openThreadLocations, threadLocationStatus } from "./OpenThreadAction";

interface ContinuationInboxProps {
  records: RecoveryRecord[];
  sessions: SessionSummary[];
  query?: string;
  selectedTags?: readonly string[];
  canUseIterm: boolean;
  busyId: string | null;
  onSave: (sessionId: string, input: UpsertHandoffInput) => Promise<boolean>;
  onResume: (sessionId: string) => Promise<"focused" | "restored" | null>;
  onOpenSession?: (sessionId: string) => void;
  onFocusSession?: (sessionId: string) => Promise<boolean>;
  onOpenCard: (record: RecoveryRecord) => void;
}

interface InboxRowProps {
  entry: ContinuationInboxEntry;
  sessions: SessionSummary[];
  now: number;
  expanded: boolean;
  busy: boolean;
  canUseIterm: boolean;
  onToggle: () => void;
  onComplete: () => void;
  onResume: () => void;
  onOpenSession?: (sessionId: string) => void;
  onFocusSession?: (sessionId: string) => Promise<boolean>;
  onOpenCard: (record: RecoveryRecord) => void;
}

export function InboxRow({
  entry, sessions, now, expanded, busy, canUseIterm,
  onToggle, onComplete, onResume, onOpenSession, onFocusSession, onOpenCard,
}: InboxRowProps) {  const { record, item, dueAt } = entry;
  const locations = openThreadLocations(sessions, record.sessionId);
  const isDue = dueAt !== undefined && dueAt <= now;
  return (
    <li className={`inbox-row${expanded ? " is-expanded" : ""}`} data-item-id={item.id}>
      <div className="inbox-row-main">
        <button type="button" className="inbox-row-toggle" aria-expanded={expanded} onClick={onToggle}>
          <span className={`continuation-kind is-${item.kind}`}>{CONTINUATION_KINDS[item.kind]}</span>
          <span className="inbox-row-text">
            <strong>{item.title}</strong>
            <small>{record.projectName} · {record.title} · {threadLocationStatus(record, locations)}</small>
          </span>
        </button>
        {item.kind === "time" ? (
          <span className={`inbox-due${isDue ? " is-due" : ""}`}>{continuationTimeLabel(item, now)}</span>
        ) : null}
        <button type="button" disabled={busy} className="continuation-complete" aria-label={`完成：${item.title}`} onClick={onComplete}>
          <Icon name="check" /><span>完成</span>
        </button>
      </div>
      {expanded ? (
        <div className="inbox-detail">
          {item.kind === "time" ? (
            <div className={`continuation-time${isDue ? " is-due" : ""}`}>
              <strong>{continuationTimeLabel(item, now)}</strong>
              {item.dueAt ? <time dateTime={item.dueAt}>{formatContinuationTime(item.dueAt)} · 上海时间</time> : null}
              {item.anchorLabel ? <small>起算：{item.anchorLabel}{item.anchorAt ? ` · ${formatContinuationTime(item.anchorAt)}` : ""}</small> : null}
            </div>
          ) : null}
          {item.condition ? <p className="continuation-condition">{item.condition}</p> : null}
          <p className="continuation-next"><small>下一步</small>{item.nextAction}</p>
          <div className="inbox-detail-actions">
            <OpenThreadAction
              record={record}
              sessions={sessions}
              canUseIterm={canUseIterm}
              busy={busy}
              onOpenSession={onOpenSession}
              onFocusSession={onFocusSession}
              onResume={onResume}
            />
            <button type="button" disabled={busy} onClick={() => onOpenCard(record)}>打开线程卡片</button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

export function ContinuationInbox({
  records, sessions, query = "", selectedTags = [], canUseIterm, busyId,
  onSave, onResume, onOpenSession, onFocusSession, onOpenCard,
}: ContinuationInboxProps) {
  const [now, setNow] = useState(Date.now);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  const busy = busyId !== null;
  const groups = groupContinuationInbox(continuationInboxEntries(records, now, query, selectedTags));
  const filtered = Boolean(query.trim()) || selectedTags.length > 0;

  return (
    <div className="continuation-inbox" data-testid="continuation-inbox">
      {!groups.length ? (
        <div className="continuation-empty">
          <Icon name="check" />
          <strong>{filtered ? "没有匹配的待续事项" : "当前没有待续事项"}</strong>
          {filtered ? null : <p>在原线程使用 <code>$session-atlas-handoff</code> 登记后续事项，或打开线程卡片手动登记。</p>}
        </div>
      ) : null}
      {groups.map((group) => (
        <section className="inbox-group" key={group.id} data-inbox-group={group.id}>
          <h3 className="inbox-group-heading">{group.title}<em>{group.entries.length}</em></h3>
          <ul className="inbox-list">
            {group.entries.map((entry) => {
              const rowId = JSON.stringify([entry.record.sessionId, entry.item.id]);
              return <InboxRow
                key={rowId}
                entry={entry}
                sessions={sessions}
                now={now}
                expanded={expandedId === rowId}
                busy={busy}
                canUseIterm={canUseIterm}
                onToggle={() => setExpandedId((current) => current === rowId ? null : rowId)}
                onComplete={() => {
                  void onSave(entry.record.sessionId, completeContinuationInput(entry.record, entry.item.id)).then((success) => {
                    if (success) setMessage(`已完成：${entry.item.title}`);
                  });
                }}
                onResume={() => {
                  void onResume(entry.record.sessionId).then((result) => {
                    if (result) setMessage(result === "focused" ? "已定位到原线程。" : "已请求恢复原线程，等待 iTerm 确认。");
                  });
                }}
                onOpenSession={onOpenSession}
                onFocusSession={onFocusSession}
                onOpenCard={onOpenCard}
              />;
            })}
          </ul>
        </section>
      ))}
      {message ? <p className="continuation-status" role="status">{message}</p> : null}
    </div>
  );
}
