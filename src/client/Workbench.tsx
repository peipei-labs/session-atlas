import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import type {
  PendingRequest,
  RecoveryRecord,
  RespondRequestInput,
  SessionActivity,
  SessionSummary,
  SessionThreadDetail,
  UpdateAttentionInput,
  UpdateThreadTagsInput,
} from "../shared/types";
import { sessionIdentity } from "./attention-model";
import {
  activityLabel,
  attentionLabel,
  formatTime,
  isManaged,
  sessionTone,
  shortId,
} from "./format";
import { Icon, type IconName } from "./icons";
import { getSavedThreadId, SavedThreadStatus } from "./SavedThreadStatus";
import { MemoryDetails } from "./MemoryPanel";
import type { SessionMemory } from "./memory-model";
import { ThreadTags } from "./ThreadTags";
import { useSessionThreadDetail } from "./useSessionThreadDetail";

interface ActionButtonProps {
  children: ReactNode;
  icon: IconName;
  variant?: "primary" | "neutral" | "destructive";
  disabled?: boolean;
  primaryAction?: boolean;
  onClick: () => void;
}

function ActionButton({
  children,
  icon,
  variant = "neutral",
  disabled,
  primaryAction,
  onClick,
}: ActionButtonProps) {
  return (
    <button
      className={`action-button is-${variant}`}
      type="button"
      disabled={disabled}
      data-primary-action={primaryAction ? "true" : undefined}
      onClick={onClick}
    >
      <Icon name={icon} />
      <span>{children}</span>
    </button>
  );
}

interface ExecutionRouteProps {
  session: SessionSummary;
  detail?: SessionThreadDetail;
  loading?: boolean;
  error?: string;
}

export function ExecutionRoute({ session, detail, loading, error }: ExecutionRouteProps) {
  const plan = session.plan ?? detail?.plan;
  const planSection = plan && plan.total > 0 ? (
      <section className="detail-section plan-section">
        <h3>
          执行路线 <span>{plan.done} / {plan.total}</span>
        </h3>
        <ol className="plan-list">
          {plan.steps.map((step, index) => (
            <li className={`plan-step is-${step.status}`} key={step.id}>
              <span className="plan-marker">
                {step.status === "completed" ? <Icon name="check" /> : index + 1}
              </span>
              <span className="plan-label">{step.label}</span>
              <span className="plan-status">
                {step.status === "completed"
                  ? "完成"
                  : step.status === "in_progress"
                    ? "进行中"
                    : "待执行"}
              </span>
            </li>
          ))}
        </ol>
      </section>
    ) : null;

  if (loading) {
    return (
      <>
        {planSection}
      <section className="detail-section plan-section is-empty">
        <h3>实际执行记录</h3>
        <p>正在读取 Codex 本轮记录…</p>
      </section>
      </>
    );
  }

  const execution = detail?.execution;
  if (execution?.steps.length) {
    return (
      <>
        {planSection}
      <section className="detail-section plan-section execution-section">
        <h3>
          实际执行记录 <span>{execution.steps.length} 项</span>
        </h3>
        <ol className="plan-list">
          {execution.steps.map((step, index) => (
            <li className={`plan-step is-${step.status}`} key={step.id}>
              <span className="plan-marker">
                {step.status === "completed" ? (
                  <Icon name="check" />
                ) : step.status === "failed" ? (
                  <Icon name="close" />
                ) : (
                  index + 1
                )}
              </span>
              <span className="plan-label">
                {step.label}
                {step.count && step.count > 1 ? <small> × {step.count}</small> : null}
              </span>
              <span className="plan-status">
                {step.status === "completed"
                  ? "完成"
                  : step.status === "in_progress"
                    ? "进行中"
                    : "未完成"}
              </span>
            </li>
          ))}
        </ol>
        <p className="execution-note">
          来自 Codex 本轮事件，只表示已经发生和正在进行的操作。
        </p>
      </section>
      </>
    );
  }

  return (
    <>
      {planSection}
    <section className="detail-section plan-section is-empty">
      <h3>{session.provider === "codex" ? "实际执行记录" : "执行路线"}</h3>
      <p>
        {error ??
          detail?.message ??
          (session.surface === "legacy" ? "该终端未上报执行路线" : "该会话未上报执行路线")}
      </p>
    </section>
    </>
  );
}

