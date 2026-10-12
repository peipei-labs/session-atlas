import { useCallback, useEffect, useRef, useState } from "react";

import type {
  CreateThreadInput,
  RecoveryRecord,
  RespondRequestInput,
  RestoreRecoveriesResult,
  SendMessageInput,
  SessionAtlasEvent,
  SessionAtlasSnapshot,
  SessionSummary,
  UpdateAttentionInput,
  UpdateThreadTagsInput,
  UpsertHandoffInput,
} from "../shared/types";
import {
  ApiRequestError,
  createThread,
  closeHandoff,
  deleteHandoff,
  fetchSnapshot,
  fetchThreadTags,
  focusSession,
  interruptSession,
  openRecovery,
  patchAttention,
  patchThreadTags,
  putHandoff,
  respondToRequest,
  restoreRecoveries,
  restoreWindowLayout,
  resumeHandoff,
  sendSessionMessage,
} from "./api";
import { createDemoManagedSession, createDemoSnapshot } from "./demo";
import { getSavedThreadId } from "./SavedThreadStatus";
import { tagKey } from "./thread-tags-model";
import { applyThreadTagUpdate } from "../shared/thread-tags";

const demoMode = import.meta.env.VITE_SESSION_ATLAS_DEMO === "1";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请稍后重试";
}

function updateSession(
  snapshot: SessionAtlasSnapshot | null,
  sessionId: string,
  updater: (session: SessionSummary) => SessionSummary,
): SessionAtlasSnapshot | null {
  if (!snapshot) {
    return snapshot;
  }

  return {
    ...snapshot,
    generatedAt: new Date().toISOString(),
    sessions: snapshot.sessions.map((session) =>
      session.id === sessionId ? updater(session) : session,
    ),
  };
}

function applyEvent(
  current: SessionAtlasSnapshot | null,
  event: SessionAtlasEvent,
): SessionAtlasSnapshot | null {
  if (event.type === "snapshot") {
    return !current || event.snapshot.revision >= current.revision
      ? event.snapshot
      : current;
  }

  if (!current || event.revision < current.revision) {
    return current;
  }

  if (event.type === "session-upsert") {
    const index = current.sessions.findIndex((session) => session.id === event.session.id);
    const sessions = [...current.sessions];
    if (index >= 0) {
      sessions[index] = event.session;
    } else {
      sessions.push(event.session);
    }
    return { ...current, revision: event.revision, sessions };
  }

  if (event.type === "session-remove") {
    return {
      ...current,
      revision: event.revision,
      sessions: current.sessions.filter((session) => session.id !== event.sessionId),
    };
  }

  if (event.type === "recovery-upsert") {
    const index = current.recoveries.findIndex(
      (recovery) => recovery.sessionId === event.recovery.sessionId,
    );
    const recoveries = [...current.recoveries];
    if (index >= 0) {
      recoveries[index] = event.recovery;
    } else {
      recoveries.push(event.recovery);
    }
    return { ...current, revision: event.revision, recoveries };
  }

  if (event.type === "recovery-remove") {
    return {
      ...current,
      revision: event.revision,
      recoveries: current.recoveries.filter((recovery) => recovery.sessionId !== event.sessionId),
    };
  }

  if (event.type === "layout-upsert") {
    const index = current.windowLayouts.findIndex(
      (layout) => layout.windowId === event.layout.windowId,
    );
    const windowLayouts = [...current.windowLayouts];
    if (index >= 0) windowLayouts[index] = event.layout;
    else windowLayouts.push(event.layout);
    return { ...current, revision: event.revision, windowLayouts };
  }

  if (event.type === "layout-remove") {
    return {
      ...current,
      revision: event.revision,
      windowLayouts: current.windowLayouts.filter((layout) => layout.windowId !== event.windowId),
    };
  }

  return { ...current, revision: event.revision, health: event.health };
}

