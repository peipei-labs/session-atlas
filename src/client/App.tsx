import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { SessionSummary } from "../shared/types";
import { applyAppearance, persistAppearance, readAppearance, type Appearance } from "./appearance";
import {
  buildNavigationQueue,
  chooseInitialSessionId,
  continuityLaneLabel,
  displaySessionName,
  findClosedWindowLayouts,
  findRestartRecoveryIds,
  type ContinuityLane,
} from "./attention-model";
import { CreateThreadDialog } from "./CreateThreadDialog";
import { MemoryToolbar } from "./MemoryPanel";
import { useMemorySnapshot } from "./useMemorySnapshot";
import { presentMemory } from "./memory-model";
import { Header } from "./Header";
import { HoneycombBoard, type BoardGrouping } from "./HoneycombBoard";
import { InboxRail } from "./InboxRail";
import { LaneRail } from "./LaneRail";
import { SessionShelf } from "./SessionShelf";
import { formatTime } from "./format";
import { Icon } from "./icons";
import { useSessionAtlas } from "./useSessionAtlas";
import { Workbench } from "./Workbench";
import { readBoardGrouping, persistBoardGrouping } from "./board-preferences";
import { getSavedThreadId } from "./SavedThreadStatus";
import { ThreadTagFilter } from "./ThreadTags";
import { collectThreadTags, matchesThreadTags, tagKey } from "./thread-tags-model";

const SELECTION_STORAGE_KEY = "session-atlas.selection.v2";

type MobileRail = "lanes" | "inbox";

export { findRestartRecoveryIds } from "./attention-model";

function matchesQuery(session: SessionSummary, rawQuery: string): boolean {
  const query = rawQuery.trim().toLocaleLowerCase("zh-CN");
  if (!query) {
    return true;
  }

  return [
    displaySessionName(session),
    session.projectName,
    session.title,
    session.cwd,
    session.branch,
    session.currentActivity,
    session.conversationId,
    session.terminalSessionId,
    session.terminal?.tty,
    ...(session.tags ?? []),
  ].some((value) => value?.toLocaleLowerCase("zh-CN").includes(query));
}

function readPersistedSelection(): string | undefined {
  try {
    const value = window.localStorage.getItem(SELECTION_STORAGE_KEY)?.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function persistSelection(sessionId: string): void {
  try {
    window.localStorage.setItem(SELECTION_STORAGE_KEY, sessionId);
  } catch {
    // A denied localStorage write must not block the local dashboard.
  }
}

export function isInteractiveShortcutTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== "function") {
    return false;
  }
  return Boolean(
    (target as Element).closest(
      'input, textarea, select, button, a[href], [role="button"], [contenteditable="true"]',
    ),
  );
}

