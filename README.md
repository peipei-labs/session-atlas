# Session Atlas

Session Atlas is a local terminal-control map for concurrent coding-agent sessions. It presents every discovered session on an attention-toned honeycomb board, keeps plain shells, split panes, and Buried Sessions distinguishable, and puts the selected session's next safe action one click away in a workbench drawer. New Codex sessions created inside the dashboard can also be messaged, steered, interrupted, and answered from the browser.

在保留 iTerm2 使用习惯的同时，找到正在等你回应的 Codex 会话，保存原线程的下一步，再按确切的线程 ID 和目录恢复。

![Session Atlas with anonymous demonstration data](docs/screenshots/overview.jpg)

The screenshot uses synthetic demonstration data rendered by the current frontend. Session Atlas is an early personal tool; check the [compatibility notes](docs/compatibility-and-distribution.md) before installing it against real sessions.

The workspace keeps one stable current selection instead of selecting whatever changed most recently. Sidebar rows carry the real iTerm window/tab locator, ⌘ shortcut, compact path, TTY, and focus state, so repeated names such as `Code (codex)` remain distinguishable. Sessions group into four factual lanes — 等待你 / 后台推进 / 可随时返回 / 稍后 — and the workbench keeps the pending request or message composer above the plan route and activity history. Sessions can be given a persistent personal name without renaming the underlying terminal.

The first release is deliberately personal and macOS-only:

- binds to `127.0.0.1` and exposes no remote or cloud endpoint;
- never injects terminal input; installed mode adds its own session-local future-start command to uniquely linked Codex panes, while explicit handoff-and-close uses iTerm's native close and restore creates new sessions;
- sends input only to Codex threads created by its own long-running App Server client; explicit bookmarks may also add an owned prefix to the exact thread name through the local daemon;
- stores attention, bounded recovery/layout metadata, and short handoff cards for agreed unfinished work and explicitly requested bookmarks, not transcripts or terminal screens;
- has no process reaper, terminal emulator, tmux dependency, team mode, or automatic global configuration changes.

## Development

Requirements: Node.js 22.12+, Codex CLI 0.148.x–0.154.x for managed-thread write actions, iTerm2 3.6+ with its Python API enabled, and Python 3 available on PATH for memory sampling. The installation checks have a separate version range; passing a schema probe does not prove runtime compatibility. Codex 0.162.1 is currently rejected by the installation check and is not advertised as supported.

```bash
npm install
npm run dev
```

Open <http://127.0.0.1:4317>. To render the fixed visual QA fixture instead of live sessions:

```bash
VITE_SESSION_ATLAS_DEMO=1 npx vite --host 127.0.0.1 --port 4318
```

Checks:

```bash
npm run protocol:check
npm run check
```

The schema probe accepts CLI 0.148.x–0.155.x and 0.157.x; runtime write actions remain restricted to 0.148.x–0.154.x. The probe also checks lifecycle hooks. See the [version matrix and verification limits](docs/compatibility-and-distribution.md) for the complete distinction. Unsupported versions do not enable writes, and their read operations are not guaranteed.

## Using the workspace

- **显示内存** in the board toolbar shows physical footprint directly under each session title. Hover for RSS, process count and sampling time; open the session workbench and expand **内存与子进程** for process names and PIDs. The first online inventory triggers one sample; use **刷新** thereafter (no polling). Complete live samples in the top three are bold, without changing session colors or order. Partial, missing and offline old values are marked. These per-session sums include traceable background children but are not the system or iTerm app total; reparented processes may not be attributable. Samples are never persisted.

