import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchRecoveryPreviews, fetchThreadTags, openRecovery, patchThreadTags } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("thread tags API", () => {
  it("adds and removes only the requested tags and reads the same exact thread", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ sessionId: "thread/id", tags: ["Python"] }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await patchThreadTags("thread/id", { add: ["Python"], remove: ["旧标签"] });
    await expect(fetchThreadTags("thread/id")).resolves.toEqual({ sessionId: "thread/id", tags: ["Python"] });
    expect(fetch).toHaveBeenNthCalledWith(1, "/api/threads/thread%2Fid/tags", expect.objectContaining({
      method: "PATCH", body: JSON.stringify({ add: ["Python"], remove: ["旧标签"] }),
    }));
    expect(fetch).toHaveBeenNthCalledWith(2, "/api/threads/thread%2Fid/tags", expect.objectContaining({ cache: "no-store" }));
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("recovery preview API", () => {
  it("opens a recovery through the checked server action without writing a handoff", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ action: "focused", terminalSessionId: "existing-pane" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await expect(openRecovery("session/id")).resolves.toMatchObject({ action: "focused" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/recoveries/session%2Fid/open", expect.objectContaining({ method: "POST", body: "{}" }));
  });
  it("batches a full 200-record recovery history into supported requests", async () => {
    const batches: string[][] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { sessionIds: string[] };
      batches.push(body.sessionIds);
      return new Response(
        JSON.stringify({
          previews: body.sessionIds.map((sessionId) => ({ sessionId, status: "missing" })),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }));
    const sessionIds = Array.from({ length: 200 }, (_, index) => `session-${index}`);

    const result = await fetchRecoveryPreviews({ sessionIds });

    expect(batches.map((batch) => batch.length)).toEqual([100, 100]);
    expect(result.previews).toHaveLength(200);
  });
});
