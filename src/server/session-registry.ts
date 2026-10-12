import type {
  BookmarkTitleMarker,
  RecoveryRecord,
  ItermWindowLayoutRecord,
  SessionAtlasEvent,
  SessionAtlasHealth,
  SessionAtlasSnapshot,
  SessionHandoff,
  SessionSummary,
  ThreadTagsResult,
  UpdateAttentionInput,
  UpdateThreadTagsInput,
  UpsertHandoffInput,
} from "../shared/types.js";
import { AttentionStore } from "./attention-store.js";
import { AppError } from "./errors.js";
import { normalizeProviderSession } from "./normalization.js";
import type { LegacyCodexMatch } from "./legacy-codex-observer.js";
import type { ItermSessionSnapshot } from "./provider-ports.js";
import { RecoveryStore } from "./recovery-store.js";

export type RegistryListener = (event: SessionAtlasEvent) => void;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function threadId(session: SessionSummary): string | undefined {
  if (session.provider !== "codex") return undefined;
  return session.conversationId ?? (session.surface === "managed" ? session.id : undefined);
}

function withoutObservation<T extends SessionSummary>(session: T): Omit<T, "observedAt"> {
  const copy = clone(session);
  delete (copy as Partial<SessionSummary>).observedAt;
  return copy as Omit<T, "observedAt">;
}

function withoutLegacyActivityClock(
  session: SessionSummary,
): Omit<SessionSummary, "activities" | "lastActivityAt" | "observedAt"> {
  const copy = clone(session);
  delete (copy as Partial<SessionSummary>).activities;
  delete (copy as Partial<SessionSummary>).lastActivityAt;
  delete (copy as Partial<SessionSummary>).observedAt;
  return copy as Omit<SessionSummary, "activities" | "lastActivityAt" | "observedAt">;
}

