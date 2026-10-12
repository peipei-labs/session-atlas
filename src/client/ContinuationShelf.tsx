import { useEffect, useRef, useState, type FormEvent } from "react";

import type { ContinuationItem, RecoveryRecord, SessionSummary, UpdateThreadTagsInput, UpsertHandoffInput } from "../shared/types";
import {
  CONTINUATION_KINDS, completeContinuationInput, continuationDueAt, continuationTimeLabel, findContinuationSession,
  formatContinuationTime, fromShanghaiInput, pendingContinuations, resolveContinuationTarget,
  toShanghaiInput, savedReferences, referenceInput, endContinuationsInput, removeReferenceInput, handoffVersion,
  savedThreadLocationGroup, type SavedThreadLocationGroup, type SavedThreadView,
} from "./continuation-model";
import { Icon } from "./icons";
import { OpenThreadAction, openThreadLocations, threadLocationStatus } from "./OpenThreadAction";
import { ThreadTags } from "./ThreadTags";
import { matchesThreadTags } from "./thread-tags-model";

const savedThreadGroups: { id: SavedThreadLocationGroup; title: string }[] = [
  { id: "closed", title: "待恢复" },
  { id: "open", title: "已打开" },
  { id: "unknown", title: "位置待核对" },
];

interface ContinuationShelfProps {
  records: RecoveryRecord[];
  sessions: SessionSummary[];
  target?: string;
  initialView?: SavedThreadView;
  view?: SavedThreadView;
  onViewChange?: (view: SavedThreadView, sessionId?: string) => void;
  hideTabs?: boolean;
  hideHeading?: boolean;
  shortcutErrorCode?: string;
  onFinishTarget?: () => void;
  query?: string;
  canUseIterm: boolean;
  busyId: string | null;
  onSave: (sessionId: string, input: UpsertHandoffInput) => Promise<boolean>;
  onRemove: (sessionId: string, expectedVersion: string | null) => Promise<boolean>;
  onResume: (sessionId: string) => Promise<"focused" | "restored" | null>;
  onOpenSession?: (sessionId: string) => void;
  onFocusSession?: (sessionId: string) => Promise<boolean>;
  onCloseSession: (sessionId: string, terminalSessionId: string) => Promise<boolean>;
  selectedTags?: readonly string[];
  tagSuggestions?: readonly string[];
  onUpdateTags?: (threadId: string, input: UpdateThreadTagsInput) => Promise<boolean>;
}

export function handoffShortcutErrorMessage(code: string): string {
  switch (code) {
    case "HANDOFF_REQUIRED":
      return "尚未登记未完成事项或收藏。请在原线程登记，或在这里选择保存用途。";
    case "SESSION_NOT_LINKED":
      return "尚无法取得唯一的 Codex 会话记录，分屏已保留。";
    case "SESSION_REQUIRES_PROCESS":
      return "线程中的工作仍依赖当前进程，分屏已保留。请等进程完成后再保存关闭。";
    case "SESSION_NOT_IDLE":
      return "线程仍在执行，或尚未确认已停止执行，分屏已保留。请稍后重试。";
    case "HANDOFF_STALE":
      return "待续事项尚未反映线程的最新进展，分屏已保留。请在原线程更新未完成事项后重试。";
    case "SESSION_TARGET_CHANGED":
      return "当前分屏与登记的线程不再匹配，分屏已保留。请重新选择目标线程。";
    case "ITERM_OFFLINE":
      return "iTerm2 连接离线，暂时不能关闭分屏。请等连接恢复后重试。";
    case "BRIDGE_UPDATE_REQUIRED":
      return "当前 iTerm2 连接组件尚不支持暂存关闭，需要更新后重试。";
    case "PROVIDER_UNAVAILABLE":
      return "会话服务暂时不可用，尚未确认线程状态。请等服务恢复后重试。";
    case "CONTINUATION_CANCELLED":
      return "关闭前的检查超时或请求已取消，分屏已保留。请重新操作。";
    case "CLOSE_FAILED":
    default:
      return "未能确认暂存关闭成功。请检查当前分屏状态后重试。";
  }
}

function newItem(): ContinuationItem {
  return { id: crypto.randomUUID(), title: "", kind: "later", nextAction: "", status: "pending" };
}

