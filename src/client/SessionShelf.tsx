import type { SessionSummary } from "../shared/types";
import { Icon } from "./icons";
import { SessionRow } from "./SessionRow";

interface SessionShelfProps {
  label: string;
  sessions: SessionSummary[];
  selectedId?: string;
  focusPending?: boolean;
  onSelect: (sessionId: string) => void;
  onFocus: (sessionId: string) => void;
}

export function SessionShelf({
  label,
  sessions,
  selectedId,
  focusPending = false,
  onSelect,
  onFocus,
}: SessionShelfProps) {
  if (!sessions.length) {
    return null;
  }

  return (
    <section className="dock-panel-section" data-testid="buried-section">
      <h2 className="dock-panel-heading">
        <Icon name="archive" />
        <strong>{label}</strong>
        <em>{sessions.length}</em>
      </h2>
      <div className="dock-panel-body session-shelf-list">
        {sessions.map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            selected={session.id === selectedId}
            focusPending={focusPending}
            onSelect={onSelect}
            onFocus={onFocus}
          />
        ))}
      </div>
    </section>
  );
}
