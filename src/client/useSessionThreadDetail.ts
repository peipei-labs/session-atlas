import { useEffect, useState } from "react";

import type { SessionSummary, SessionThreadDetail } from "../shared/types";
import { fetchSessionDetail } from "./api";

const demoMode = import.meta.env.VITE_SESSION_ATLAS_DEMO === "1";

interface DetailState {
  sessionId?: string;
  detail?: SessionThreadDetail;
  error?: string;
  loading: boolean;
}

export interface SessionThreadDetailState {
  detail?: SessionThreadDetail;
  error?: string;
  loading: boolean;
}

export function useSessionThreadDetail(
  session: SessionSummary | undefined,
  open: boolean,
): SessionThreadDetailState {
  const [state, setState] = useState<DetailState>({ loading: false });
  const shouldLoad = Boolean(
    !demoMode &&
      open &&
      session &&
      session.provider === "codex" &&
      session.conversationId,
  );
  const latestActivityId = session?.activities[0]?.id;

  useEffect(() => {
    if (!shouldLoad || !session) return;

    const abortController = new AbortController();
    let stopped = false;

    const load = async (): Promise<void> => {
      setState({ sessionId: session.id, loading: true });
      try {
        const detail = await fetchSessionDetail(session.id, abortController.signal);
        if (!stopped) {
          setState({ sessionId: session.id, detail, loading: false });
        }
      } catch (reason) {
        if (!stopped && !abortController.signal.aborted) {
          setState({
            sessionId: session.id,
            error: reason instanceof Error ? reason.message : "执行记录暂时无法读取",
            loading: false,
          });
        }
      }
    };

    void load();
    return () => {
      stopped = true;
      abortController.abort();
    };
  }, [session?.id, session?.runtimeId, session?.lastTurnStatus, session?.currentActivity, session?.plan?.done, latestActivityId, shouldLoad]);

  if (!session || state.sessionId !== session.id) {
    return { loading: shouldLoad };
  }
  return {
    detail: state.detail,
    error: state.error,
    loading: state.loading,
  };
}
