import { useRef, useState, type FormEvent } from "react";

import type { UpdateThreadTagsInput } from "../shared/types";
import { normalizeThreadTag, THREAD_TAG_LIMIT, ThreadTagsValidationError } from "../shared/thread-tags";
import { distinctThreadTags, isThreadTagId, tagKey } from "./thread-tags-model";

export function ThreadTagChips({ tags, compact = false }: { tags?: readonly string[]; compact?: boolean }) {
  const labels = distinctThreadTags(tags);
  if (!labels.length) return null;
  const visible = compact ? labels.slice(0, 2) : labels;
  return <span className={`thread-tag-chips${compact ? " is-compact" : ""}`} title={`标签：${labels.join("、")}`} aria-label={`标签：${labels.join("、")}`}>
    {visible.map((tag) => <span className="thread-tag-chip" key={tagKey(tag)}>{tag}</span>)}
    {compact && labels.length > visible.length ? <span className="thread-tag-more">+{labels.length - visible.length}</span> : null}
  </span>;
}

interface ThreadTagsProps {
  threadId: string;
  tags?: readonly string[];
  tagSuggestions?: readonly string[];
  onUpdateTags?: (threadId: string, input: UpdateThreadTagsInput) => Promise<boolean>;
}

export function ThreadTags({ threadId, tags, tagSuggestions, onUpdateTags }: ThreadTagsProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const pending = useRef(false);
  const labels = distinctThreadTags(tags);
  const keys = new Set(labels.map(tagKey));
  if (!isThreadTagId(threadId)) return null;
  if (!onUpdateTags) return <ThreadTagChips tags={labels} />;
  const suggestions = distinctThreadTags(tagSuggestions).filter((tag) =>
    !keys.has(tagKey(tag)) && tagKey(tag).includes(tagKey(draft))).slice(0, 6);

  const update = async (input: UpdateThreadTagsInput, submittedDraft?: string) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setMessage("");
    try {
      const success = await onUpdateTags(threadId, input);
      if (success) {
        if (submittedDraft !== undefined) setDraft((current) => current === submittedDraft ? "" : current);
        setMessage("标签已保存。");
      } else setMessage("标签未确认保存，请重试。");
    } catch {
      setMessage("标签未确认保存，请重试。");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const addTag = (raw: string) => {
    if (!raw.trim()) return;
    let tag: string;
    try { tag = normalizeThreadTag(raw); }
    catch (error) { setMessage(error instanceof ThreadTagsValidationError ? error.message : "标签格式不正确。"); return; }
    if (keys.has(tagKey(tag))) { setMessage("这个标签已经存在。"); return; }
    if (labels.length >= THREAD_TAG_LIMIT) { setMessage(`每个线程最多 ${THREAD_TAG_LIMIT} 个标签，可先移除不用的标签。`); return; }
    void update({ add: [tag] }, draft);
  };
  const submit = (event: FormEvent) => { event.preventDefault(); addTag(draft); };

  return <div className="thread-tags" data-thread-id={threadId}>
    <div className="thread-tags-heading">
      <span className="thread-tags-caption">标签</span>
      {editing ? <div className="thread-tag-chips">{labels.map((tag) => <span className="thread-tag-chip" key={tagKey(tag)}>
        <span>{tag}</span><button type="button" aria-label={`移除标签 ${tag}`} disabled={busy}
          onClick={() => { void update({ remove: [tag] }); }}>×</button>
      </span>)}</div> : <ThreadTagChips tags={labels} />}
      <button type="button" className="thread-tags-toggle" aria-expanded={editing} disabled={busy}
        onClick={() => setEditing((value) => !value)}>{editing ? "收起" : labels.length ? "编辑标签" : "添加标签"}</button>
    </div>
    {editing ? <div className="thread-tags-editor">
      <form onSubmit={submit}>
        <input aria-label="新标签" value={draft} disabled={busy} placeholder="输入一个标签，例如 Python"
          onChange={(event) => { setDraft(event.currentTarget.value); setMessage(""); }} />
        <button type="submit" disabled={busy || !draft.trim()}>{busy ? "保存中…" : "添加"}</button>
      </form>
      {suggestions.length ? <div className="thread-tag-suggestions" aria-label="已用标签建议">
        <small>已用标签</small>{suggestions.map((tag) => <button type="button" key={tagKey(tag)} disabled={busy}
          onClick={() => addTag(tag)}>{tag}</button>)}
      </div> : null}
      <small className="thread-tags-hint">可在原线程让 AI 填写，也可在这里调整。标签不会登记待续或收藏。</small>
    </div> : null}
    {message ? <small className="thread-tags-message" role="status">{message}</small> : null}
  </div>;
}

export function ThreadTagFilter({ tags, selected, onToggle, onClear }: {
  tags: readonly { tag: string; count: number }[];
  selected: readonly string[];
  onToggle: (tag: string) => void;
  onClear: () => void;
}) {
  if (!tags.length && !selected.length) return null;
  const counts = new Map(tags.map((entry) => [tagKey(entry.tag), entry]));
  for (const tag of selected) if (!counts.has(tagKey(tag))) counts.set(tagKey(tag), { tag, count: 0 });
  const chosen = new Set(selected.map(tagKey));
  return <div className="thread-tag-filter" role="group" aria-label="线程标签筛选">
    <span>标签</span>
    {selected.length ? <><button type="button" className="thread-tag-filter-clear" onClick={onClear}>清除标签筛选</button><small>同时包含所选标签</small></> : null}
    {[...counts.values()].map(({ tag, count }) => <button type="button" key={tagKey(tag)} aria-pressed={chosen.has(tagKey(tag))}
      title={`${tag} · ${count} 个线程`} onClick={() => onToggle(tag)}><span>{tag}</span><em>{count}</em></button>)}
  </div>;
}