export interface SessionAtlasController {
  snapshot: SessionAtlasSnapshot | null;
  loading: boolean;
  error: string | null;
  busyAction: string | null;
  recoveryBusy: boolean;
  layoutBusyId: string | null;
  handoffBusyId: string | null;
  dismissError: () => void;
  createManagedThread: (input: CreateThreadInput) => Promise<SessionSummary | null>;
  focus: (sessionId: string) => Promise<boolean>;
  sendMessage: (sessionId: string, text: string) => Promise<boolean>;
  interrupt: (sessionId: string) => Promise<boolean>;
  respond: (
    sessionId: string,
    requestId: string,
    input: RespondRequestInput,
  ) => Promise<boolean>;
  updateAttention: (sessionId: string, input: UpdateAttentionInput) => Promise<boolean>;
  updateThreadTags: (sessionId: string, input: UpdateThreadTagsInput) => Promise<boolean>;
  restoreClosedSessions: (sessionIds: string[]) => Promise<RestoreRecoveriesResult | null>;
  restoreWindowLayout: (windowId: string) => Promise<boolean>;
  saveHandoff: (sessionId: string, input: UpsertHandoffInput) => Promise<boolean>;
  removeHandoff: (sessionId: string, expectedVersion: string | null) => Promise<boolean>;
  resumeHandoff: (sessionId: string) => Promise<"focused" | "restored" | null>;
  openRecovery: (sessionId: string) => Promise<"focused" | "restored" | null>;
  closeHandoff: (sessionId: string, terminalSessionId: string) => Promise<boolean>;
}

