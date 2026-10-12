import type { SessionSummary } from "../shared/types";
import { sessionIdentity } from "./attention-model";
import { formatTime, planFraction, sessionTone } from "./format";
import { Icon } from "./icons";

interface SessionRowProps {
  session: SessionSummary;
  selected: boolean;
  focusPending: boolean;
  onSelect: (sessionId: string) => void;
  onFocus: (sessionId: string) => void;
}

export function SessionRow({ session, selected, focusPending, onSelect, onFocus }: SessionRowProps) {
  const identity = sessionIdentity(session);
  const tone = sessionTone(session);
  const fraction = planFraction(session);
  const canFocus = !session.stale && session.capabilities.focus;

  return (
    <div
      className={`session-row tone-${tone}${selected ? " is-selected" : ""}${session.focused ? " is-focused" : ""}`}
      data-session-id={session.id}
    >
      <button
        className="session-row-main"
        data-testid="session-row"
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(session.id)}
      >
        <span className="row-status-dot" aria-hidden="true" />
        <span className="row-body">
          <span className="row-title">
            {session.pinned ? <Icon className="row-pin" name="pin" /> : null}
            <strong>{identity.primary}</strong>
            {session.focused ? <em className="row-here">你在这里</em> : null}
          </span>
          <span className="row-meta">
            {identity.shortcut ? <kbd>{identity.shortcut}</kbd> : null}
            <code>{identity.locator}</code>
            {identity.secondary ? <small title={session.cwd}>{identity.secondary}</small> : null}
          </span>
        </span>
        <span className="row-side">
          {session.pendingRequest ? <em className="row-badge">待处理</em> : null}
          {!session.pendingRequest && fraction ? <code className="row-fraction">{fraction}</code> : null}
          <time dateTime={session.lastActivityAt}>{formatTime(session.lastActivityAt)}</time>
        </span>
      </button>
      {canFocus ? (
        <button
          className="session-row-focus"
          type="button"
          title="跳回 iTerm"
          aria-label={`跳回 iTerm：${identity.primary}`}
          disabled={focusPending}
          onClick={() => onFocus(session.id)}
        >
          <Icon name="focus" />
        </button>
      ) : null}
    </div>
  );
}
