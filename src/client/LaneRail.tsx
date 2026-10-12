import type { SessionSummary } from "../shared/types";
import {
  buildAttentionQueue,
  continuityLaneLabel,
  deriveContinuityLane,
  sessionIdentity,
  type ContinuityLane,
} from "./attention-model";
import { activityLabel, attentionLabel, sessionTone } from "./format";
import { attentionIcon } from "./HoneycombBoard";
import { Icon } from "./icons";

const LANE_ORDER: ContinuityLane[] = ["attention", "running", "returnable", "later"];
const QUEUE_LIMIT = 5;

interface LaneRailProps {
  sessions: SessionSummary[];
  focusedSession?: SessionSummary;
  laneFilter: ContinuityLane | null;
  onLaneFilter: (lane: ContinuityLane | null) => void;
  onSelect: (sessionId: string) => void;
}

export function LaneRail({ sessions, focusedSession, laneFilter, onLaneFilter, onSelect }: LaneRailProps) {
  const queue = buildAttentionQueue(sessions, QUEUE_LIMIT);
  const laneCounts = LANE_ORDER.map(
    (lane) => [lane, sessions.filter((session) => deriveContinuityLane(session) === lane).length] as const,
  );
  const focusedIdentity = focusedSession ? sessionIdentity(focusedSession) : undefined;

  return (
    <div className="lane-rail-body">
      {focusedSession && focusedIdentity ? (
        <div className="focus-chip" data-testid="focus-chip">
          <span className="focus-chip-label">你在这里</span>
          <code>{focusedIdentity.locator}</code>
          <strong>{focusedIdentity.primary}</strong>
          <button type="button" onClick={() => onSelect(focusedSession.id)}>
            <span>查看</span>
            <Icon name="arrow" />
          </button>
        </div>
      ) : null}

      <nav className="lane-nav" aria-label="状态车道">
        {laneCounts.map(([lane, count]) => (
          <button
            aria-pressed={laneFilter === lane}
            className={`lane-nav-button${laneFilter === lane ? " is-active" : ""}`}
            data-lane={lane}
            data-testid="lane-button"
            key={lane}
            type="button"
            onClick={() => onLaneFilter(laneFilter === lane ? null : lane)}
          >
            <i className={`legend-dot is-${lane}`} />
            <span>{continuityLaneLabel(lane)}</span>
            <em>{count}</em>
          </button>
        ))}
      </nav>

      {queue.length ? (
        <div className="attention-queue" aria-label="等待你处理">
          {queue.map((session) => {
            const identity = sessionIdentity(session);
            const status = session.attentionReason
              ? attentionLabel(session.attentionReason)
              : activityLabel(session.activityState);
            return (
              <button
                className={`queue-chip tone-${sessionTone(session)}`}
                data-testid="queue-chip"
                key={session.id}
                type="button"
                onClick={() => onSelect(session.id)}
              >
                <Icon name={attentionIcon(session)} />
                <span className="queue-chip-body">
                  <strong>{identity.primary}</strong>
                  <small>{status}</small>
                </span>
                <code>{identity.locator}</code>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