export function ContinuationShelf({
  records, sessions, target, initialView, view: controlledView, onViewChange, hideTabs = false, hideHeading = false, shortcutErrorCode, onFinishTarget, query = "", canUseIterm, busyId,
  onSave, onRemove, onResume, onOpenSession, onFocusSession, onCloseSession,
  selectedTags, tagSuggestions, onUpdateTags,
}: ContinuationShelfProps) {
  const [now, setNow] = useState(Date.now);
  const [innerView, setInnerView] = useState<SavedThreadView>(() => {
    if (initialView) return initialView;
    const selected = target ? records.find((record) => record.sessionId === resolveContinuationTarget(target, sessions)) : undefined;
    return selected?.handoff?.reference && !selected.handoff.items.some((item) => item.status === "pending") ? "reference" : "continuation";
  });
  const view = controlledView ?? innerView;
  const changeView = (next: SavedThreadView, sessionId?: string) => {
    setInnerView(next);
    onViewChange?.(next, sessionId);
  };
  const [referenceQuery, setReferenceQuery] = useState("");
  const [editorTarget, setEditorTarget] = useState<string | undefined>(target);
  const [message, setMessage] = useState("");
  const [submittedCloseIds, setSubmittedCloseIds] = useState<string[]>([]);
  const [submittedResumeIds, setSubmittedResumeIds] = useState<string[]>([]);
  const pending = pendingContinuations(records, now, query);
  const references = savedReferences(savedReferences(records, query), referenceQuery);
  const displayed = (view === "reference" ? references : pending).filter((record) => matchesThreadTags(record.tags, selectedTags));
  const located = displayed.map((record) => {
    const locations = openThreadLocations(sessions, record.sessionId);
    const isDue = view === "continuation" && record.handoff!.items.some((item) => {
      const due = continuationDueAt(item);
      return due !== undefined && due <= now;
    });
    return { record, locations, group: savedThreadLocationGroup(record, locations), isDue };
  });
  const groups = [true, false].flatMap((isDue) => savedThreadGroups.map((group) => ({
    ...group, key: `${isDue}:${group.id}`, title: isDue ? `该核验了 · ${group.title}` : group.title,
    cards: located.filter((card) => card.group === group.id && card.isDue === isDue),
  })))
    .filter((group) => group.cards.length);
  const continuationCount = records.filter((record) => record.handoff?.items.some((item) => item.status === "pending")).length;
  const referenceCount = records.filter((record) => record.handoff?.reference).length;
  const selectedId = editorTarget ? resolveContinuationTarget(editorTarget, sessions) : undefined;
  const unlinkedTarget = Boolean(editorTarget && !selectedId);
  const selectedRecord = records.find((record) => record.sessionId === selectedId);
  const selectedSession = selectedId ? findContinuationSession(sessions, selectedId) : undefined;
  const selectableSessions = sessions.filter((session) => session.provider === "codex" &&
    session.conversationId && !session.stale && findContinuationSession(sessions, session.conversationId)?.id === session.id);
  const selectableRecoveries = records.filter((record) => record.status === "closed" &&
    !selectableSessions.some((session) => session.conversationId === record.sessionId));

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    setSubmittedResumeIds((current) => {
      const remaining = current.filter((id) => openThreadLocations(sessions, id).length === 0);
      return remaining.length === current.length ? current : remaining;
    });
    setSubmittedCloseIds((current) => {
      const remaining = current.filter((id) => findContinuationSession(sessions, id));
      return remaining.length === current.length ? current : remaining;
    });
  }, [sessions, submittedResumeIds, submittedCloseIds]);

  const busy = busyId !== null;
  const finishTarget = () => { setEditorTarget(undefined); onFinishTarget?.(); };
  return (
    <section className="dock-panel-section" data-testid="continuation-section">
      {hideHeading ? null : <h2 className="dock-panel-heading">
        <Icon name="pin" /><strong>待续 / 收藏</strong>
        {editorTarget ? <button className="continuation-back" type="button" onClick={finishTarget}>返回列表</button> : null}
      </h2>}
      <div className="dock-panel-body continuation-shelf">
        {hideTabs ? null : <div className="saved-thread-tabs" role="group" aria-label="保存用途">
          <button type="button" aria-pressed={view === "continuation"} disabled={busyId !== null} onClick={() => { changeView("continuation"); setMessage(""); }}>待续 <em>{continuationCount}</em></button>
          <button type="button" className="is-reference" aria-pressed={view === "reference"} disabled={busyId !== null} onClick={() => { changeView("reference"); setMessage(""); }}>可能有用 <em>{referenceCount}</em></button>
        </div>}
        <p className="continuation-intro">{view === "reference" ? "收藏以后可能参考的线程。只保留主题和原因，不计入待续事项。" : "保留已经约定的后续事项。已完成的线程正常关闭，无需登记。"}</p>
        <p className="continuation-intro">打开后卡片会移到「已打开」，关闭后回到「待恢复」。完成待续不会移除收藏。</p>
        {shortcutErrorCode || unlinkedTarget ? <div className="continuation-guidance" role={shortcutErrorCode ? "alert" : "status"} data-testid={shortcutErrorCode ? "handoff-shortcut-error" : "handoff-unlinked-guidance"}>
          <strong>{unlinkedTarget ? "尚未关联到唯一的 Codex 线程" : "保存关闭未完成"}</strong>
          {shortcutErrorCode && (!unlinkedTarget || !["HANDOFF_REQUIRED", "SESSION_NOT_LINKED"].includes(shortcutErrorCode)) ? <p>{handoffShortcutErrorMessage(shortcutErrorCode)}</p> : null}
          {unlinkedTarget ? <>
            <p>{handoffShortcutErrorMessage("SESSION_NOT_LINKED")}</p>
            <p>若是尚未开始工作的空白会话，或工作已完成，请使用 iTerm2 普通关闭。</p>
            <p>有已约定的未完成工作，或想收藏以后可能有用的内容，则在这个分屏的原线程使用 <code>$session-atlas-handoff</code> 登记，再返回这里。</p>
          </> : null}
          {shortcutErrorCode ? <button className="continuation-back" type="button" onClick={finishTarget}>知道了</button> : null}
        </div> : null}
        {editorTarget ? (
          selectedId ? view === "reference" ? <ReferenceEditor
            key={`reference:${selectedId}`} sessionId={selectedId} record={selectedRecord} session={selectedSession} busy={busy}
            onSave={async (input) => {
              const saved = await onSave(selectedId, input);
              if (saved) { finishTarget(); setMessage("已加入可能有用；分屏仍然保留。"); }
              return saved;
            }}
          /> : <HandoffEditor
            key={`continuation:${selectedId}`}
            sessionId={selectedId}
            record={selectedRecord}
            session={selectedSession}
            busy={busy}
            onSave={async (input) => {
              const saved = await onSave(selectedId, input);
              if (saved) { finishTarget(); setMessage("待续卡已保存；分屏仍然保留。"); }
              return saved;
            }}
          /> : null
        ) : <>
          <label className="continuation-register">
            <span>{view === "reference" ? "收藏线程" : "登记当前线程"}</span>
            <select value="" disabled={busy || !(selectableSessions.length || selectableRecoveries.length)} onChange={(event) => {
              if (event.currentTarget.value) { setEditorTarget(event.currentTarget.value); setMessage(""); }
            }}>
              <option value="">{selectableSessions.length || selectableRecoveries.length ? "选择一个 Codex 线程…" : "没有可登记的线程记录"}</option>
              {selectableSessions.length ? <optgroup label="已关联线程">{selectableSessions.map((session) => <option key={session.id} value={session.conversationId}>
                {session.projectName} · {session.title}
              </option>)}</optgroup> : null}
              {selectableRecoveries.length ? <optgroup label="最近关闭">{selectableRecoveries.map((record) => <option key={record.sessionId} value={record.sessionId}>
                {record.projectName} · {record.title}
              </option>)}</optgroup> : null}
            </select>
          </label>
          {view === "reference" ? <label className="reference-search"><span>搜索收藏</span><input type="search" value={referenceQuery} placeholder="主题、保留原因或项目" onChange={(event) => setReferenceQuery(event.currentTarget.value)} /></label> : null}
          {!displayed.length ? <div className="continuation-empty">
            <Icon name={view === "reference" ? "pin" : "check"} /><strong>{view === "reference" ? query || referenceQuery || selectedTags?.length ? "没有匹配的收藏" : "还没有收藏可能有用的线程" : query || selectedTags?.length ? "没有匹配的待续事项" : "当前没有待续事项"}</strong>
            <p>{view === "reference" ? "从上方选择线程，填写主题和保留原因。收藏由你选择，不会自动添加。" : <>在原线程使用 <code>$session-atlas-handoff</code>，或从上方选择线程手动登记。</>}</p>
          </div> : null}
          <div className="saved-thread-groups">
            {groups.flatMap((group) => [<header className="saved-thread-group" key={`group:${group.key}`} data-location-group={group.id}>
              <h3 className="saved-thread-group-heading">{group.title}<em>{group.cards.length}</em></h3>
              {group.id === "unknown" ? <p className="saved-thread-group-note">暂未确认打开位置，卡片仍然保留。可检查并回到原线程。</p> : null}
            </header>,
            ...group.cards.map(({ record, locations }) => {
              const session = findContinuationSession(sessions, record.sessionId);
              const canClose = canUseIterm && Boolean(session?.terminalSessionId) &&
                session?.activityState !== "running" && !record.handoff?.requiresRunningProcess;
              return <article className={`continuation-card${view === "reference" ? " is-reference" : ""}`} key={record.sessionId} data-session-id={record.sessionId} data-card-location={group.id}>
                <header><strong>{record.projectName}</strong><small>{threadLocationStatus(record, locations)}</small></header>
                <ThreadTags threadId={record.sessionId} tags={record.tags} tagSuggestions={tagSuggestions} onUpdateTags={onUpdateTags} />
                {view === "reference" ? <>
                  <span className="continuation-kind is-reference">可能有用</span>
                  <h4>{record.handoff!.reference!.title}</h4>
                  <p className="reference-reason"><small>保留原因</small>{record.handoff!.reference!.reason}</p>
                </> : <><h4>{record.handoff!.summary}</h4>
                <ul className="continuation-items">
                  {record.handoff!.items.filter((item) => item.status === "pending").map((item) => {
                    const due = continuationDueAt(item);
                    const isDue = due !== undefined && due <= now;
                    return <li key={item.id}>
                      <div className="continuation-item-heading">
                        <span className={`continuation-kind is-${item.kind}`}>{CONTINUATION_KINDS[item.kind]}</span>
                        <strong>{item.title}</strong>
                        <button type="button" disabled={busy} className="continuation-complete" aria-label={`完成：${item.title}`} onClick={() => {
                          void onSave(record.sessionId, completeContinuationInput(record, item.id)).then((success) => {
                              if (success) setMessage(`已完成：${item.title}`);
                            });
                        }}><Icon name="check" /><span>完成</span></button>
                      </div>
                      {item.kind === "time" ? <div className={`continuation-time${isDue ? " is-due" : ""}`}>
                        <strong>{continuationTimeLabel(item, now)}</strong>
                        {item.dueAt ? <time dateTime={item.dueAt}>{formatContinuationTime(item.dueAt)} · 上海时间</time> : null}
                        {item.anchorLabel ? <small>起算：{item.anchorLabel}{item.anchorAt ? ` · ${formatContinuationTime(item.anchorAt)}` : ""}</small> : null}
                      </div> : null}
                      {item.condition ? <p className="continuation-condition">{item.condition}</p> : null}
                      <p className="continuation-next"><small>下一步</small>{item.nextAction}</p>
                    </li>;
                  })}
                </ul></>}
                <footer className="continuation-actions">
                  <OpenThreadAction record={record} sessions={sessions} canUseIterm={canUseIterm} busy={busy}
                    submitted={submittedResumeIds.includes(record.sessionId)} onOpenSession={onOpenSession} onFocusSession={onFocusSession} onResume={() => {
                    void onResume(record.sessionId).then((result) => {
                      if (result) {
                        if (result === "restored") setSubmittedResumeIds((current) => [...current, record.sessionId]);
                        setMessage(result === "focused" ? "已定位到原线程。" : "已请求恢复原线程，等待 iTerm 确认。");
                      }
                    });
                  }} />
                  <button type="button" disabled={busy} onClick={() => { setEditorTarget(record.sessionId); setMessage(""); }}>编辑</button>
                  <button type="button" disabled={busy} onClick={() => {
                    changeView(view === "reference" ? "continuation" : "reference", record.sessionId); setEditorTarget(record.sessionId); setMessage("");
                  }}>{view === "reference" ? "登记待续" : record.handoff?.reference ? "编辑收藏" : "加入可能有用"}</button>
                  {session?.terminalSessionId ? <button type="button" disabled={busy || !canClose || submittedCloseIds.includes(record.sessionId)} title={!canClose ? "需要 iTerm 在线、线程停止执行且工作不依赖当前进程" : `关闭 ${session.title} 的当前分屏`} onClick={() => {
                    void onCloseSession(record.sessionId, session.terminalSessionId!).then((success) => {
                      if (success) { setSubmittedCloseIds((current) => [...current, record.sessionId]); setMessage("线程记录已保存，已请求关闭当前分屏。"); }
                    });
                  }}>{submittedCloseIds.includes(record.sessionId) ? "等待关闭确认" : view === "reference" ? "保存并关闭分屏" : "暂存并关闭分屏"}</button> : null}
                  <button type="button" className="continuation-remove" disabled={busy} onClick={() => {
                    const remove = view === "reference"
                      ? record.handoff!.items.length ? onSave(record.sessionId, removeReferenceInput(record)) : onRemove(record.sessionId, handoffVersion(record))
                      : record.handoff!.reference ? onSave(record.sessionId, endContinuationsInput(record)) : onRemove(record.sessionId, handoffVersion(record));
                    void remove.then((success) => {
                      if (success) setMessage(view === "reference" ? "已移除收藏，待续事项和普通恢复记录保留。" : "已结束待续，收藏和普通恢复记录保留。");
                    });
                  }}>{view === "reference" ? "移除收藏" : "结束待续"}</button>
                </footer>
                {record.handoff?.requiresRunningProcess ? <small className="continuation-running-note">线程中的工作仍依赖当前进程，暂时不能关闭。</small> : null}
                <details className="continuation-identity"><summary>线程信息</summary><code>{record.sessionId}</code><small>{record.cwd}</small></details>
              </article>;
            })])}
          </div>
        </>}
        {!canUseIterm ? <p className="continuation-status">iTerm2 连接离线，连接恢复后才能定位、恢复或关闭分屏。</p> : null}
        <p className="continuation-status" role="status" aria-live="polite">{message}</p>
      </div>
    </section>
  );
}