- The strip above the board shows the session you are physically in (`你在这里`), the attention queue as one-click chips, and per-lane status counts.
- The honeycomb board clusters sessions by project or iTerm window; each hexagon cell carries the status tone, attention icon, window/tab locator (with pane number for split tabs), and short title. Window grouping follows actual tab/pane order and remembers the grouping choice across reloads.
- Hovering or focusing a cell opens a tooltip with the session's project, current activity, status, last-active time, plan fraction, branch, and TTY, plus a quick jump back into iTerm.
- Clicking a cell opens the workbench drawer with the full identity strip and the action-first detail surface.
- `命名` assigns a personal label for otherwise identical terminal titles; the existing attention metadata store persists it.
- Cells and the workbench show whether the exact thread is unregistered, has pending items, is bookmarked, or has completed its handoff. Unverified links say `待核对`. `稍后再看` only changes attention priority; saving a handoff remains a separate action.
- Thread tags describe technology, topics, or tasks. The original thread can fill them through `$session-atlas-handoff`; the workbench and saved-thread cards also allow manual additions and removals. Search includes tags, and selecting multiple tag chips matches threads containing all selected tags. Counts deduplicate multiple panes of the same thread. Tags follow the exact original thread across closes and restores, without creating a pending item or bookmark.
- `待续` keeps agreed unfinished work in four labeled colors: 等时间, 等条件, 待补充要求, and 稍后继续. The original thread's `$session-atlas-handoff` skill reads and updates the same card as work progresses; ordinary completed sessions create no pending card. Due items move to the top of the board without notifications or automatic execution. Saved cards move between `待恢复`, `已打开`, and `位置待核对` as their actual location changes; opening a card does not remove it, and completing pending work keeps its bookmark. Reference-only cards can be viewed and closed again without rewriting their saved topic and reason.
- A successfully registered card marks its verified live original iTerm pane with a purple Tab and an `Atlas · 已保留` subtitle, and opening a saved card through Atlas applies the same marker, preserving any existing subtitle and leaving the main title unchanged. Both follow the selected split; uncertain or duplicate identities stay unmarked. Saved cards that could not be marked during registration are retried when a later inventory uniquely verifies the original thread, including after a service restart. A shared Codex daemon may hold the rollout instead of the terminal process; without a verifiable terminal-to-thread mapping, the card remains saved but the Tab stays unmarked. Clearing the saved purpose restores still-owned profile fields. Use the Atlas close action for its existing checks; ordinary window closes do not save or update cards.
- `可能有用` bookmarks threads worth referring to later with only a topic and reason, independently of pending-work counts. Bookmarks and pending items can coexist; removing either preserves the other.
- Bookmarks also try to add `🔖 ` to an existing name of the exact thread in the local Codex daemon. Codex updates its own terminal title, so this can work without a verified pane mapping. This changes the Codex thread name too, including its resume-list name; a custom terminal-title setting that omits the thread name will not show it. Removing the bookmark restores only a still-owned name. Missing daemon/name or a failed rename does not affect the saved card. Saving or opening the card retries the name marker; existing bookmarks are not renamed in bulk on startup.
- **⌃⌥⌘B** saves the existing handoff or bookmark and closes the current exact iTerm pane, retaining this Mac's existing 5-second close-undo period. If no handoff is registered, it opens the pending-work panel; missing identity, save failures, or still-running work keep the pane open. `继续原线程` focuses an existing thread or restores a closed one in a new tab in its original window (a new window when necessary). See [unfinished-work handoff](docs/session-continuation.md) for the trial registration behavior and time rules.
- `最近关闭` keeps exact thread identity, working directory, and first/latest user-request previews. Its primary open action checks for an existing instance before restoring. Continuation and recovery cards show the existing window/tab/pane; multiple live locations offer explicit focus choices. A copyable resume command remains available as a manual fallback.
- `窗口布局` lists closed iTerm windows with their recorded tabs and split panes; `恢复窗口布局` recreates one as new windows/tabs/panes. Codex panes resume by exact ID, while other panes reopen as shells in their recorded cwd. Restore requests are serialized per recorded window. If iTerm reports that only part of a window may have been created, the layout is marked uncertain and the restore button stays disabled so it cannot silently duplicate resumed Codex sessions.
- The backend retains ordinary closed Codex recoveries for 30 days (up to 200) and closed iTerm window layouts for 30 days (up to 100). Cards with pending handoff items or bookmarks and their required recovery information remain until the items are completed or cancelled and the bookmark is removed.
- The installed LaunchAgent enables automatic recovery for uniquely linked, visible Codex panes. Session Atlas changes only that pane's session-local future-start profile; iTerm remains responsible for restoring its own windows, tabs, and splits. On the next iTerm/macOS restoration the profile runs `scripts/session-atlas-resume.zsh`, which resumes the exact Codex ID in its recorded cwd. If an iTerm split inherits that profile while the original Codex thread is still open, the helper clears the duplicate profile and leaves the new pane as a shell instead of starting a second writer. A normal Codex exit (including `/quit`) is not restarted, Ctrl-C/SIGTERM is not restarted, and other startup failures stop after three attempts. When an armed pane returns to a normal shell, Session Atlas clears its own future-start command so an intentionally closed Codex thread is not resurrected later. Unrelated custom commands are never replaced.
- `J` / `K` or the arrow keys move through the board without taking over a text field.
- `Enter` focuses the current safe primary action; destructive approval choices never become that shortcut target.
- `F` focuses iTerm only when the selected legacy session reports that capability.
- `⌘K` searches and `⌘N` creates a dashboard-owned Codex thread.

