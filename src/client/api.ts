import type {
  CreateThreadInput,
  RecoveryRecord,
  RecoveryPreviewsInput,
  RecoveryPreviewsResult,
  RespondRequestInput,
  RestoreRecoveriesInput,
  RestoreRecoveriesResult,
  SendMessageInput,
  SessionAtlasSnapshot,
  SessionSummary,
  SessionThreadDetail,
  ThreadTagsResult,
  UpdateAttentionInput,
  UpdateThreadTagsInput,
  UpsertHandoffInput,
} from "../shared/types";

export class ApiRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
  }
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    let message = `请求失败（${response.status}）`;

    try {
      const payload = (await response.json()) as {
        error?: { message?: string };
      };
      if (payload.error?.message) {
        message = payload.error.message;
      }
    } catch {
      // The status code remains useful when the server returns no JSON body.
    }

    throw new ApiRequestError(message, response.status);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export function fetchSnapshot(signal?: AbortSignal): Promise<SessionAtlasSnapshot> {
  return apiRequest<SessionAtlasSnapshot>("/api/sessions", {
    cache: "no-store",
    signal,
  });
}

export function fetchThreadTags(sessionId: string): Promise<ThreadTagsResult> {
  return apiRequest(`/api/threads/${encodeURIComponent(sessionId)}/tags`, { cache: "no-store" });
}

export function patchThreadTags(sessionId: string, input: UpdateThreadTagsInput): Promise<ThreadTagsResult> {
  return apiRequest(`/api/threads/${encodeURIComponent(sessionId)}/tags`, {
    method: "PATCH", body: JSON.stringify(input),
  });
}

export function openRecovery(sessionId: string): Promise<{ action: "focused" | "restored"; terminalSessionId: string; windowId?: string }> {
  return apiRequest(`/api/recoveries/${encodeURIComponent(sessionId)}/open`, {
    method: "POST", body: JSON.stringify({}),
  });
}

export function fetchHandoff(sessionId: string, signal?: AbortSignal): Promise<RecoveryRecord> {
  return apiRequest<RecoveryRecord>(`/api/handoffs/${encodeURIComponent(sessionId)}`, {
    cache: "no-store",
    signal,
  });
}

export function putHandoff(sessionId: string, input: UpsertHandoffInput): Promise<RecoveryRecord> {
  return apiRequest<RecoveryRecord>(`/api/handoffs/${encodeURIComponent(sessionId)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function deleteHandoff(sessionId: string, expectedVersion: string | null): Promise<void> {
  return apiRequest<void>(`/api/handoffs/${encodeURIComponent(sessionId)}`, { method: "DELETE", body: JSON.stringify({ expectedVersion }) });
}

export function resumeHandoff(sessionId: string): Promise<{
  action: "focused" | "restored";
  terminalSessionId?: string;
  windowId?: string;
}> {
  return apiRequest(`/api/handoffs/${encodeURIComponent(sessionId)}/resume`, {
    method: "POST",
    body: "{}",
  });
}

export function closeHandoff(sessionId: string, terminalSessionId: string): Promise<{
  closed: true;
  terminalSessionId: string;
}> {
  return apiRequest(`/api/handoffs/${encodeURIComponent(sessionId)}/close`, {
    method: "POST",
    body: JSON.stringify({ terminalSessionId }),
  });
}

export function fetchSessionDetail(
  sessionId: string,
  signal?: AbortSignal,
): Promise<SessionThreadDetail> {
  return apiRequest<SessionThreadDetail>(
    `/api/sessions/${encodeURIComponent(sessionId)}/detail`,
    {
      cache: "no-store",
      signal,
    },
  );
}

export function createThread(input: CreateThreadInput): Promise<SessionSummary> {
  return apiRequest<SessionSummary>("/api/threads", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function focusSession(sessionId: string): Promise<void> {
  return apiRequest<void>(`/api/sessions/${encodeURIComponent(sessionId)}/focus`, {
    method: "POST",
    body: "{}",
  });
}

export function restoreRecoveries(
  input: RestoreRecoveriesInput,
): Promise<RestoreRecoveriesResult> {
  return apiRequest<RestoreRecoveriesResult>("/api/recoveries/restore", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function restoreWindowLayout(windowId: string): Promise<void> {
  return apiRequest<void>(`/api/layouts/${encodeURIComponent(windowId)}/restore`, {
    method: "POST",
    body: "{}",
  });
}

export function fetchRecoveryPreviews(
  input: RecoveryPreviewsInput,
  signal?: AbortSignal,
): Promise<RecoveryPreviewsResult> {
  const batches: string[][] = [];
  for (let index = 0; index < input.sessionIds.length; index += 100) {
    batches.push(input.sessionIds.slice(index, index + 100));
  }
  return Promise.all(
    batches.map((sessionIds) =>
      apiRequest<RecoveryPreviewsResult>("/api/recoveries/previews", {
        method: "POST",
        body: JSON.stringify({ sessionIds }),
        signal,
      }),
    ),
  ).then((results) => ({ previews: results.flatMap((result) => result.previews) }));
}

export function sendSessionMessage(
  sessionId: string,
  input: SendMessageInput,
): Promise<void> {
  return apiRequest<void>(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function interruptSession(sessionId: string): Promise<void> {
  return apiRequest<void>(`/api/sessions/${encodeURIComponent(sessionId)}/interrupt`, {
    method: "POST",
    body: "{}",
  });
}

export function respondToRequest(
  sessionId: string,
  requestId: string,
  input: RespondRequestInput,
): Promise<void> {
  return apiRequest<void>(
    `/api/sessions/${encodeURIComponent(sessionId)}/requests/${encodeURIComponent(requestId)}/respond`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export function patchAttention(
  sessionId: string,
  input: UpdateAttentionInput,
): Promise<SessionSummary> {
  return apiRequest<SessionSummary>(`/api/sessions/${encodeURIComponent(sessionId)}/attention`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function fetchMemory(): Promise<import("../shared/types").MemorySnapshot> {
  return apiRequest("/api/memory", { cache: "no-store", signal: AbortSignal.timeout(12_000) });
}