interface HandoffEditorProps {
  sessionId: string;
  record?: RecoveryRecord;
  session?: SessionSummary;
  busy: boolean;
  onSave: (input: UpsertHandoffInput) => Promise<boolean>;
}

export function HandoffEditor({ sessionId, record, session, busy, onSave }: HandoffEditorProps) {
  const currentSnapshot = JSON.stringify([record?.handoff, record?.cwd ?? session?.cwd ?? ""]);
  const [snapshot, setSnapshot] = useState(currentSnapshot);
  const stale = snapshot !== currentSnapshot;
  const [summary, setSummary] = useState(record?.handoff?.summary ?? "");
  const [cwd, setCwd] = useState(record?.cwd ?? session?.cwd ?? "");
  const [items, setItems] = useState<ContinuationItem[]>(() => record?.handoff?.items.length ? record.handoff.items.map((item) => ({ ...item })) : [newItem()]);
  const [requiresRunningProcess, setRequiresRunningProcess] = useState(record?.handoff?.requiresRunningProcess ?? false);
  const [validation, setValidation] = useState("");
  const submittingRef = useRef(false);
  const reload = () => {
    setSummary(record?.handoff?.summary ?? ""); setCwd(record?.cwd ?? session?.cwd ?? "");
    setItems(record?.handoff?.items.length ? record.handoff.items.map((item) => ({ ...item })) : [newItem()]);
    setRequiresRunningProcess(record?.handoff?.requiresRunningProcess ?? false);
    setValidation(""); setSnapshot(currentSnapshot);
  };

  const updateItem = (id: string, change: Partial<ContinuationItem>) => {
    setItems((current) => current.map((item) => {
      if (item.id !== id) return item;
      const next = { ...item, ...change };
      if (!("dueAt" in change) && ("anchorAt" in change || "delayHours" in change) && next.anchorAt && next.delayHours !== undefined) {
        next.dueAt = new Date(Date.parse(next.anchorAt) + next.delayHours * 3_600_000).toISOString();
      } else if (!("dueAt" in change) && ("anchorAt" in change || "delayHours" in change)) {
        next.dueAt = undefined;
      }
      return next;
    }));
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submittingRef.current || busy || stale) return;
    if (!summary.trim() || !cwd.startsWith("/") || !items.length || items.some((item) => !item.title.trim() || !item.nextAction.trim())) {
      setValidation("请填写工作概述、绝对 cwd，以及每项的名称和下一步。");
      return;
    }
    const normalizedItems = items.map((item): ContinuationItem => {
      const result = { ...item, title: item.title.trim(), nextAction: item.nextAction.trim() };
      if (item.kind !== "time") {
        delete result.anchorAt; delete result.anchorLabel; delete result.delayHours; delete result.dueAt;
      }
      return result;
    });
    setValidation("");
    submittingRef.current = true;
    try {
      await onSave({ expectedVersion: handoffVersion(record), cwd: cwd.trim(), summary: summary.trim(), items: normalizedItems, source: "user", requiresRunningProcess });
    } finally { submittingRef.current = false; }
  };

  return <form className="handoff-editor" onSubmit={(event) => void submit(event)}>
    {stale ? <p className="continuation-guidance" role="alert">线程记录已更新，当前草稿已保留。请复制需要保留的修改，再载入最新记录。<button type="button" disabled={busy} onClick={reload}>载入最新记录</button></p> : null}
    {!record?.handoff ? <div className="continuation-guidance">
      <strong>这个线程还没有待续卡</strong>
      <p>推荐在原线程使用 <code>$session-atlas-handoff</code> 整理已有上下文；也可以在这里手动登记。</p>
    </div> : null}
    <code className="handoff-session-id">{sessionId}</code>
    <fieldset disabled={busy}>
      <label><span>工作概述</span><textarea autoFocus required maxLength={1000} value={summary} rows={2} placeholder="当前在做什么，还有什么没做完" onChange={(event) => setSummary(event.currentTarget.value)} /></label>
      <label><span>项目 cwd</span><input required value={cwd} readOnly={Boolean(record?.cwd || session?.cwd)} onChange={(event) => setCwd(event.currentTarget.value)} placeholder="/path/to/project" /></label>
      {items.map((item, index) => <fieldset className="handoff-item-editor" key={item.id}>
        <legend>后续事项 {index + 1}</legend>
        <label><span>事项名称</span><input required maxLength={200} value={item.title} onChange={(event) => updateItem(item.id, { title: event.currentTarget.value })} /></label>
        <div className="handoff-form-row">
          <label><span>等待类型</span><select value={item.kind} onChange={(event) => updateItem(item.id, { kind: event.currentTarget.value as ContinuationItem["kind"] })}>{Object.entries(CONTINUATION_KINDS).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select></label>
          <label><span>事项状态</span><select value={item.status} onChange={(event) => updateItem(item.id, { status: event.currentTarget.value as ContinuationItem["status"] })}><option value="pending">未完成</option><option value="done">已完成</option><option value="cancelled">已取消</option></select></label>
        </div>
        {item.kind === "condition" || item.kind === "input" ? <label><span>{item.kind === "input" ? "还缺什么信息" : "等待什么条件"}</span><textarea maxLength={1000} rows={2} value={item.condition ?? ""} onChange={(event) => updateItem(item.id, { condition: event.currentTarget.value || undefined })} /></label> : null}
        {item.kind === "time" ? <div className="handoff-time-editor">
          <label><span>起算事件</span><input maxLength={200} value={item.anchorLabel ?? ""} placeholder="例如：部署完成" onChange={(event) => updateItem(item.id, { anchorLabel: event.currentTarget.value || undefined })} /></label>
          <div className="handoff-form-row">
            <label><span>起算时间（上海时间）</span><input type="datetime-local" value={toShanghaiInput(item.anchorAt)} onChange={(event) => updateItem(item.id, { anchorAt: fromShanghaiInput(event.currentTarget.value) })} /></label>
            <label><span>等待小时数</span><input type="number" min="0" max="87600" step="0.25" value={item.delayHours ?? ""} onChange={(event) => updateItem(item.id, { delayHours: event.currentTarget.value === "" ? undefined : Number(event.currentTarget.value) })} /></label>
          </div>
          <label><span>核验时间（上海时间，可直接指定）</span><input type="datetime-local" value={toShanghaiInput(item.dueAt)} onChange={(event) => updateItem(item.id, { dueAt: fromShanghaiInput(event.currentTarget.value), delayHours: undefined })} /></label>
          <small>未确认起算时间时留空，卡片显示“时间待确认”。</small>
        </div> : null}
        <label><span>下一步</span><textarea required maxLength={1000} rows={2} value={item.nextAction} onChange={(event) => updateItem(item.id, { nextAction: event.currentTarget.value })} placeholder="恢复原线程后，具体继续做什么" /></label>
        <button className="handoff-item-remove" type="button" disabled={items.length === 1} onClick={() => setItems((current) => current.filter((entry) => entry.id !== item.id))}>移除这项</button>
      </fieldset>)}
      <button className="handoff-add-item" type="button" disabled={items.length >= 20} onClick={() => setItems((current) => [...current, newItem()])}><Icon name="plus" />添加后续事项</button>
      <label className="handoff-process-option"><input type="checkbox" checked={requiresRunningProcess} onChange={(event) => setRequiresRunningProcess(event.currentTarget.checked)} /><span>后续事项仍依赖当前进程，需要保留分屏</span></label>
    </fieldset>
    {validation ? <p className="dialog-validation" role="alert">{validation}</p> : null}
    <footer><small>保存后可从待续卡选择“暂存并关闭分屏”。</small><button type="submit" className="continuation-primary" disabled={busy || stale}>{busy ? "正在保存…" : "保存待续卡"}</button></footer>
  </form>;
}

