import { useState } from "react";

import type {
  ItermWindowLayoutRecord,
  RecoveryRecord,
  SessionAtlasHealth,
  SessionSummary,
  UpdateThreadTagsInput,
  UpsertHandoffInput,
} from "../shared/types";
import { countPendingContinuationItems } from "./continuation-model";
import { ContinuationInbox } from "./ContinuationInbox";
import { ContinuationShelf } from "./ContinuationShelf";
import { Icon } from "./icons";
import { openThreadLocations } from "./OpenThreadAction";
import { RecoveryShelf } from "./RecoveryShelf";
import { useRecoveryPreviews } from "./useRecoveryPreviews";
import { WindowLayoutSection } from "./WindowLayoutSection";

type RailFold = "reference" | "layout";

interface InboxRailProps {
  records: RecoveryRecord[];
  sessions: SessionSummary[];
  closedRecoveries: RecoveryRecord[];
  restartSessionIds: string[];
  closedWindowLayouts: ItermWindowLayoutRecord[];
  health: SessionAtlasHealth;
  busyId: string | null;
  recoveryBusy: boolean;
  openBusy: boolean;
  layoutBusyId: string | null;
  query: string;
  selectedTags: readonly string[];
  tagSuggestions: readonly string[];
  handoffTarget?: string;
  handoffErrorCode?: string;
  cardThreadId: string | null;
  registration: { sessionId?: string } | null;
  onRegistration: (registration: { sessionId?: string } | null) => void;
  onCardThread: (threadId: string | null) => void;
  onFinishTarget: () => void;
  onSave: (sessionId: string, input: UpsertHandoffInput) => Promise<boolean>;
  onRemove: (sessionId: string, expectedVersion: string | null) => Promise<boolean>;
  onResume: (sessionId: string) => Promise<"focused" | "restored" | null>;
  onCloseSession: (sessionId: string, terminalSessionId: string) => Promise<boolean>;
  onOpenRecovery: (sessionId: string) => Promise<"focused" | "restored" | null>;
  onRestoreRecoveries: (sessionIds: string[]) => Promise<boolean>;
  onRestoreLayout: (windowId: string) => void;
  onFocusSession: (sessionId: string) => Promise<boolean>;
  onOpenSession: (sessionId: string) => void;
  onUpdateTags: (threadId: string, input: UpdateThreadTagsInput) => Promise<boolean>;
}

