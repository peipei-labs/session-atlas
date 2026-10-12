import { useEffect, useState } from "react";

import type { RecoveryPreview, RecoveryRecord, SessionSummary, UpdateThreadTagsInput } from "../shared/types";
import { Icon } from "./icons";
import { OpenThreadAction, openThreadLocations, threadLocationStatus } from "./OpenThreadAction";
import { ThreadTags } from "./ThreadTags";

interface RecoveryShelfProps {
  records: RecoveryRecord[];
  restartSessionIds?: string[];
  canRestore?: boolean;
  busy?: boolean;
  previews?: Record<string, RecoveryPreview>;
  previewLoading?: boolean;
  previewError?: string;
  onRestore?: (sessionIds: string[]) => Promise<boolean>;
  sessions?: SessionSummary[];
  openBusy?: boolean;
  onOpen?: (sessionId: string) => Promise<"focused" | "restored" | null>;
  onFocusSession?: (sessionId: string) => Promise<boolean>;
  onOpenSession?: (sessionId: string) => void;
  tagSuggestions?: readonly string[];
  onUpdateTags?: (threadId: string, input: UpdateThreadTagsInput) => Promise<boolean>;
}

const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard copy is unavailable");
}

export function RecoveryShelf({
  records,
  restartSessionIds = [],
  canRestore = false,
  busy = false,
  previews = {},
  previewLoading = false,
  previewError,
  onRestore,
  sessions = [], openBusy = false, onOpen, onFocusSession, onOpenSession,
  tagSuggestions, onUpdateTags,
}: RecoveryShelfProps) {
  const [copiedId, setCopiedId] = useState<string>();
  const [copyError, setCopyError] = useState<string>();
  const [submittedKey, setSubmittedKey] = useState<string>();
  const [openedIds, setOpenedIds] = useState<string[]>([]);
  const [openMessage, setOpenMessage] = useState("");

  useEffect(() => {
    setOpenedIds((current) => {
      const remaining = current.filter((id) => openThreadLocations(sessions, id).length === 0);
      return remaining.length === current.length ? current : remaining;
    });
  }, [sessions, openedIds]);

  if (!records.length) return null;

  const restartKey = restartSessionIds.join(":");
  const submitted = Boolean(restartKey && submittedKey === restartKey);

  return (
    <section className="dock-panel-section" data-testid="recovery-section">
      <h2 className="dock-panel-heading">
        <Icon name="clock" />
        <strong>最近关闭</strong>
        <em>{records.length}</em>
      </h2>
      <div className="dock-panel-body recovery-shelf">
        {restartSessionIds.length ? (
          <div className="recovery-restore-banner" data-testid="recovery-restore-banner">
            <span>
              <strong>重启后待恢复：{restartSessionIds.length} 个 Codex session</strong>
              <small>将回到原来的 iTerm2 tab 和分屏；原空 shell 会保留在 Buried Sessions。</small>
            </span>
            <button
              type="button"
              disabled={!canRestore || busy || submitted || !onRestore}
              onClick={() => {
                setCopyError(undefined);
                void onRestore?.(restartSessionIds).then((success) => {
                  if (success) setSubmittedKey(restartKey);
                });
              }}
            >
              <Icon name={submitted ? "check" : "refresh"} />
              <span>{submitted ? "已提交恢复" : busy ? "正在恢复…" : "一键恢复"}</span>
            </button>
          </div>
        ) : null}
        <div className="recovery-shelf-list">
          {records.map((record) => {
            const copied = copiedId === record.sessionId;
            const preview = previews[record.sessionId];
            const locations = openThreadLocations(sessions, record.sessionId);
            const hasDistinctLatestRequest =
              preview?.status === "available" &&
              preview.latestRequest !== preview.firstRequest;
            return (
              <article key={record.sessionId}>
                <div className="recovery-heading">
                  <span>
                    <strong>{record.projectName}</strong>
                    <small>{record.title}</small>
                  </span>
                  <time dateTime={record.closedAt}>
                    {record.closedAt ? dateTimeFormatter.format(new Date(record.closedAt)) : "—"}
                  </time>
                </div>
                <ThreadTags threadId={record.sessionId} tags={record.tags} tagSuggestions={tagSuggestions} onUpdateTags={onUpdateTags} />
                {onOpen ? <div className="recovery-open-action">
                  <small>{threadLocationStatus(record, locations)}</small>
                  <OpenThreadAction record={record} sessions={sessions} canUseIterm={canRestore} busy={busy || openBusy}
                    submitted={openedIds.includes(record.sessionId)} onOpenSession={onOpenSession} onFocusSession={onFocusSession}
                    onResume={() => {
                      void onOpen(record.sessionId).then((result) => {
                        if (result === "restored") setOpenedIds((current) => [...current, record.sessionId]);
                        if (result) setOpenMessage(result === "focused" ? "已回到现有分屏。" : "已请求恢复原线程，等待关联确认。");
                      });
                    }} />
                </div> : null}
                {preview?.status === "available" ? (
                  <>
                    <div className="recovery-request-block">
                      <small>最初要求</small>
                      <p>{preview.firstRequest}</p>
                    </div>
                    {hasDistinctLatestRequest ? (
                      <div className="recovery-request-block is-latest">
                        <small>最后要求</small>
                        <p>{preview.latestRequest}</p>
                      </div>
                    ) : null}
                    {preview.userMessageCount !== undefined ? (
                      <small className="recovery-message-count">
                        {preview.userMessageCount} 条用户消息
                      </small>
                    ) : null}
                  </>
                ) : (
                  <p className="recovery-preview-status">
                    {previewLoading
                      ? "正在读取会话内容…"
                      : previewError
                        ? "会话内容暂时无法读取"
                        : "未找到对应的 Codex 会话文件"}
                  </p>
                )}
                <details className="recovery-technical">
                  <summary>恢复信息</summary>
                  <code className="recovery-session-id">{record.sessionId}</code>
                  <small className="recovery-cwd">{record.cwd}</small>
                  <div className="recovery-command-row">
                    <code>{record.resumeCommand}</code>
                    <button
                      type="button"
                      onClick={() => {
                        setCopyError(undefined);
                        void writeClipboard(record.resumeCommand).then(
                          () => {
                            setCopiedId(record.sessionId);
                            window.setTimeout(() => setCopiedId(undefined), 2_400);
                          },
                          () => setCopyError("复制失败，请手动选择命令"),
                        );
                      }}
                    >
                      <Icon name={copied ? "check" : "copy"} />
                      <span>{copied ? "已复制" : "复制备用命令"}</span>
                    </button>
                  </div>
                </details>
              </article>
            );
          })}
        </div>
        <p className="continuation-status" role="status">{openMessage}</p>
        <p className="recovery-copy-status" role="status" aria-live="polite">
          {copyError ??
            (restartSessionIds.length && !canRestore
              ? "iTerm2 连接离线，连接恢复后才能一键恢复。"
              : submitted
                ? `已请求恢复 ${restartSessionIds.length} 个 Codex session。`
                : "")}
        </p>
      </div>
    </section>
  );
}