export class SessionRegistry {
  readonly attentionStore: AttentionStore;
  readonly recoveryStore: RecoveryStore;
  readonly staleAfterMs: number;
  #baseSessions = new Map<string, SessionSummary>();
  #recoveries = new Map<string, RecoveryRecord>();
  #windowLayouts = new Map<string, ItermWindowLayoutRecord>();
  #listeners = new Set<RegistryListener>();
  #revision = 0;
  #health: SessionAtlasHealth = {
    controller: "degraded",
    codex: "offline",
    iterm: "offline",
    recovery: "online",
    unprotectedCodexSessions: 0,
    message: "Waiting for providers.",
  };
  #codexMessage: string | undefined = "Waiting for providers.";
  #itermMessage: string | undefined = "Waiting for providers.";
  #controllerMessage: string | undefined;
  #recoveryMessage: string | undefined;
  #autoResumeMessage: string | undefined;

  constructor(
    attentionStore: AttentionStore,
    recoveryStore: RecoveryStore,
    staleAfterMs: number,
  ) {
    this.attentionStore = attentionStore;
    this.recoveryStore = recoveryStore;
    this.staleAfterMs = staleAfterMs;
  }

  async load(): Promise<void> {
    await Promise.all([this.attentionStore.load(), this.recoveryStore.load()]);
    this.#recoveries = new Map(
      this.recoveryStore.list().map((recovery) => [recovery.sessionId, recovery]),
    );
    this.#windowLayouts = new Map(
      this.recoveryStore.listLayouts().map((layout) => [layout.windowId, layout]),
    );
    const warnings = [this.attentionStore.loadWarning, this.recoveryStore.loadWarning].filter(
      (warning): warning is string => Boolean(warning),
    );
    if (warnings.length > 0) {
      this.setControllerMessage(warnings.join("; "));
    }
  }

  subscribe(listener: RegistryListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async upsert(input: SessionSummary): Promise<SessionSummary> {
    let normalized = await normalizeProviderSession(input);
    const previous = this.#baseSessions.get(normalized.id);
    const previousRecoveries = this.#recoveryViews(previous, normalized);
    if (
      previous?.surface === "legacy" &&
      normalized.surface === "legacy" &&
      sameValue(withoutLegacyActivityClock(previous), withoutLegacyActivityClock(normalized))
    ) {
      normalized = {
        ...normalized,
        lastActivityAt: previous.lastActivityAt,
        activities: clone(previous.activities),
      };
    }
    this.#baseSessions.set(normalized.id, normalized);
    const session = this.#materialize(normalized);
    if (
      !previous ||
      !sameValue(withoutObservation(this.#materialize(previous)), withoutObservation(session))
    ) {
      this.#revision += 1;
      this.#emit({ type: "session-upsert", session, revision: this.#revision });
    }
    this.#publishRecoveryViewChanges(previousRecoveries);
    return clone(session);
  }

  remove(sessionId: string): boolean {
    const previousRecoveries = this.#recoveryViews(this.#baseSessions.get(sessionId));
    if (!this.#baseSessions.delete(sessionId)) {
      return false;
    }
    this.#revision += 1;
    this.#emit({ type: "session-remove", sessionId, revision: this.#revision });
    this.#publishRecoveryViewChanges(previousRecoveries);
    return true;
  }

  async replaceWhere(
    predicate: (session: SessionSummary) => boolean,
    nextSessions: readonly SessionSummary[],
  ): Promise<void> {
    const nextIds = new Set(nextSessions.map((session) => session.id));
    for (const [sessionId, session] of this.#baseSessions) {
      if (predicate(session) && !nextIds.has(sessionId)) {
        this.remove(sessionId);
      }
    }
    for (const session of nextSessions) {
      await this.upsert(session);
    }
  }

  getSession(sessionId: string): SessionSummary | undefined {
    const session = this.#baseSessions.get(sessionId);
    return session ? clone(this.#materialize(session)) : undefined;
  }

  requireSession(sessionId: string): SessionSummary {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new AppError(404, "SESSION_NOT_FOUND", "The requested session was not found.");
    }
    return session;
  }

  async updateAttention(
    sessionId: string,
    input: UpdateAttentionInput,
  ): Promise<SessionSummary> {
    const base = this.#baseSessions.get(sessionId);
    if (!base) {
      throw new AppError(404, "SESSION_NOT_FOUND", "The requested session was not found.");
    }
    await this.attentionStore.update(sessionId, input);
    const session = this.#materialize(base);
    this.#revision += 1;
    this.#emit({ type: "session-upsert", session, revision: this.#revision });
    return clone(session);
  }

  readThreadTags(sessionId: string): ThreadTagsResult {
    return { sessionId, tags: this.attentionStore.getThreadTags(sessionId) };
  }

  async updateThreadTags(sessionId: string, input: UpdateThreadTagsInput): Promise<ThreadTagsResult> {
    await this.attentionStore.updateThreadTags(sessionId, input);
    for (const base of this.#baseSessions.values()) {
      if (threadId(base) !== sessionId) continue;
      this.#revision += 1;
      this.#emit({ type: "session-upsert", session: this.#materialize(base), revision: this.#revision });
    }
    const recovery = this.#recoveries.get(sessionId);
    if (recovery) {
      this.#revision += 1;
      this.#emit({ type: "recovery-upsert", recovery, revision: this.#revision });
    }
    return this.readThreadTags(sessionId);
  }

  async observeRecoveries(
    sessions: readonly ItermSessionSnapshot[],
    matches: readonly LegacyCodexMatch[],
  ): Promise<void> {
    const result = await this.recoveryStore.observe(sessions, matches);
    this.#recoveries = new Map(
      result.records.map((recovery) => [recovery.sessionId, recovery]),
    );
    this.#windowLayouts = new Map(
      result.layouts.map((layout) => [layout.windowId, layout]),
    );
    for (const recovery of result.changed) {
      this.#revision += 1;
      this.#emit({
        type: "recovery-upsert",
        recovery,
        revision: this.#revision,
      });
    }
    for (const sessionId of result.removedSessionIds) {
      this.#revision += 1;
      this.#emit({ type: "recovery-remove", sessionId, revision: this.#revision });
    }
    for (const layout of result.changedLayouts) {
      this.#revision += 1;
      this.#emit({ type: "layout-upsert", layout, revision: this.#revision });
    }
    for (const windowId of result.removedWindowIds) {
      this.#revision += 1;
      this.#emit({ type: "layout-remove", windowId, revision: this.#revision });
    }
  }

  requireWindowLayout(windowId: string): ItermWindowLayoutRecord {
    const layout = this.#windowLayouts.get(windowId);
    if (!layout) {
      throw new AppError(404, "WINDOW_LAYOUT_NOT_FOUND", "The requested window layout was not found.");
    }
    return clone(layout);
  }

  requireRecovery(sessionId: string): RecoveryRecord {
    const recovery = this.#recoveries.get(sessionId);
    if (!recovery) {
      throw new AppError(404, "RECOVERY_NOT_FOUND", "The requested recovery record was not found.");
    }
    return this.#materializeRecovery(recovery);
  }

  getHandoff(sessionId: string): SessionHandoff | undefined {
    return clone(this.#recoveries.get(sessionId)?.handoff);
  }

  async upsertHandoff(
    sessionId: string,
    input: UpsertHandoffInput,
    session?: ItermSessionSnapshot,
  ): Promise<RecoveryRecord> {
    const recovery = await this.recoveryStore.upsertHandoff(sessionId, input, session);
    this.#publishRecovery(recovery);
    return this.#materializeRecovery(recovery);
  }

  async removeHandoff(sessionId: string, expectedVersion: string | null): Promise<RecoveryRecord> {
    this.requireRecovery(sessionId);
    const recovery = await this.recoveryStore.removeHandoff(sessionId, expectedVersion);
    this.#publishRecovery(recovery);
    return this.#materializeRecovery(recovery);
  }

  async saveRecoveryLocation(
    sessionId: string,
    session: ItermSessionSnapshot,
  ): Promise<RecoveryRecord> {
    this.requireRecovery(sessionId);
    const recovery = await this.recoveryStore.saveRecoveryLocation(sessionId, session);
    this.#publishRecovery(recovery);
    return this.#materializeRecovery(recovery);
  }

  async clearRecoveryRestoreState(sessionId: string): Promise<RecoveryRecord> {
    this.requireRecovery(sessionId);
    const recovery = await this.recoveryStore.clearRecoveryRestoreState(sessionId);
    this.#publishRecovery(recovery);
    return this.#materializeRecovery(recovery);
  }

  async updateRecoveryCwd(sessionId: string, cwd: string, explicitOverride = false): Promise<RecoveryRecord> {
    this.requireRecovery(sessionId);
    const recovery = await this.recoveryStore.updateRecoveryCwd(sessionId, cwd, explicitOverride);
    this.#publishRecovery(recovery);
    return this.#materializeRecovery(recovery);
  }

  async updateBookmarkTitleMarker(sessionId: string, marker?: BookmarkTitleMarker): Promise<RecoveryRecord> {
    this.requireRecovery(sessionId);
    const recovery = await this.recoveryStore.updateBookmarkTitleMarker(sessionId, marker);
    this.#publishRecovery(recovery);
    return this.#materializeRecovery(recovery);
  }

  async markRecoveriesRestoreUncertain(
    sessionIds: readonly string[],
    message: string,
    createdWindowId?: string,
  ): Promise<RecoveryRecord[]> {
    const recoveries = await this.recoveryStore.markRecoveriesRestoreUncertain(
      sessionIds,
      message,
      createdWindowId,
    );
    for (const recovery of recoveries) {
      const previous = this.#recoveries.get(recovery.sessionId);
      this.#recoveries.set(recovery.sessionId, recovery);
      if (!previous || !sameValue(previous, recovery)) {
        this.#revision += 1;
        this.#emit({ type: "recovery-upsert", recovery, revision: this.#revision });
      }
    }
    return recoveries.map((recovery) => this.#materializeRecovery(recovery));
  }

  async markWindowLayoutRestoreUncertain(
    windowId: string,
    message: string,
    createdWindowId?: string,
  ): Promise<ItermWindowLayoutRecord> {
    const layout = await this.recoveryStore.markLayoutRestoreUncertain(
      windowId,
      message,
      createdWindowId,
    );
    const previous = this.#windowLayouts.get(windowId);
    this.#windowLayouts.set(windowId, layout);
    if (!previous || !sameValue(previous, layout)) {
      this.#revision += 1;
      this.#emit({ type: "layout-upsert", layout, revision: this.#revision });
    }
    return clone(layout);
  }

  setCodexHealth(health: SessionAtlasHealth): void {
    this.#codexMessage = health.message;
    const next: SessionAtlasHealth = {
      ...this.#health,
      codex: health.codex,
      codexVersion: health.codexVersion,
    };
    next.message = this.#healthMessage(next);
    this.#setHealth(next);
  }

  setItermHealth(status: "online" | "offline", message?: string): void {
    this.#itermMessage = message;
    const next: SessionAtlasHealth = {
      ...this.#health,
      iterm: status,
    };
    next.message = this.#healthMessage(next);
    this.#setHealth(next);
  }

  setRecoveryHealth(
    unprotectedCodexSessions: number,
    failedCaptures: number,
    autoResumeEnabled = false,
    autoResumeUnarmedSessions = 0,
  ): void {
    this.#recoveryMessage =
      unprotectedCodexSessions === 0
        ? undefined
        : failedCaptures > 0
          ? `Recovery capture failed for ${failedCaptures} Codex session${failedCaptures === 1 ? "" : "s"}.`
          : `${unprotectedCodexSessions} Codex session${unprotectedCodexSessions === 1 ? " is" : "s are"} not uniquely recoverable yet.`;
    this.#autoResumeMessage =
      autoResumeEnabled && autoResumeUnarmedSessions > 0
        ? `Automatic recovery could not be armed for ${autoResumeUnarmedSessions} Codex session${autoResumeUnarmedSessions === 1 ? "" : "s"}.`
        : undefined;
    const next: SessionAtlasHealth = {
      ...this.#health,
      recovery:
        unprotectedCodexSessions === 0 && autoResumeUnarmedSessions === 0
          ? "online"
          : "degraded",
      unprotectedCodexSessions,
      autoResume: autoResumeEnabled
        ? autoResumeUnarmedSessions === 0
          ? "online"
          : "degraded"
        : "disabled",
      autoResumeUnarmedSessions,
    };
    next.message = this.#healthMessage(next);
    this.#setHealth(next);
  }

  setControllerMessage(message: string | undefined): void {
    this.#controllerMessage = message;
    const next = { ...this.#health };
    next.message = this.#healthMessage(next);
    this.#setHealth(next);
  }

  snapshot(): SessionAtlasSnapshot {
    return {
      revision: this.#revision,
      generatedAt: new Date().toISOString(),
      health: clone(this.#health),
      sessions: [...this.#baseSessions.values()].map((session) => clone(this.#materialize(session))),
      recoveries: [...this.#recoveries.values()].map((recovery) => this.#materializeRecovery(recovery)),
      windowLayouts: [...this.#windowLayouts.values()].map(clone),
    };
  }

  #setHealth(next: SessionAtlasHealth): void {
    next.controller =
      next.codex === "offline" ||
      next.iterm === "offline" ||
      next.recovery === "degraded" ||
      Boolean(this.#controllerMessage)
        ? "degraded"
        : "online";
    if (sameValue(next, this.#health)) {
      return;
    }
    this.#health = next;
    this.#revision += 1;
    this.#emit({ type: "health", health: clone(next), revision: this.#revision });
  }

  #publishRecovery(recovery: RecoveryRecord): void {
    const previous = this.#recoveries.get(recovery.sessionId);
    this.#recoveries.set(recovery.sessionId, recovery);
    if (!previous || !sameValue(previous, recovery)) {
      this.#revision += 1;
      this.#emit({ type: "recovery-upsert", recovery, revision: this.#revision });
    }
  }

  #materializeRecovery(recovery: RecoveryRecord): RecoveryRecord {
    const effective = clone(recovery);
    const tags = this.attentionStore.getThreadTags(recovery.sessionId);
    if (tags.length) effective.tags = tags;
    else delete effective.tags;
    if ([...this.#baseSessions.values()].some((session) => session.surface === "managed"
      && !session.stale && (session.conversationId ?? session.id) === recovery.sessionId)) {
      effective.status = "active";
      delete effective.closedAt;
    }
    return effective;
  }

  #recoveryViews(...sessions: (SessionSummary | undefined)[]): RecoveryRecord[] {
    const ids = new Set(sessions.map((session) => session?.conversationId ?? session?.id));
    return [...ids].flatMap((id) => id && this.#recoveries.has(id) ? [this.requireRecovery(id)] : []);
  }

  #publishRecoveryViewChanges(previousRecoveries: RecoveryRecord[]): void {
    for (const previous of previousRecoveries) {
      const recovery = this.requireRecovery(previous.sessionId);
      if (!sameValue(previous, recovery)) {
        this.#revision += 1;
        this.#emit({ type: "recovery-upsert", recovery, revision: this.#revision });
      }
    }
  }

  #healthMessage(health: SessionAtlasHealth): string | undefined {
    return (
      this.#controllerMessage ??
      (health.codex === "online" ? undefined : this.#codexMessage) ??
      (health.iterm === "online" ? undefined : this.#itermMessage) ??
      this.#recoveryMessage ??
      this.#autoResumeMessage
    );
  }

  #materialize(base: SessionSummary): SessionSummary {
    const attention = this.attentionStore.get(base.id);
    const conversationId = threadId(base);
    const tags = conversationId ? this.attentionStore.getThreadTags(conversationId) : [];
    const acknowledgedAt = attention.acknowledgedAt ?? base.acknowledgedAt;
    const completedWasAcknowledged =
      base.attentionReason === "newly_completed" &&
      acknowledgedAt !== undefined &&
      Date.parse(acknowledgedAt) >= Date.parse(base.lastActivityAt);
    const age = Date.now() - Date.parse(base.observedAt);
    const stale =
      base.stale ||
      (base.surface === "legacy" &&
        (this.#health.iterm === "offline" || (Number.isFinite(age) && age > this.staleAfterMs)));

    return {
      ...base,
      title: attention.title ?? base.title,
      tags: tags.length ? tags : undefined,
      attentionReason: completedWasAcknowledged ? null : base.attentionReason,
      stale,
      pinned: attention.pinned ?? base.pinned,
      parked: attention.parked ?? base.parked,
      acknowledgedAt,
    };
  }

  #emit(event: SessionAtlasEvent): void {
    if (event.type === "recovery-upsert") event = { ...event, recovery: this.#materializeRecovery(event.recovery) };
    for (const listener of this.#listeners) {
      try {
        listener(clone(event));
      } catch {
        // A UI subscriber cannot break provider ingestion.
      }
    }
  }
}
