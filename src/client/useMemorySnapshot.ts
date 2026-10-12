import { useCallback, useEffect, useRef, useState } from "react";
import type { MemorySnapshot } from "../shared/types";
import { fetchMemory } from "./api";

export function useMemorySnapshot(ready: boolean) {
  const [enabled, setEnabled] = useState(true);
  const [snapshot, setSnapshot] = useState<MemorySnapshot>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const attempted = useRef(false);
  const inFlight = useRef(false);
  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    attempted.current = true;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try { setSnapshot(await fetchMemory()); }
    catch { setError("采集失败，保留上次结果；请重试。"); }
    finally { inFlight.current = false; setBusy(false); }
  }, []);
  useEffect(() => {
    if (enabled && ready && !attempted.current) void refresh();
  }, [enabled, ready, refresh]);
  return { enabled, setEnabled, snapshot, busy, error, refresh };
}