export default function App() {
  const controller = useSessionAtlas();
  const [query, setQuery] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [handoffTarget, setHandoffTarget] = useState(() => new URLSearchParams(window.location.search).get("handoff") ?? undefined);
  const [handoffErrorCode, setHandoffErrorCode] = useState(() => new URLSearchParams(window.location.search).get("handoffError") ?? undefined);
  const [cardThreadId, setCardThreadId] = useState<string | null>(null);
  const [registration, setRegistration] = useState<{ sessionId?: string } | null>(null);
  const [laneFilter, setLaneFilter] = useState<ContinuityLane | null>(null);
  const [mobileRail, setMobileRail] = useState<MobileRail | null>(() => handoffTarget ? "inbox" : null);
  const [advanceFromId, setAdvanceFromId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [appearance, setAppearance] = useState<Appearance>(readAppearance);
  const [boardGrouping, setBoardGrouping] = useState<BoardGrouping>(readBoardGrouping);
  const changeBoardGrouping = (grouping: BoardGrouping) => {
    setBoardGrouping(grouping);
    persistBoardGrouping(grouping);
  };
  const deferredQuery = useDeferredValue(query);
  const searchRef = useRef<HTMLInputElement>(null);
  const persistedSelectionRef = useRef<string | undefined>(readPersistedSelection());

  const allSessions = controller.snapshot?.sessions ?? [];
  const memoryReady = import.meta.env.VITE_SESSION_ATLAS_DEMO !== "1" && controller.snapshot?.health.iterm === "online" && allSessions.some((s) => !s.stale && s.terminalSessionId);
  const memory = useMemorySnapshot(memoryReady);
  const memoryBridgeOnline = controller.snapshot?.health.iterm === "online";
  const memoryPresentation = useMemo(() => presentMemory(memory.snapshot, allSessions, memoryBridgeOnline), [memory.snapshot, allSessions, memoryBridgeOnline]);
  const tagOptions = useMemo(() => collectThreadTags(allSessions, controller.snapshot?.recoveries ?? []),
    [allSessions, controller.snapshot?.recoveries]);
  const tagSuggestions = useMemo(() => tagOptions.map(({ tag }) => tag), [tagOptions]);
  const changeTagSelection = (next: string[]) => {
    setSelectedTags(next);
    const matches = allSessions.filter((session) => matchesQuery(session, query) && matchesThreadTags(session.tags, next));
    if (!matches.some((session) => session.id === selectedId)) setSelectedId(buildNavigationQueue(matches)[0]?.id ?? null);
  };
  const toggleTag = (tag: string) => changeTagSelection(selectedTags.some((value) => tagKey(value) === tagKey(tag))
    ? selectedTags.filter((value) => tagKey(value) !== tagKey(tag)) : [...selectedTags, tag]);
  const allClosedRecoveries = useMemo(() => {
    return (controller.snapshot?.recoveries ?? [])
      .filter((recovery) => recovery.status === "closed")
      .sort(
        (left, right) =>
          Date.parse(right.closedAt ?? right.lastSeenAt) -
          Date.parse(left.closedAt ?? left.lastSeenAt),
      );
  }, [controller.snapshot?.recoveries]);
  const closedRecoveries = useMemo(() => {
    const normalizedQuery = deferredQuery.trim().toLocaleLowerCase("zh-CN");
    return allClosedRecoveries.filter(
        (recovery) =>
          matchesThreadTags(recovery.tags, selectedTags) && (!normalizedQuery ||
          [
            recovery.title,
            recovery.projectName,
            recovery.cwd,
            recovery.sessionId,
            recovery.resumeCommand,
            ...(recovery.tags ?? []),
          ].some((value) => value.toLocaleLowerCase("zh-CN").includes(normalizedQuery))),
      );
  }, [allClosedRecoveries, deferredQuery, selectedTags]);
  const restartRecoveryIds = useMemo(
    () => findRestartRecoveryIds(allClosedRecoveries, allSessions),
    [allClosedRecoveries, allSessions],
  );
  const closedWindowLayouts = useMemo(
    () => findClosedWindowLayouts(controller.snapshot?.windowLayouts ?? []),
    [controller.snapshot?.windowLayouts],
  );
  const filteredSessions = useMemo(
    () => allSessions.filter((session) => matchesQuery(session, deferredQuery) && matchesThreadTags(session.tags, selectedTags)),
    [allSessions, deferredQuery, selectedTags],
  );
  const routeSessions = useMemo(
    () => filteredSessions.filter((session) => !session.buried),
    [filteredSessions],
  );
  const buriedSessions = useMemo(
    () => filteredSessions.filter((session) => session.buried),
    [filteredSessions],
  );
  const navigationSessions = useMemo(
    () => buildNavigationQueue(routeSessions),
    [routeSessions],
  );
  const selectedSession = allSessions.find((session) => session.id === selectedId);
  const focusedSession = allSessions.find((session) => session.focused && !session.stale);

  useEffect(() => {
    applyAppearance(appearance);
    persistAppearance(appearance);
  }, [appearance]);

  useEffect(() => {
    if (!allSessions.length) {
      setSelectedId(null);
      return;
    }

    setSelectedId((current) => {
      if (current && allSessions.some((session) => session.id === current)) {
        return current;
      }
      const next = chooseInitialSessionId(allSessions, persistedSelectionRef.current);
      persistedSelectionRef.current = undefined;
      return next ?? null;
    });
  }, [allSessions]);

  useEffect(() => {
    if (selectedId) {
      persistSelection(selectedId);
    }
  }, [selectedId]);

  const selectSession = useCallback((sessionId: string, openDetail = true) => {
    setSelectedId(sessionId);
    setDetailOpen(openDetail);
  }, []);

  const closeDetail = useCallback(() => {
    setDetailOpen(false);
    // Return focus to the selected cell after the drawer closes.
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(".honey-cell.is-selected .honey-hit")?.focus();
    });
  }, []);

  const finishHandoffTarget = useCallback(() => {
    setRegistration(null);
    setHandoffTarget(undefined);
    setHandoffErrorCode(undefined);
    const url = new URL(window.location.href);
    if (url.searchParams.has("handoff") || url.searchParams.has("handoffError")) {
      url.searchParams.delete("handoff");
      url.searchParams.delete("handoffError");
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    }
  }, []);

  const openSessionEverywhere = useCallback((sessionId: string) => {
    finishHandoffTarget();
    setCardThreadId(null);
    setMobileRail(null);
    selectSession(sessionId);
  }, [finishHandoffTarget, selectSession]);

  const changeQuery = useCallback(
    (nextQuery: string) => {
      setQuery(nextQuery);
      const matches = allSessions.filter((session) => matchesQuery(session, nextQuery) && matchesThreadTags(session.tags, selectedTags));
      if (!matches.some((session) => session.id === selectedId)) {
        setSelectedId(buildNavigationQueue(matches)[0]?.id ?? null);
      }
    },
    [allSessions, selectedId, selectedTags],
  );

  const focusInIterm = useCallback(
    async (sessionId: string): Promise<boolean> => {
      const success = await controller.focus(sessionId);
      if (success) {
        setAnnouncement("已切换到 iTerm");
      }
      return success;
    },
    [controller],
  );

  const moveSelection = useCallback(
    (direction: 1 | -1) => {
      if (!navigationSessions.length) {
        return;
      }
      const currentIndex = navigationSessions.findIndex((session) => session.id === selectedId);
      const baseIndex = currentIndex < 0 ? (direction > 0 ? -1 : 0) : currentIndex;
      const nextIndex =
        (baseIndex + direction + navigationSessions.length) % navigationSessions.length;
      const next = navigationSessions[nextIndex];
      if (next) {
        setSelectedId(next.id);
      }
    },
    [navigationSessions, selectedId],
  );

  useEffect(() => {
    if (!advanceFromId) {
      return;
    }
    const handledSession = allSessions.find((session) => session.id === advanceFromId);
    if (handledSession?.pendingRequest || handledSession?.attentionReason) {
      return;
    }

    const next = buildNavigationQueue(routeSessions).find(
      (session) => session.id !== advanceFromId,
    );
    if (next) {
      setSelectedId(next.id);
      setAnnouncement("已处理，继续下一项");
    } else {
      setAnnouncement("当前处理队列已清空");
    }
    setAdvanceFromId(null);
  }, [advanceFromId, allSessions, routeSessions]);

  useEffect(() => {
    if (!announcement) {
      return;
    }
    const timeoutId = window.setTimeout(() => setAnnouncement(""), 2_400);
    return () => window.clearTimeout(timeoutId);
  }, [announcement]);

  useEffect(() => {
    const focusPrimaryAction = () => {
      setDetailOpen(true);
      window.requestAnimationFrame(() => {
        document
          .querySelector<HTMLElement>('[data-primary-action="true"]:not(:disabled)')
          ?.focus();
      });
    };

    const handleKeyboard = (event: KeyboardEvent) => {
      const key = event.key.toLocaleLowerCase();
      if ((event.metaKey || event.ctrlKey) && key === "k") {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && key === "n") {
        event.preventDefault();
        setCreateDialogOpen(true);
        return;
      }
      if (event.key === "Escape") {
        if (detailOpen) {
          closeDetail();
        }
        setCreateDialogOpen(false);
        finishHandoffTarget();
        setCardThreadId(null);
        setMobileRail(null);
        return;
      }
      if (
        isInteractiveShortcutTarget(event.target) ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return;
      }
      if (key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        moveSelection(1);
        return;
      }
      if (key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        moveSelection(-1);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        focusPrimaryAction();
        return;
      }
      if (
        key === "f" &&
        selectedSession &&
        !selectedSession.stale &&
        selectedSession.capabilities.focus
      ) {
        event.preventDefault();
        void focusInIterm(selectedSession.id);
      }
    };

    window.addEventListener("keydown", handleKeyboard);
    return () => window.removeEventListener("keydown", handleKeyboard);
  }, [closeDetail, detailOpen, finishHandoffTarget, focusInIterm, moveSelection, selectedSession]);

  const health = controller.snapshot?.health ?? {
    controller: "degraded" as const,
    codex: "offline" as const,
    iterm: "offline" as const,
    message: controller.loading ? "正在连接" : "控制器不可用",
  };
  const drawerVisible = Boolean(detailOpen && selectedSession);
  const boardMessage = !controller.snapshot
    ? controller.loading
      ? "正在连接本地会话…"
      : "控制器不可用"
    : (query || selectedTags.length > 0) && filteredSessions.length === 0
      ? "没有匹配的会话"
      : allSessions.length === 0
        ? "未发现会话"
        : null;

  return (
    <div className={`atlas-shell${drawerVisible ? " is-detail-open" : ""}`}>
      <Header
        health={health}
        query={query}
        canCreateThread={health.codex === "online"}
        searchInputRef={searchRef}
        appearance={appearance}
        onAppearanceChange={setAppearance}
        onCreateThread={() => setCreateDialogOpen(true)}
        onQueryChange={changeQuery}
        onToggleLanes={() => setMobileRail((current) => (current === "lanes" ? null : "lanes"))}
        onToggleInbox={() => setMobileRail((current) => (current === "inbox" ? null : "inbox"))}
      />

      <div className="atlas-main">
        <aside className={`lane-rail${mobileRail === "lanes" ? " is-open" : ""}`}>
          <LaneRail
            sessions={routeSessions}
            focusedSession={focusedSession}
            laneFilter={laneFilter}
            onLaneFilter={setLaneFilter}
            onSelect={(sessionId) => {
              setMobileRail(null);
              selectSession(sessionId);
            }}
          />
          <ThreadTagFilter tags={tagOptions} selected={selectedTags} onToggle={toggleTag} onClear={() => changeTagSelection([])} />
          {buriedSessions.length ? (
            <SessionShelf
              label="已收起"
              sessions={buriedSessions}
              selectedId={selectedSession?.id}
              focusPending={Boolean(controller.busyAction)}
              onSelect={(sessionId) => {
                setMobileRail(null);
                selectSession(sessionId);
              }}
              onFocus={(sessionId) => {
                void focusInIterm(sessionId);
              }}
            />
          ) : null}
        </aside>

        <div className="board-column">
          <div className="board-toolbar">
            <div className="board-grouping" aria-label="聚簇方式" role="group">
              <button
                aria-pressed={boardGrouping === "project"}
                className={`grouping-option${boardGrouping === "project" ? " is-active" : ""}`}
                onClick={() => changeBoardGrouping("project")}
                type="button"
              >
                按项目
              </button>
              <button
                aria-pressed={boardGrouping === "window"}
                className={`grouping-option${boardGrouping === "window" ? " is-active" : ""}`}
                onClick={() => changeBoardGrouping("window")}
                type="button"
              >
                按窗口
              </button>
            </div>
            <MemoryToolbar memory={memory} ready={memoryReady} />
            {laneFilter ? (
              <button
                className="lane-filter-chip"
                type="button"
                onClick={() => setLaneFilter(null)}
              >
                <span>筛选：{continuityLaneLabel(laneFilter)}</span>
                <Icon name="close" />
              </button>
            ) : null}
          </div>

          <HoneycombBoard
            memory={memory.enabled ? memoryPresentation : undefined}
            sessions={routeSessions}
            recoveries={controller.snapshot?.recoveries}
            selectedId={selectedSession?.id}
            busyAction={controller.busyAction}
            groupBy={boardGrouping}
            laneFilter={laneFilter}
            onSelect={(sessionId) => selectSession(sessionId)}
            onFocus={(sessionId) => {
              void focusInIterm(sessionId);
            }}
          />

          {boardMessage ? (
            <div className="board-empty" role="status">
              <Icon name="atlas" />
              <p>{boardMessage}</p>
            </div>
          ) : null}
        </div>

        <aside className={`inbox-rail${mobileRail === "inbox" ? " is-open" : ""}`}>
          <InboxRail
            records={controller.snapshot?.recoveries ?? []}
            sessions={allSessions}
            closedRecoveries={closedRecoveries}
            restartSessionIds={restartRecoveryIds}
            closedWindowLayouts={closedWindowLayouts}
            health={health}
            busyId={controller.handoffBusyId ?? controller.busyAction}
            recoveryBusy={controller.recoveryBusy}
            openBusy={controller.handoffBusyId !== null || controller.busyAction !== null}
            layoutBusyId={controller.layoutBusyId}
            query={deferredQuery}
            selectedTags={selectedTags}
            tagSuggestions={tagSuggestions}
            handoffTarget={handoffTarget}
            handoffErrorCode={handoffErrorCode}
            cardThreadId={cardThreadId}
            registration={registration}
            onRegistration={setRegistration}
            onCardThread={setCardThreadId}
            onFinishTarget={finishHandoffTarget}
            onSave={controller.saveHandoff}
            onRemove={controller.removeHandoff}
            onResume={controller.resumeHandoff}
            onCloseSession={controller.closeHandoff}
            onOpenRecovery={controller.openRecovery}
            onRestoreRecoveries={async (sessionIds) =>
              Boolean(await controller.restoreClosedSessions(sessionIds))
            }
            onRestoreLayout={(windowId) => {
              void controller.restoreWindowLayout(windowId).then((success) => {
                if (success) setAnnouncement("已请求恢复窗口布局");
              });
            }}
            onFocusSession={controller.focus}
            onOpenSession={openSessionEverywhere}
            onUpdateTags={controller.updateThreadTags}
          />
        </aside>
      </div>

      {mobileRail ? (
        <div className="rail-scrim" onClick={() => setMobileRail(null)} />
      ) : null}

      <footer className="board-dock">
        <div className="dock-legend" aria-label="状态图例">
          <span><i className="legend-dot is-attention" />等待你</span>
          <span><i className="legend-dot is-running" />后台推进</span>
          <span><i className="legend-dot is-returnable" />可返回</span>
          <span><i className="legend-dot is-later" />稍后</span>
        </div>

        <div className="keyboard-legend" aria-label="键盘快捷键">
          <span><kbd>J</kbd><kbd>K</kbd>选择</span>
          <span><kbd>Enter</kbd>处理</span>
          <span><kbd>F</kbd>iTerm</span>
        </div>
        <button className="next-session-button" type="button" onClick={() => moveSelection(1)}>
          <span>下一项</span>
          <Icon name="arrow" />
        </button>
        <span className="footer-status">
          {controller.snapshot ? (
            <time dateTime={controller.snapshot.generatedAt}>
              {formatTime(controller.snapshot.generatedAt, true)}
            </time>
          ) : (
            "--:--:--"
          )}
          <Icon name="refresh" />
        </span>
      </footer>

      {drawerVisible && selectedSession ? (
          <Workbench
            memoryEnabled={memory.enabled}
            memory={selectedSession.terminalSessionId ? memoryPresentation.byTerminal.get(selectedSession.terminalSessionId) : undefined}
            memorySampledAt={memoryPresentation.sampledAt}
            session={selectedSession}
            tagSuggestions={tagSuggestions}
            onUpdateTags={controller.updateThreadTags}
            recovery={controller.snapshot ? controller.snapshot.recoveries.find((record) => record.sessionId === getSavedThreadId(selectedSession)) ?? null : undefined}
            focusedSession={focusedSession}
            open={detailOpen}
            busyAction={controller.busyAction}
            onClose={closeDetail}
            onSelect={(sessionId) => selectSession(sessionId)}
            onFocus={(sessionId) => void focusInIterm(sessionId)}
            onSend={async (sessionId, text) => {
              setSelectedId(sessionId);
              const success = await controller.sendMessage(sessionId, text);
              if (success && allSessions.find((session) => session.id === sessionId)?.attentionReason) {
                setAdvanceFromId(sessionId);
              }
              return success;
            }}
            onInterrupt={(sessionId) => {
              setSelectedId(sessionId);
              void controller.interrupt(sessionId);
            }}
            onRespond={async (sessionId, requestId, input) => {
              setSelectedId(sessionId);
              const success = await controller.respond(sessionId, requestId, input);
              if (success) {
                setAdvanceFromId(sessionId);
              }
              return success;
            }}
            onUpdateAttention={(sessionId, input) => {
              setSelectedId(sessionId);
              void controller.updateAttention(sessionId, input).then((success) => {
                if (success && input.acknowledge) {
                  setAdvanceFromId(sessionId);
                }
              });
            }}
          />
      ) : null}

      <div className="continuity-announcement" role="status" aria-live="polite">
        {announcement}
      </div>

      {controller.error ? (
        <div className="error-banner" role="alert">
          <Icon name="alert" />
          <span>{controller.error}</span>
          <button type="button" aria-label="关闭" onClick={controller.dismissError}>
            <Icon name="close" />
          </button>
        </div>
      ) : null}

      {createDialogOpen ? (
        <CreateThreadDialog
          defaultCwd={selectedSession?.cwd ?? ""}
          busy={controller.busyAction === "create-thread"}
          onClose={() => setCreateDialogOpen(false)}
          onCreate={async (input) => {
            const session = await controller.createManagedThread(input);
            if (!session) {
              return false;
            }
            setQuery("");
            setSelectedId(session.id);
            setDetailOpen(true);
            return true;
          }}
        />
      ) : null}

    </div>
  );
}
