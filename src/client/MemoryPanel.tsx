import type { SessionSummary } from "../shared/types";
import { MEMORY_EXPLANATION, memoryOffline, memorySize, type SessionMemory } from "./memory-model";
import type { useMemorySnapshot } from "./useMemorySnapshot";

function samplingTime(sampledAt?: string) {
  return sampledAt ? new Date(sampledAt).toLocaleTimeString("zh-CN", { hour12: false }) : "未采样";
}

export function MemoryToolbar({ memory, ready }: { memory: ReturnType<typeof useMemorySnapshot>; ready: boolean }) {
  return <div className="memory-toolbar" aria-label="内存显示控制">
    <label><input type="checkbox" checked={memory.enabled} onChange={(e) => memory.setEnabled(e.target.checked)} />显示内存</label>
    {memory.enabled ? <>
      <button type="button" disabled={memory.busy || !ready} onClick={() => void memory.refresh()} aria-label="刷新内存">{memory.busy ? "采集中…" : "刷新"}</button>
      <small title={memory.snapshot ? `采样于 ${new Date(memory.snapshot.sampledAt).toLocaleString("zh-CN")}` : "等待在线会话"}>{samplingTime(memory.snapshot?.sampledAt)}</small>
      <span className="memory-explanation" tabIndex={0} aria-label={MEMORY_EXPLANATION} title={MEMORY_EXPLANATION}>ⓘ</span>
      {memory.error ? <span className="memory-error" role="alert" title={memory.error}>采集失败{memory.snapshot ? " · 旧值" : ""}</span> : null}
    </> : null}
  </div>;
}

export function MemoryBadge({ session, memory, highlighted }: { session: SessionSummary; memory?: SessionMemory; highlighted: boolean }) {
  const offline = memoryOffline(session, memory);
  const suffix = offline && memory ? "旧" : memory?.missingFootprints ? "部分" : "";
  const label = `${memorySize(memory?.footprintBytes)}${suffix ? ` · ${suffix}` : ""}`;
  return <span className={`honey-memory${highlighted && !offline ? " is-high" : ""}`} aria-label={`内存 ${label}`} title={`${label}${highlighted && !offline ? " · 本次完整采样前三" : ""}`}>
    {memorySize(memory?.footprintBytes)}{suffix ? <small>{suffix}</small> : null}
  </span>;
}

export function MemorySummary({ session, memory, sampledAt }: { session: SessionSummary; memory?: SessionMemory; sampledAt?: string }) {
  return <div className="memory-summary">
    <span>Footprint <b>{memorySize(memory?.footprintBytes)}</b>{memory?.missingFootprints ? "（部分）" : ""}</span>
    <span>RSS {memorySize(memory?.rssBytes)} · {memory ? `${memory.processes.length} 个进程` : "未采样或无法归属"}</span>
    <small>{samplingTime(sampledAt)}{memoryOffline(session, memory) && memory ? " · 会话离线，仅为旧样本" : ""}</small>
  </div>;
}

export function MemoryDetails({ session, memory, sampledAt }: { session: SessionSummary; memory?: SessionMemory; sampledAt?: string }) {
  return <details className="memory-details detail-section">
    <summary>内存与子进程 <span>{memorySize(memory?.footprintBytes)}{memory?.missingFootprints ? "（部分）" : ""}</span></summary>
    <MemorySummary session={session} memory={memory} sampledAt={sampledAt} />
    <p>{MEMORY_EXPLANATION}</p>
    {memory?.processes.length ? <div className="memory-table-wrap"><table><thead><tr><th>进程</th><th>PID</th><th>Footprint</th><th>RSS</th></tr></thead><tbody>
      {memory.processes.map((p) => <tr key={p.pid}><td title={p.name}>{p.name}</td><td>{p.pid}</td><td>{memorySize(p.footprintBytes)}</td><td>{memorySize(p.rssBytes)}</td></tr>)}
    </tbody></table></div> : <p>尚无可归属的进程数据，可在看板顶部刷新内存。</p>}
    <p>进程退出、脱离父进程或读取权限限制可能影响归属和数值。</p>
  </details>;
}