export function useSessionAtlas(): SessionAtlasController {
  const [snapshot, setSnapshot] = useState<SessionAtlasSnapshot | null>(() =>
    demoMode ? createDemoSnapshot() : null,
  );
  const [loading, setLoading] = useState(!demoMode);
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [layoutBusyId, setLayoutBusyId] = useState<string | null>(null);
  const [handoffBusyId, setHandoffBusyId] = useState<string | null>(null);
  const focusPendingRef = useRef(false);
  const recoveryPendingRef = useRef(false);
  const layoutPendingRef = useRef(false);
  const handoffPendingRef = useRef(false);

  const runHandoffAction = useCallback(async <T,>(sessionId: string, action: () => Promise<T>) => {
    if (handoffPendingRef.current) return null;
    handoffPendingRef.current = true;
    setHandoffBusyId(sessionId);
    setError(null);
    try {
      return await action();
    } catch (reason) {
      setError(errorMessage(reason));
      if (reason instanceof ApiRequestError && reason.status === 409) {
        try {
          const latest = await fetchSnapshot();
          setSnapshot((current) => applyEvent(current, { type: "snapshot", snapshot: latest }));
        } catch { /* Keep the conflict message and draft when refresh is unavailable. */ }
      }
      return null;
    } finally {
      handoffPendingRef.current = false;
      setHandoffBusyId(null);
    }
  }, []);

  const saveHandoff = useCallback(async (sessionId: string, input: UpsertHandoffInput) => {
    return Boolean(await runHandoffAction(sessionId, async () => {
      if (!demoMode) {
        await putHandoff(sessionId, input);
        const latest = await fetchSnapshot();
        setSnapshot((current) => applyEvent(current, { type: "snapshot", snapshot: latest }));
        return true;
      }
      setSnapshot((current) => {
        if (!current) return current;
        const existing = current.recoveries.find((record) => record.sessionId === sessionId);
        const now = new Date().toISOString();
        const record: RecoveryRecord = {
          ...(existing ?? {
            sessionId, cwd: input.cwd, title: input.summary,
            projectName: input.cwd.split("/").filter(Boolean).at(-1) ?? "Codex",
            status: "active", firstSeenAt: now, lastSeenAt: now, resumeCommand: "",
          }),
          handoff: {
            summary: input.summary, items: input.items, source: input.source ?? "user", updatedAt: now,
            requiresRunningProcess: input.requiresRunningProcess,
            reference: input.reference === undefined ? existing?.handoff?.reference : input.reference ?? undefined,
          },
        };
        return {
          ...current,
          recoveries: [...current.recoveries.filter((entry) => entry.sessionId !== sessionId), record],
        };
      });
      return true;
    }));
  }, [runHandoffAction]);

  const removeHandoff = useCallback(async (sessionId: string, expectedVersion: string | null) => {
    return Boolean(await runHandoffAction(sessionId, async () => {
      if (!demoMode) {
        await deleteHandoff(sessionId, expectedVersion);
        const latest = await fetchSnapshot();
        setSnapshot((current) => applyEvent(current, { type: "snapshot", snapshot: latest }));
        return true;
      }
      setSnapshot((current) => current ? {
        ...current,
        recoveries: current.recoveries.map((record) => {
          if (record.sessionId !== sessionId) return record;
          const { handoff: _handoff, ...remaining } = record;
          return remaining;
        }),
      } : current);
      return true;
    }));
  }, [runHandoffAction]);

  const resumeHandoffAction = useCallback((sessionId: string) => {
    return runHandoffAction(sessionId, async () => {
      if (demoMode) return "restored" as const;
      return (await resumeHandoff(sessionId)).action;
    });
  }, [runHandoffAction]);

  const openRecoveryAction = useCallback((sessionId: string) => {
    return runHandoffAction(sessionId, async () => {
      if (demoMode) return "restored" as const;
      return (await openRecovery(sessionId)).action;
    });
  }, [runHandoffAction]);

  const closeHandoffAction = useCallback(async (sessionId: string, terminalSessionId: string) => {
    return Boolean(await runHandoffAction(sessionId, async () => {
      if (!demoMode) await closeHandoff(sessionId, terminalSessionId);
      return true;
    }));
  }, [runHandoffAction]);

  useEffect(() => {
    if (demoMode) {
      return;
    }

    const abortController = new AbortController();
    let events: EventSource | null = null;

    void fetchSnapshot(abortController.signal)
      .then((nextSnapshot) => {
        setSnapshot(nextSnapshot);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (!abortController.signal.aborted) {
          setError(errorMessage(reason));
        }
      })
      .finally(() => {
        if (!abortController.signal.aborted) {
          setLoading(false);
        }
      });

    events = new EventSource("/api/events");
    const receive = (message: MessageEvent<string>) => {
      try {
        const event = JSON.parse(message.data) as SessionAtlasEvent;
        setSnapshot((current) => applyEvent(current, event));
        setError(null);
      } catch {
        setError("收到无法识别的会话更新");
      }
    };

    events.onmessage = receive;
    events.onerror = () => {
      setError("实时连接正在重试");
    };

    return () => {
      abortController.abort();
      events?.close();
    };
  }, []);

  const runAction = useCallback(
    async (key: string, action: () => Promise<void>, optimistic?: () => void) => {
      setBusyAction(key);
      setError(null);

      try {
        if (!demoMode) {
          await action();
        }
        optimistic?.();
        return true;
      } catch (reason) {
        setError(errorMessage(reason));
        return false;
      } finally {
        setBusyAction(null);
      }
    },
    [],
  );

  const updateThreadTags = useCallback(async (sessionId: string, input: UpdateThreadTagsInput) => {
    setError(null);
    try {
      if (demoMode) {
        const applyTags = (tags: string[] = []) => applyThreadTagUpdate(tags, input);
        setSnapshot((current) => current ? {
          ...current,
          sessions: current.sessions.map((session) => getSavedThreadId(session) === sessionId
            ? { ...session, tags: applyTags(session.tags) } : session),
          recoveries: current.recoveries.map((record) => record.sessionId === sessionId
            ? { ...record, tags: applyTags(record.tags) } : record),
        } : current);
        return true;
      }
      await patchThreadTags(sessionId, input);
      const saved = await fetchThreadTags(sessionId);
      const keys = new Set(Array.isArray(saved?.tags) ? saved.tags.map(tagKey) : []);
      const confirmed = saved?.sessionId === sessionId && Array.isArray(saved.tags)
        && (input.add ?? []).every((tag) => keys.has(tagKey(tag)))
        && !(input.remove ?? []).some((tag) => keys.has(tagKey(tag)));
      try {
        const latest = await fetchSnapshot();
        setSnapshot((current) => applyEvent(current, { type: "snapshot", snapshot: latest }));
      } catch {
        if (confirmed) setError("标签已保存，但列表刷新失败；请稍后刷新页面查看。");
      }
      if (!confirmed) {
        throw new Error("标签保存结果未确认，或已被另一窗口修改；请查看最新标签。");
      }
      return true;
    } catch (reason) {
      setError(errorMessage(reason));
      return false;
    }
  }, []);

  const focus = useCallback(async (sessionId: string) => {
    if (focusPendingRef.current) return false;
    focusPendingRef.current = true;
    try {
      return await runAction(`focus:${sessionId}`, () => focusSession(sessionId));
    } finally {
      focusPendingRef.current = false;
    }
  }, [runAction]);

  const restoreClosedSessions = useCallback(async (sessionIds: string[]) => {
    if (recoveryPendingRef.current) return null;
    recoveryPendingRef.current = true;
    setRecoveryBusy(true);
    setError(null);
    try {
      if (demoMode) {
        return { requested: sessionIds.length, sessionIds };
      }
      return await restoreRecoveries({ sessionIds });
    } catch (reason) {
      setError(errorMessage(reason));
      return null;
    } finally {
      recoveryPendingRef.current = false;
      setRecoveryBusy(false);
    }
  }, []);

  const restoreWindowLayoutAction = useCallback(async (windowId: string) => {
    if (layoutPendingRef.current) return false;
    layoutPendingRef.current = true;
    setLayoutBusyId(windowId);
    setError(null);
    try {
      if (demoMode) {
        return true;
      }
      await restoreWindowLayout(windowId);
      return true;
    } catch (reason) {
      setError(errorMessage(reason));
      return false;
    } finally {
      layoutPendingRef.current = false;
      setLayoutBusyId(null);
    }
  }, []);

  const createManagedThread = useCallback(async (input: CreateThreadInput) => {
    setBusyAction("create-thread");
    setError(null);

    try {
      const session = demoMode ? createDemoManagedSession(input) : await createThread(input);
      setSnapshot((current) => {
        if (!current) {
          return current;
        }
        const exists = current.sessions.some((item) => item.id === session.id);
        return {
          ...current,
          generatedAt: new Date().toISOString(),
          sessions: exists
            ? current.sessions.map((item) => (item.id === session.id ? session : item))
            : [session, ...current.sessions],
        };
      });
      return session;
    } catch (reason) {
      setError(errorMessage(reason));
      return null;
    } finally {
      setBusyAction(null);
    }
  }, []);

  const sendMessage = useCallback(
    (sessionId: string, text: string) => {
      const input: SendMessageInput = { text };
      return runAction(
        `message:${sessionId}`,
        () => sendSessionMessage(sessionId, input),
        demoMode
          ? () =>
              setSnapshot((current) =>
                updateSession(current, sessionId, (session) => ({
                  ...session,
                  activityState: "running",
                  attentionReason: null,
                  pendingRequest: undefined,
                  currentActivity: text,
                  lastActivityAt: new Date().toISOString(),
                  activities: [
                    {
                      id: `demo-${Date.now()}`,
                      at: new Date().toISOString(),
                      label: `已发送：${text}`,
                    },
                    ...session.activities,
                  ],
                })),
              )
          : undefined,
      );
    },
    [runAction],
  );

  const interrupt = useCallback(
    (sessionId: string) =>
      runAction(
        `interrupt:${sessionId}`,
        () => interruptSession(sessionId),
        demoMode
          ? () =>
              setSnapshot((current) =>
                updateSession(current, sessionId, (session) => ({
                  ...session,
                  activityState: "idle",
                  currentActivity: "任务已中断",
                  lastActivityAt: new Date().toISOString(),
                })),
              )
          : undefined,
      ),
    [runAction],
  );

  const respond = useCallback(
    (sessionId: string, requestId: string, input: RespondRequestInput) =>
      runAction(
        `respond:${requestId}:${input.choiceId}`,
        () => respondToRequest(sessionId, requestId, input),
        demoMode
          ? () =>
              setSnapshot((current) =>
                updateSession(current, sessionId, (session) => ({
                  ...session,
                  activityState: "running",
                  attentionReason: null,
                  pendingRequest: undefined,
                  currentActivity: "已收到你的选择，继续执行",
                  lastActivityAt: new Date().toISOString(),
                })),
              )
          : undefined,
      ),
    [runAction],
  );

  const updateAttention = useCallback(async (sessionId: string, input: UpdateAttentionInput) => {
    setBusyAction(`attention:${sessionId}`);
    setError(null);

    try {
      if (demoMode) {
        setSnapshot((current) =>
          updateSession(current, sessionId, (session) => {
            return {
              ...session,
              ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
              ...(input.parked === undefined ? {} : { parked: input.parked }),
              ...(input.title === undefined ? {} : { title: input.title }),
              ...(input.acknowledge
                ? {
                    acknowledgedAt: new Date().toISOString(),
                    attentionReason: null,
                  }
                : {}),
            };
          }),
        );
      } else {
        const updatedSession = await patchAttention(sessionId, input);
        setSnapshot((current) =>
          updateSession(current, sessionId, () => updatedSession),
        );
      }
      return true;
    } catch (reason) {
      setError(errorMessage(reason));
      return false;
    } finally {
      setBusyAction(null);
    }
  }, []);

  return {
    snapshot,
    loading,
    error,
    busyAction,
    recoveryBusy,
    layoutBusyId,
    handoffBusyId,
    saveHandoff,
    removeHandoff,
    resumeHandoff: resumeHandoffAction,
    openRecovery: openRecoveryAction,
    closeHandoff: closeHandoffAction,
    dismissError: useCallback(() => setError(null), []),
    createManagedThread,
    focus,
    restoreClosedSessions,
    restoreWindowLayout: restoreWindowLayoutAction,
    sendMessage,
    interrupt,
    respond,
    updateAttention,
    updateThreadTags,
  };
}