function ActivityList({ activities }: { activities: SessionActivity[] }) {
  if (!activities.length) {
    return null;
  }

  return (
    <section className="detail-section activity-section">
      <h3>最近活动</h3>
      <ol className="activity-list">
        {activities.slice(0, 8).map((activity) => (
          <li className={activity.tone ? `tone-${activity.tone}` : undefined} key={activity.id}>
            <time dateTime={activity.at}>{formatTime(activity.at, true)}</time>
            <span>{activity.label}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function buildSessionTitleUpdate(draft: string): UpdateAttentionInput | null {
  const title = draft.trim();
  return title ? { title } : null;
}

export function submitSessionTitleUpdate(
  sessionId: string,
  draft: string,
  onUpdate: (sessionId: string, input: UpdateAttentionInput) => void,
): boolean {
  const update = buildSessionTitleUpdate(draft);
  if (!update) {
    return false;
  }
  onUpdate(sessionId, update);
  return true;
}

interface SessionTitleEditorProps {
  sessionId: string;
  currentTitle: string;
  disabled: boolean;
  onUpdate: (sessionId: string, input: UpdateAttentionInput) => void;
}

function SessionTitleEditor({
  sessionId,
  currentTitle,
  disabled,
  onUpdate,
}: SessionTitleEditorProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(currentTitle);
  const update = buildSessionTitleUpdate(draft);

  const openEditor = () => {
    setDraft(currentTitle);
    setEditing(true);
  };

  const cancel = () => {
    setDraft(currentTitle);
    setEditing(false);
  };

  return (
    <div className={`session-title-editor${editing ? " is-editing" : ""}`}>
      <button
        className="session-title-edit-trigger"
        type="button"
        title="重命名会话"
        aria-label="重命名会话"
        disabled={disabled}
        hidden={editing}
        onClick={openEditor}
      >
        命名
      </button>
      <form
        className="session-title-edit-form"
        hidden={!editing}
        onSubmit={(event) => {
          event.preventDefault();
          if (submitSessionTitleUpdate(sessionId, draft, onUpdate)) {
            setEditing(false);
          }
        }}
      >
        <label>
          <span>会话名称</span>
          <input
            type="text"
            value={draft}
            maxLength={120}
            disabled={disabled}
            autoFocus={editing}
            onChange={(event) => setDraft(event.currentTarget.value)}
          />
        </label>
        <div className="session-title-edit-actions">
          <button type="submit" disabled={disabled || !update}>保存</button>
          <button type="button" onClick={cancel}>取消</button>
        </div>
      </form>
    </div>
  );
}

function approvalVariant(choice: PendingRequest["choices"][number]): "primary" | "neutral" | "destructive" {
  const id = `${choice.id} ${choice.label}`.toLowerCase();
  if (/decline|reject|deny|拒绝/.test(id)) {
    return "destructive";
  }
  if (/accept|approve|allow|批准|允许/.test(id)) {
    return "primary";
  }
  return "neutral";
}

function approvalIcon(choice: PendingRequest["choices"][number]): IconName {
  const id = `${choice.id} ${choice.label}`.toLowerCase();
  if (/decline|reject|deny|拒绝/.test(id)) {
    return "close";
  }
  if (/accept|approve|allow|批准|允许/.test(id)) {
    return "check";
  }
  return "message";
}

interface RequestPanelProps {
  request: PendingRequest;
  enabled: boolean;
  busyAction: string | null;
  onRespond: (input: RespondRequestInput) => Promise<boolean>;
}

function RequestPanel({ request, enabled, busyAction, onRespond }: RequestPanelProps) {
  const [answer, setAnswer] = useState("");
  const [choiceId, setChoiceId] = useState<string | null>(request.choices[0]?.id ?? null);
  const responding = busyAction?.startsWith(`respond:${request.requestId}:`) ?? false;
  const primaryApprovalChoiceId = enabled
    ? request.choices.find((choice) => approvalVariant(choice) !== "destructive")?.id
    : undefined;

  const submitQuestion = () => {
    if (!choiceId) {
      return;
    }
    void onRespond({ choiceId, ...(answer.trim() ? { text: answer.trim() } : {}) });
  };

  return (
    <section className={`request-panel is-${request.kind}`} data-testid="request-panel">
      <h3>{request.kind === "approval" ? "处理审批" : "回答问题"}</h3>
      <strong>{request.title}</strong>
      {request.detail ? <p>{request.detail}</p> : null}

      {request.kind === "question" ? (
        <>
          <div className="question-choices" role="radiogroup" aria-label={request.title}>
            {request.choices.map((choice) => (
              <label key={choice.id} className={choiceId === choice.id ? "is-selected" : ""}>
                <input
                  type="radio"
                  name={`request-${request.requestId}`}
                  value={choice.id}
                  checked={choiceId === choice.id}
                  disabled={!enabled}
                  onChange={() => setChoiceId(choice.id)}
                />
                <span>
                  <strong>{choice.label}</strong>
                  {choice.description ? <small>{choice.description}</small> : null}
                </span>
              </label>
            ))}
          </div>
          <textarea
            className="request-answer"
            value={answer}
            disabled={!enabled}
            onChange={(event) => setAnswer(event.currentTarget.value)}
            placeholder="补充说明（可选）"
            aria-label="补充说明"
          />
          <ActionButton
            icon="send"
            variant="primary"
            disabled={!choiceId || !enabled || responding}
            primaryAction={Boolean(choiceId) && enabled && !responding}
            onClick={submitQuestion}
          >
            回答问题
          </ActionButton>
        </>
      ) : (
        <div className="approval-actions">
          {request.choices.map((choice) => (
            <ActionButton
              key={choice.id}
              icon={approvalIcon(choice)}
              variant={approvalVariant(choice)}
              disabled={!enabled || responding}
              primaryAction={
                !responding && choice.id === primaryApprovalChoiceId
              }
              onClick={() => void onRespond({ choiceId: choice.id })}
            >
              {choice.label}
            </ActionButton>
          ))}
        </div>
      )}

      {request.cwd ? (
        <div className="request-cwd">
          <span>cwd</span>
          <code>{request.cwd}</code>
        </div>
      ) : null}
      {request.command ? <pre>{request.command}</pre> : null}
    </section>
  );
}

interface MessageComposerProps {
  session: SessionSummary;
  busyAction: string | null;
  primaryAction: boolean;
  onSend: (text: string) => Promise<boolean>;
  onInterrupt: () => void;
}

function MessageComposer({
  session,
  busyAction,
  primaryAction,
  onSend,
  onInterrupt,
}: MessageComposerProps) {
  const [message, setMessage] = useState("");
  const sending = busyAction === `message:${session.id}`;
  const interrupting = busyAction === `interrupt:${session.id}`;
  const active = session.activityState === "running";
  const canInterrupt = !session.stale && session.capabilities.interrupt;
  const canMessage =
    !session.stale &&
    (active ? session.capabilities.steer : session.capabilities.send);

  const send = async () => {
    const text = message.trim();
    if (!text || !canMessage) {
      return;
    }
    if (await onSend(text)) {
      setMessage("");
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void send();
    }
  };

  return (
    <section className="message-panel">
      <h3>发送消息给 Codex</h3>
      <div className="message-input-wrap">
        <textarea
          value={message}
          disabled={!canMessage}
          onChange={(event) => setMessage(event.currentTarget.value)}
          onKeyDown={handleKeyDown}
          placeholder={active ? "告诉 Codex 你的想法…" : "向该会话发送消息…"}
          aria-label="发送消息给 Codex"
          data-primary-action={primaryAction && canMessage ? "true" : undefined}
        />
        <span>⌘↵ 发送</span>
      </div>
      <div className="message-actions">
        <ActionButton
          icon="send"
          variant="primary"
          disabled={!message.trim() || !canMessage || sending}
          onClick={() => void send()}
        >
          {active ? "追加到当前任务" : "发送消息给 Codex"}
        </ActionButton>
        {session.capabilities.interrupt ? (
          <ActionButton
            icon="stop"
            variant="destructive"
            disabled={!canInterrupt || interrupting}
            onClick={onInterrupt}
          >
            中断任务
          </ActionButton>
        ) : null}
      </div>
    </section>
  );
}

interface WorkbenchProps {
  memoryEnabled?: boolean;
  memory?: SessionMemory;
  memorySampledAt?: string;
  session?: SessionSummary;
  recovery?: RecoveryRecord | null;
  focusedSession?: SessionSummary;
  open: boolean;
  emptyMessage?: string;
  busyAction: string | null;
  onClose: () => void;
  onSelect: (sessionId: string) => void;
  onFocus: (sessionId: string) => void;
  onSend: (sessionId: string, text: string) => Promise<boolean>;
  onInterrupt: (sessionId: string) => void;
  onRespond: (
    sessionId: string,
    requestId: string,
    input: RespondRequestInput,
  ) => Promise<boolean>;
  onUpdateAttention: (sessionId: string, input: UpdateAttentionInput) => void;
  tagSuggestions?: readonly string[];
  onUpdateTags?: (threadId: string, input: UpdateThreadTagsInput) => Promise<boolean>;
}

export function Workbench({
  memoryEnabled = false,
  memory,
  memorySampledAt,
  session,
  recovery,
  focusedSession,
  open,
  emptyMessage = "从左侧选择一个会话",
  busyAction,
  onClose,
  onSelect,
  onFocus,
  onSend,
  onInterrupt,
  onRespond,
  onUpdateAttention,
  tagSuggestions,
  onUpdateTags,
}: WorkbenchProps) {
  const threadDetail = useSessionThreadDetail(session, true);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && dialog && !dialog.open) {
      dialog.showModal();
    }
    if (open && !wasOpenRef.current) {
      backRef.current?.focus();
    }
    wasOpenRef.current = open;
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, [open]);

  if (!session) {
    return (
      <main className="workbench is-empty">
        <div className="workbench-empty">
          <span>WORKBENCH</span>
          <Icon name="message" />
          <h1>{emptyMessage}</h1>
          <p>选择一个会话后，这里会保留它的上下文和当前安全操作。</p>
        </div>
      </main>
    );
  }

  const tone = sessionTone(session);
  const identity = sessionIdentity(session);
  const threadId = getSavedThreadId(session);
  const pendingRequest = session.pendingRequest;
  const attentionBusy = busyAction === `attention:${session.id}`;
  const focusing = busyAction?.startsWith("focus:") ?? false;
  const focusTitle =
    session.plan?.steps.find((step) => step.status === "in_progress")?.label ??
    session.currentActivity ??
    session.title;
  const focusReason =
    session.currentActivity && session.currentActivity !== focusTitle
      ? session.currentActivity
      : undefined;
  const focusedIdentity = focusedSession ? sessionIdentity(focusedSession) : undefined;
  const focusedElsewhere = focusedSession && focusedSession.id !== session.id;

  return (
    <dialog
      ref={dialogRef}
      className={`workbench${open ? " is-open" : ""}`}
      aria-label="会话工作台"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="drawer-bar">
        <button ref={backRef} type="button" className="workbench-back" onClick={onClose}>
          <Icon name="back" />
          <span className="workbench-back-desktop">关闭</span>
          <span className="workbench-back-mobile">返回列表</span>
        </button>
      </div>
      <div className="detail-scroll">
        <header className="session-meta">
          <div className="workbench-heading">
            <span>WORKBENCH</span>
            <div className="session-view-state" aria-label="会话位置状态">
              <span className="is-selected">正在查看</span>
              {session.focused ? <span className="is-focused">你在这里</span> : null}
            </div>
          </div>
          <div className={`session-identity-heading ${identity.tabIndex ? "has-tab-locator" : "has-session-locator"}`}>
            <strong
              className="session-locator"
              title={identity.tabIndex ? identity.fullLocator : session.conversationId ?? session.id}
            >
              {identity.tabIndex ? identity.locator : shortId(session.conversationId ?? session.id)}
            </strong>
            <div>
              <span>
                {[identity.shortcut, identity.paneIndex ? `PANE ${String(identity.paneIndex).padStart(2, "0")}` : null]
                  .filter(Boolean)
                  .join(" · ") || (session.surface === "legacy" ? "ITERM SESSION" : "CODEX SESSION")}
              </span>
              <h1>{identity.primary}</h1>
              <p title={session.cwd}>{identity.secondary}</p>
            </div>
          </div>
          <SavedThreadStatus session={session} recovery={recovery} />
          {threadId ? <ThreadTags key={threadId} threadId={threadId} tags={session.tags ?? (recovery?.sessionId === threadId ? recovery.tags : undefined)}
            tagSuggestions={tagSuggestions} onUpdateTags={onUpdateTags} /> : null}
          <dl>
            <div>
              <dt>项目</dt>
              <dd>{session.projectName}</dd>
            </div>
            <div>
              <dt>cwd</dt>
              <dd title={session.cwd}>{session.cwd}</dd>
            </div>
            <div>
              <dt>分支</dt>
              <dd>
                <Icon name="branch" />
                {session.branch ?? "—"}
              </dd>
            </div>
            <div>
              <dt>{identity.tty ? "TTY" : "会话 ID"}</dt>
              <dd title={identity.tty ?? session.conversationId ?? session.terminalSessionId}>
                {identity.tty ?? shortId(session.conversationId ?? session.terminalSessionId)}
              </dd>
            </div>
          </dl>
          <div className="attention-controls">
            <SessionTitleEditor
              key={session.id}
              sessionId={session.id}
              currentTitle={session.title}
              disabled={attentionBusy}
              onUpdate={onUpdateAttention}
            />
            <button
              className={session.pinned ? "is-active" : ""}
              type="button"
              title={session.pinned ? "取消置顶" : "置顶"}
              aria-label={session.pinned ? "取消置顶" : "置顶"}
              disabled={attentionBusy}
              onClick={() => onUpdateAttention(session.id, { pinned: !session.pinned })}
            >
              <Icon name="pin" />
            </button>
            <button
              className={session.parked ? "is-active" : ""}
              type="button"
              title={session.parked ? "取消稍后再看" : "稍后再看"}
              aria-label={session.parked ? "取消稍后再看" : "稍后再看"}
              aria-pressed={session.parked}
              disabled={attentionBusy}
              onClick={() => onUpdateAttention(session.id, { parked: !session.parked })}
            >
              <Icon name="clock" />
              <span>稍后再看</span>
            </button>
          </div>
        </header>

        {focusedElsewhere && focusedIdentity ? (
          <section className="physical-location-bar" aria-label="iTerm 实际位置">
            <span className="physical-location-dot" aria-hidden="true" />
            <div>
              <span>iTerm 实际位置</span>
              <strong>{focusedIdentity.locator} · {focusedIdentity.primary}</strong>
              <small>{focusedIdentity.secondary}</small>
            </div>
            <button type="button" onClick={() => onSelect(focusedSession.id)}>
              <span>查看</span>
              <Icon name="arrow" />
            </button>
          </section>
        ) : null}

        <section className="current-activity">
          <div>
            <span>{session.attentionReason ? "现在需要你" : "当前工作"}</span>
            <h2>{focusTitle}</h2>
            {focusReason ? <p className="focus-reason">{focusReason}</p> : null}
          </div>
          <dl>
            <div>
              <dt>状态</dt>
              <dd className={`tone-${tone}`}>
                {session.attentionReason
                  ? attentionLabel(session.attentionReason)
                  : activityLabel(session.activityState)}
              </dd>
            </div>
            <div>
              <dt>最后活动</dt>
              <dd>{formatTime(session.lastActivityAt, true)}</dd>
            </div>
          </dl>
        </section>

        {session.stale ? (
          <div className="stale-notice">
            <Icon name="alert" />
            <span>这个状态已经过期，操作已按当前能力关闭。</span>
          </div>
        ) : null}

        <div className={`interaction-grid${pendingRequest ? " has-request" : ""}`}>
          {pendingRequest ? (
            <RequestPanel
              key={pendingRequest.requestId}
              request={pendingRequest}
              enabled={
                !session.stale &&
                (pendingRequest.kind === "approval"
                  ? session.capabilities.approve
                  : session.capabilities.answer)
              }
              busyAction={busyAction}
              onRespond={(input) => onRespond(session.id, pendingRequest.requestId, input)}
            />
          ) : null}

          {isManaged(session) ? (
            <MessageComposer
              key={session.id}
              session={session}
              busyAction={busyAction}
              primaryAction={!pendingRequest}
              onSend={(text) => onSend(session.id, text)}
              onInterrupt={() => onInterrupt(session.id)}
            />
          ) : (
            <section className="legacy-actions">
              <p>{session.currentActivity ?? session.title}</p>
              <ActionButton
                icon="focus"
                variant="primary"
                disabled={
                  session.stale ||
                  !session.capabilities.focus ||
                  focusing
                }
                primaryAction={
                  !session.stale &&
                  session.capabilities.focus &&
                  !focusing
                }
                onClick={() => onFocus(session.id)}
              >
                {focusing ? "切换中…" : "跳回 iTerm"}
              </ActionButton>
            </section>
          )}
        </div>

        {memoryEnabled ? <MemoryDetails key={session.id} session={session} memory={memory} sampledAt={memorySampledAt} /> : null}

        <div className="detail-secondary-grid">
          <ExecutionRoute
            session={session}
            detail={threadDetail.detail}
            loading={threadDetail.loading}
            error={threadDetail.error}
          />
          <ActivityList activities={session.activities} />
        </div>

        <div className="detail-bottom-actions">
          {session.attentionReason === "newly_completed" ? (
            <ActionButton
              icon="check"
              disabled={attentionBusy}
              onClick={() => onUpdateAttention(session.id, { acknowledge: true })}
            >
              标记已查看
            </ActionButton>
          ) : null}
          <ActionButton
            icon="clock"
            disabled={attentionBusy}
            onClick={() => onUpdateAttention(session.id, { parked: !session.parked })}
          >
            {session.parked ? "取消稍后再看" : "稍后再看"}
          </ActionButton>
        </div>
      </div>
    </dialog>
  );
}