export function ReferenceEditor({ sessionId, record, session, busy, onSave }: HandoffEditorProps) {
  const currentSnapshot = JSON.stringify([record?.handoff, record?.cwd ?? session?.cwd ?? ""]);
  const [snapshot, setSnapshot] = useState(currentSnapshot);
  const stale = snapshot !== currentSnapshot;
  const [title, setTitle] = useState(record?.handoff?.reference?.title ?? record?.title ?? session?.title ?? "");
  const [reason, setReason] = useState(record?.handoff?.reference?.reason ?? "");
  const [validation, setValidation] = useState("");
  const submittingRef = useRef(false);
  const cwd = record?.cwd ?? session?.cwd ?? "";
  const reload = () => {
    setTitle(record?.handoff?.reference?.title ?? record?.title ?? session?.title ?? "");
    setReason(record?.handoff?.reference?.reason ?? ""); setValidation(""); setSnapshot(currentSnapshot);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submittingRef.current || busy || stale) return;
    const input = referenceInput(cwd, title, reason, record);
    if (!input) { setValidation("请填写主题和保留原因，并选择有工作目录记录的线程。"); return; }
    setValidation("");
    submittingRef.current = true;
    try { await onSave(input); } finally { submittingRef.current = false; }
  };

  return <form className="handoff-editor reference-editor" onSubmit={(event) => void submit(event)}>
    {stale ? <p className="continuation-guidance" role="alert">线程记录已更新，当前草稿已保留。请复制需要保留的修改，再载入最新记录。<button type="button" disabled={busy} onClick={reload}>载入最新记录</button></p> : null}
    <p className="continuation-intro">记录这段对话以后有什么参考价值，不需要安排下一步或日期。</p>
    <fieldset disabled={busy}>
      <label><span>主题</span><input autoFocus required maxLength={200} value={title} placeholder="以后通过什么主题找到它" onChange={(event) => setTitle(event.currentTarget.value)} /></label>
      <label><span>保留原因</span><textarea required maxLength={1000} rows={3} value={reason} placeholder="哪些内容以后可能参考" onChange={(event) => setReason(event.currentTarget.value)} /></label>
    </fieldset>
    {record?.handoff?.items.some((item) => item.status === "pending") ? <p className="continuation-status">这个线程还有待续事项，保存收藏会保留这些事项。</p> : null}
    <details className="continuation-identity"><summary>线程信息</summary><code>{sessionId}</code><small>{cwd}</small></details>
    {validation ? <p className="dialog-validation" role="alert">{validation}</p> : null}
    <footer><small>保存后可选择关闭分屏，之后随时回到原线程。</small><button type="submit" className="continuation-primary" disabled={busy || stale}>{busy ? "正在保存…" : "保存到可能有用"}</button></footer>
  </form>;
}
