import { useEffect, useRef, useState, type Ref } from "react";

import type { SessionAtlasHealth } from "../shared/types";
import type { Appearance } from "./appearance";
import { AppearanceMenu } from "./AppearanceMenu";
import { Icon } from "./icons";

interface HeaderProps {
  health: SessionAtlasHealth;
  query: string;
  canCreateThread: boolean;
  searchInputRef: Ref<HTMLInputElement>;
  appearance?: Appearance;
  onAppearanceChange?: (appearance: Appearance) => void;
  onCreateThread: () => void;
  onQueryChange: (query: string) => void;
  onToggleLanes?: () => void;
  onToggleInbox?: () => void;
}

function connectionLabel(health: SessionAtlasHealth): "offline" | "limited" | "online" {
  if (health.codex === "offline" && health.iterm === "offline") {
    return "offline";
  }
  if (
    health.controller === "degraded" ||
    health.codex !== "online" ||
    health.iterm !== "online"
  ) {
    return "limited";
  }
  return "online";
}

function connectionCopy(connection: ReturnType<typeof connectionLabel>): string {
  switch (connection) {
    case "offline":
      return "离线";
    case "limited":
      return "受限";
    case "online":
      return "已连接";
  }
}

export function Header({
  health,
  query,
  canCreateThread,
  searchInputRef,
  appearance,
  onAppearanceChange,
  onCreateThread,
  onQueryChange,
  onToggleLanes,
  onToggleInbox,
}: HeaderProps) {
  const connection = connectionLabel(health);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const appearanceAnchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!appearanceOpen) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      if (!appearanceAnchorRef.current?.contains(event.target as Node | null)) {
        setAppearanceOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setAppearanceOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [appearanceOpen]);

  return (
    <header className="app-header">
      {onToggleLanes ? (
        <button
          aria-label="状态车道"
          className="rail-toggle"
          onClick={onToggleLanes}
          title="状态车道"
          type="button"
        >
          <Icon name="layout" />
        </button>
      ) : null}
      <div className="brand" aria-label="Session Atlas">
        <Icon className="brand-mark" name="atlas" />
        <span className="brand-wordmark">Session Atlas</span>
      </div>

      <label className={`session-search${query ? " is-active" : ""}`}>
        <Icon name="search" />
        <input
          ref={searchInputRef}
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
          placeholder="搜索会话 / 项目 / 标签"
          aria-label="搜索会话 / 项目"
        />
        <kbd>⌘K</kbd>
      </label>

      <div className="header-deco" aria-hidden="true" />

      <div className="header-side">
        <div
          className={`connection-state is-${connection}`}
          role="status"
          title={health.message ?? "本地控制器连接状态"}
        >
          <span className="connection-dot" />
          <span className="connection-label">{connectionCopy(connection)}</span>
          <span className="sr-only">本地连接</span>
        </div>

        {appearance && onAppearanceChange ? (
          <div className="appearance-anchor" ref={appearanceAnchorRef}>
            <button
              aria-expanded={appearanceOpen}
              aria-haspopup="menu"
              aria-label="外观设置"
              className={`appearance-button${appearanceOpen ? " is-open" : ""}`}
              onClick={() => setAppearanceOpen((open) => !open)}
              title="外观设置"
              type="button"
            >
              <Icon name="palette" />
            </button>
            {appearanceOpen ? (
              <AppearanceMenu appearance={appearance} onChange={onAppearanceChange} />
            ) : null}
          </div>
        ) : null}

        <button
          className="create-thread-button"
          type="button"
          aria-label="新建 Codex"
          title="新建 Codex"
          disabled={!canCreateThread}
          onClick={onCreateThread}
        >
          <Icon name="plus" />
          <span>新建</span>
          <kbd>⌘N</kbd>
        </button>

        {onToggleInbox ? (
          <button
            aria-label="待续与恢复"
            className="rail-toggle"
            onClick={onToggleInbox}
            title="待续与恢复"
            type="button"
          >
            <Icon name="pin" />
          </button>
        ) : null}
      </div>
    </header>
  );
}