export function InboxRail({
  records, sessions, closedRecoveries, restartSessionIds, closedWindowLayouts, health,
  busyId, recoveryBusy, openBusy, layoutBusyId, query, selectedTags, tagSuggestions,
  handoffTarget, handoffErrorCode, cardThreadId, registration, onRegistration, onCardThread, onFinishTarget,
  onSave, onRemove, onResume, onCloseSession, onOpenRecovery, onRestoreRecoveries, onRestoreLayout,
  onFocusSession, onOpenSession, onUpdateTags,
}: InboxRailProps) {
  const [recoveryOpen, setRecoveryOpen] = useState(true);
  const [openFold, setOpenFold] = useState<RailFold | null>(null);
  const recoveryPreviews = useRecoveryPreviews(closedRecoveries, recoveryOpen);

  const scoped = Boolean(handoffTarget) || cardThreadId !== null || registration !== null;
  const scopedRecord = cardThreadId ? records.find((record) => record.sessionId === cardThreadId) : undefined;
  const pendingCount = countPendingContinuationItems(records);
  const referenceCount = records.filter((record) => record.handoff?.reference).length;
  const canUseIterm = health.iterm === "online";
  const closeScoped = () => {
    onRegistration(null);
    onCardThread(null);
    onFinishTarget();
  };
  const toggleFold = (fold: RailFold) => setOpenFold((current) => (current === fold ? null : fold));

  return (
    <div className="inbox-rail-body">
      <section className="rail-continuation" data-testid="rail-continuation">
        <h2 className="rail-section-heading">
          <Icon name="pin" /><strong>待续</strong><em>{pendingCount}</em>
          {scoped ? (
            <button className="continuation-back" type="button" onClick={closeScoped}>返回待续列表</button>
          ) : <button className="continuation-back" type="button" onClick={() => onRegistration({})}>登记 / 收藏</button>}
        </h2>
        <div className="rail-continuation-body">
          {scoped ? (
            <ContinuationShelf
              key={handoffTarget ?? (registration ? `register:${registration.sessionId ?? "manual"}` : cardThreadId) ?? "shortcut"}
              records={handoffTarget || registration ? records : records.filter((record) => record.sessionId === cardThreadId)}
              sessions={handoffTarget || registration ? sessions : openThreadLocations(sessions, cardThreadId!)}
              target={handoffTarget ?? registration?.sessionId}
              initialView={handoffTarget ? undefined : registration ? "continuation" : ((scopedRecord?.handoff?.items.some((item) => item.status === "pending")
                || !scopedRecord?.handoff?.reference) ? "continuation" : "reference")}
              hideHeading
              shortcutErrorCode={handoffErrorCode}
              onFinishTarget={closeScoped}
              query={query}
              selectedTags={selectedTags}
              tagSuggestions={tagSuggestions}
              onUpdateTags={onUpdateTags}
              canUseIterm={canUseIterm}
              busyId={busyId}
              onSave={onSave}
              onRemove={onRemove}
              onResume={onResume}
              onOpenSession={onOpenSession}
              onFocusSession={onFocusSession}
              onCloseSession={onCloseSession}
            />
          ) : (
            <ContinuationInbox
              records={records}
              sessions={sessions}
              query={query}
              selectedTags={selectedTags}
              canUseIterm={canUseIterm}
              busyId={busyId}
              onSave={onSave}
              onResume={onResume}
              onOpenSession={onOpenSession}
              onFocusSession={onFocusSession}
              onOpenCard={(record) => onCardThread(record.sessionId)}
            />
          )}
        </div>
      </section>

      {closedRecoveries.length ? (
        <section className={`rail-section${recoveryOpen ? " is-open" : ""}`} data-testid="rail-recovery">
          <button
            aria-expanded={recoveryOpen}
            className="rail-section-toggle"
            type="button"
            onClick={() => setRecoveryOpen((open) => !open)}
          >
            <Icon name="clock" /><strong>最近关闭</strong><em>{closedRecoveries.length}</em>
            <Icon name="chevron" />
          </button>
          {recoveryOpen ? (
            <div className="rail-section-body">
              <RecoveryShelf
                records={closedRecoveries}
                tagSuggestions={tagSuggestions}
                onUpdateTags={onUpdateTags}
                restartSessionIds={restartSessionIds}
                canRestore={canUseIterm}
                busy={recoveryBusy}
                sessions={sessions}
                openBusy={openBusy}
                onOpen={onOpenRecovery}
                onFocusSession={onFocusSession}
                onOpenSession={onOpenSession}
                previews={recoveryPreviews.previews}
                previewLoading={recoveryPreviews.loading}
                previewError={recoveryPreviews.error}
                onRestore={onRestoreRecoveries}
              />
            </div>
          ) : null}
        </section>
      ) : null}

      {referenceCount ? (
        <section className={`rail-section rail-fold${openFold === "reference" ? " is-open" : ""}`} data-testid="rail-reference">
          <button
            aria-expanded={openFold === "reference"}
            className="rail-section-toggle"
            type="button"
            onClick={() => toggleFold("reference")}
          >
            <Icon name="pin" /><strong>可能有用</strong><em>{referenceCount}</em>
            <Icon name="chevron" />
          </button>
          {openFold === "reference" ? (
            <div className="rail-section-body">
              <ContinuationShelf
                key="reference-fold"
                records={records}
                sessions={sessions}
                view="reference"
                hideTabs
                hideHeading
                onViewChange={(next, sessionId) => {
                  if (next === "continuation") {
                    setOpenFold(null);
                    if (sessionId) { onRegistration({ sessionId }); onCardThread(sessionId); }
                  }
                }}
                query={query}
                selectedTags={selectedTags}
                tagSuggestions={tagSuggestions}
                onUpdateTags={onUpdateTags}
                canUseIterm={canUseIterm}
                busyId={busyId}
                onSave={onSave}
                onRemove={onRemove}
                onResume={onResume}
                onOpenSession={onOpenSession}
                onFocusSession={onFocusSession}
                onCloseSession={onCloseSession}
              />
            </div>
          ) : null}
        </section>
      ) : null}

      {closedWindowLayouts.length ? (
        <section className={`rail-section rail-fold${openFold === "layout" ? " is-open" : ""}`} data-testid="rail-layout">
          <button
            aria-expanded={openFold === "layout"}
            className="rail-section-toggle"
            type="button"
            onClick={() => toggleFold("layout")}
          >
            <Icon name="layout" /><strong>窗口布局</strong><em>{closedWindowLayouts.length}</em>
            <Icon name="chevron" />
          </button>
          {openFold === "layout" ? (
            <div className="rail-section-body">
              <WindowLayoutSection
                layouts={closedWindowLayouts}
                health={health}
                busyId={layoutBusyId}
                onRestore={onRestoreLayout}
              />
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
