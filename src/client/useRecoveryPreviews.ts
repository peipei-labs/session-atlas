import { useEffect, useMemo, useState } from "react";

import type { RecoveryPreview, RecoveryRecord } from "../shared/types";
import { fetchRecoveryPreviews } from "./api";

const demoMode = import.meta.env.VITE_SESSION_ATLAS_DEMO === "1";

interface PreviewState {
  key?: string;
  previews: Record<string, RecoveryPreview>;
  loading: boolean;
  error?: string;
}

export interface RecoveryPreviewState {
  previews: Record<string, RecoveryPreview>;
  loading: boolean;
  error?: string;
}

export function useRecoveryPreviews(
  records: readonly RecoveryRecord[],
  enabled: boolean,
): RecoveryPreviewState {
  const sessionIds = useMemo(() => records.map((record) => record.sessionId), [records]);
  const key = sessionIds.join(":");
  const [state, setState] = useState<PreviewState>({ previews: {}, loading: false });
  const shouldLoad = Boolean(!demoMode && enabled && sessionIds.length > 0);

  useEffect(() => {
    if (!shouldLoad) return;
    const abortController = new AbortController();
    let stopped = false;
    setState({ key, previews: {}, loading: true });

    void fetchRecoveryPreviews({ sessionIds }, abortController.signal).then(
      (result) => {
        if (stopped) return;
        setState({
          key,
          previews: Object.fromEntries(
            result.previews.map((preview) => [preview.sessionId, preview]),
          ),
          loading: false,
        });
      },
      (reason) => {
        if (stopped || abortController.signal.aborted) return;
        setState({
          key,
          previews: {},
          loading: false,
          error: reason instanceof Error ? reason.message : "会话内容暂时无法读取",
        });
      },
    );

    return () => {
      stopped = true;
      abortController.abort();
    };
  }, [key, shouldLoad]);

  if (!shouldLoad) return { previews: {}, loading: false };
  if (state.key !== key) return { previews: {}, loading: true };
  return { previews: state.previews, loading: state.loading, error: state.error };
}