On mobile, the board scrolls horizontally. Selecting a cell opens a full-width workbench with a back button that returns to the board.

## macOS installation

After the checks pass:

```bash
npm run install:macos
```

The installer builds the app, creates a user LaunchAgent with automatic recovery enabled, links the iTerm2 companion into the current user's AutoLaunch directory, and links the repository-owned handoff skill into `~/.codex/skills/session-atlas-handoff`. It installs the **⌃⌥⌘B** handoff shortcut only when that key is free or already belongs to Session Atlas. The companion may update only its own session-local future-start command for an exactly linked Codex pane; it uses native close only for an explicit handoff-and-close and creates new sessions only for an explicit restore. The installer refuses to replace unrelated files, key bindings, or custom commands. If an owned companion is already running, it verifies the exact wrapper, Python runtime, child process, and source link before reloading only that companion; installation never restarts iTerm2, sends terminal input, or closes a terminal session. It does not enable the iTerm2 Python API automatically.

Allowed project directories default to `~/Code`. To use another directory, pass `SESSION_ATLAS_PROJECT_ROOT` when installing; for multiple directories, pass a colon-separated `SESSION_ATLAS_PROJECT_ROOTS`. The installer records the selected value in its own LaunchAgent.

```bash
SESSION_ATLAS_PROJECT_ROOT="$HOME/Projects" npm run install:macos
```

If iTerm2 is already running, the installer asks iTerm2 to launch the refreshed companion through its bundled `it2run` entry point. If iTerm2 is not running, the installer does not open it; the companion starts from AutoLaunch on the next iTerm2 launch. If the Python API is disabled, enable it in iTerm2 and then run `Scripts > AutoLaunch > session_atlas.py` once.

Uninstall the service and link with:

```bash
npm run uninstall:macos
```

The uninstall command preserves `~/Library/Application Support/SessionAtlas/state.json` and `recovery.json` so attention choices and bounded recovery history remain available.

## Runtime layout

```text
Browser (same-origin REST + SSE)
        |
        v
Session Atlas controller -- stdio JSONL --> codex app-server
        |
        +-- 0600 Unix socket --> iTerm2 AutoLaunch companion
```

The browser never connects to Codex or iTerm2 directly. Legacy terminal matching is fail-closed: if a Codex transcript cannot be tied to exactly one iTerm2 session, the dashboard shows `未关联` and keeps only the safe focus action.

The current interface structure, tokens, and responsive rules are documented in [`docs/design/design-system.md`](docs/design/design-system.md). The screenshots in `docs/screenshots/` use anonymous demonstration data.
The evaluated open-source landscape is in [`docs/open-source-evaluation.md`](docs/open-source-evaluation.md), and the explicit v1/future compatibility boundary is in [`docs/compatibility-and-distribution.md`](docs/compatibility-and-distribution.md).
Open runtime problems and their incident evidence are tracked in [`docs/known-issues.md`](docs/known-issues.md).

## License and community

Session Atlas is available under the [MIT License](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md) for project provenance.

Community: [LINUX DO](https://linux.do/) — a developer community we support.
