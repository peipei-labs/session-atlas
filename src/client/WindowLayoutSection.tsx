import type { ItermWindowLayoutRecord, SessionAtlasHealth } from "../shared/types";
import { isLayoutRestorable } from "./attention-model";
import { formatTime } from "./format";
import { Icon } from "./icons";

interface WindowLayoutSectionProps {
  layouts: ItermWindowLayoutRecord[];
  health: SessionAtlasHealth;
  busyId: string | null;
  onRestore: (windowId: string) => void;
}

function paneCount(layout: ItermWindowLayoutRecord): number {
  return layout.tabs.reduce((total, tab) => total + tab.panes.length, 0);
}

export function WindowLayoutSection({
  layouts,
  health,
  busyId,
  onRestore,
}: WindowLayoutSectionProps) {
  if (!layouts.length) {
    return null;
  }

  const itermOffline = health.iterm !== "online";

  return (
    <section className="dock-panel-section" data-testid="layout-section">
      <h2 className="dock-panel-heading">
        <Icon name="layout" />
        <strong>窗口布局</strong>
        <em>{layouts.length}</em>
      </h2>
      <div className="dock-panel-body layout-shelf">
        {layouts.map((layout) => {
          const restorable = isLayoutRestorable(layout, health);
          const busy = busyId === layout.windowId;
          const partial = layout.restoreStatus === "partial";
          return (
            <article className="layout-card" key={layout.windowId}>
              <div className="layout-heading">
                <strong>
                  {layout.windowIndex ? `窗口 ${layout.windowIndex}` : "未定位窗口"}
                </strong>
                <code>
                  {layout.tabs.length} 个标签 · {paneCount(layout)} 个分屏
                </code>
                <time dateTime={layout.closedAt ?? layout.lastSeenAt}>
                  关闭于 {formatTime(layout.closedAt ?? layout.lastSeenAt)}
                </time>
              </div>
              <ul className="layout-tab-list">
                {layout.tabs.map((tab) => (
                  <li key={tab.tabId}>
                    <code>{String(tab.tabIndex).padStart(2, "0")}</code>
                    <span>{tab.panes[0]?.title ?? "空标签"}</span>
                    {tab.panes.length > 1 ? <small>{tab.panes.length} 分屏</small> : null}
                  </li>
                ))}
              </ul>
              {partial ? (
                <p className="layout-partial-notice">
                  <Icon name="alert" />
                  <span>上次恢复未完全确认{layout.restoreMessage ? `：${layout.restoreMessage}` : "。"}</span>
                </p>
              ) : null}
              <button
                className="layout-restore-button"
                data-testid="layout-restore-button"
                type="button"
                disabled={!restorable || busy}
                title={
                  itermOffline
                    ? "iTerm2 离线，无法恢复窗口布局"
                    : partial
                      ? "上次恢复结果不确定，请人工确认后重试"
                      : undefined
                }
                onClick={() => onRestore(layout.windowId)}
              >
                <Icon name={busy ? "clock" : "refresh"} />
                <span>{busy ? "正在恢复…" : "恢复窗口布局"}</span>
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}
