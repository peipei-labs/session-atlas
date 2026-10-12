# Session Atlas board design system

The current interface is a three-column workbench: a lane rail, a honeycomb status board, and a persistent inbox rail with an on-demand workbench drawer, implemented in `src/client/`. This document is the visual source of truth; the public screenshots in `docs/screenshots/` show the current frontend with anonymous demonstration data.

## Product idea

The screen answers five concrete questions without making the user reconstruct context:

1. Which sessions need a response, which are running, and which can be resumed?
2. Where is each session physically (iTerm window/tab/pane, TTY)?
3. Which iTerm session am I physically in?
4. What is the selected session doing, and what can I do now?
5. Which sessions are buried, recently closed, or restorable as whole window layouts?

The interaction path is `honeycomb board → hover tooltip for details → click a cell to open the workbench drawer → exact action or iTerm focus → next item`. Selection stays stable during background updates; the advance queue moves to the next item only after the current one is handled.

## Composition

### Desktop, 1280px and wider

- 56px header: orbit mark, wordmark, search (`⌘K`), connection pill, appearance menu, and the `新建` action (enabled only when Codex is online). The empty middle hosts a quiet theme motif strip (`.header-deco`): per-theme generated bitmaps (深空 stars, 日间 sun rays, 翠绿 leaves, 樱花 petals) tiled horizontally at low opacity with both edges masked to fade; it is pointer-transparent, `aria-hidden`, and hidden on mobile.
- `.atlas-main` is a three-column grid (`232px / 1fr / 336px`) that fills the window; each column scrolls independently and the window itself never scrolls.
- Lane rail (left): the amber `你在这里` focus chip for the bridge-reported iTerm session (locator + title + `查看`), then the lane navigation — four toggle buttons （等待你 / 后台推进 / 可随时返回 / 稍后） with per-lane counts. Clicking a lane dims every board cell outside that lane (`.is-lane-dimmed`); clicking the active lane again clears the filter. The attention queue follows as a vertical list of compact tone-colored chips (icon, title, status, locator — click opens the workbench). The tag filter and the 已收起 shelf occupy the rail below the queue.
- Board column (center): a slim toolbar (36px) holds the 按项目/按窗口 grouping switch and, while a lane filter is active, a removable `筛选：等待你 ×` chip. The honeycomb board fills the rest. Sessions cluster by project (or by iTerm window); each cluster carries the urgency color of its most urgent member. Every cell is a status-toned hexagon with the attention icon, `窗口·标签` locator, and short title.
- Memory is attached to the existing cells: a compact line below each title shows physical footprint, with partial or offline-old markers; only the top three complete live values are bold. The board toolbar holds `显示内存`, refresh, timestamp and metric help. One sample runs when online sessions first arrive, then refresh is manual. Hover cards show RSS, process count and sampling time; the workbench has a collapsed process table below primary actions. Memory never changes cell colors or session order and is not persisted.
- Hovering or keyboard-focusing a cell opens a tooltip card with the details: title, project, current activity, last-active time, status, plan fraction, branch, TTY, and a `跳回 iTerm` quick action (gated on `capabilities.focus`, disabled while stale or a focus request is in flight). Its measured size determines its position inside the visible board area; short viewports allow the card to scroll internally. Board scrolling or resizing dismisses the tooltip so it cannot retain a stale position.
- Clicking a cell opens the workbench as a right-side drawer (max 560px) over a dimmed scrim: selected session identity (locator block, title, project/cwd/branch/TTY strip), then action-first ordering — pending request panel or message composer before the plan route, execution record, and activity history.
- Inbox rail (right), persistent and stacked: the 待续 section (grows to fill, scrolls) shows the global continuation inbox; below it a 最近关闭 accordion (open by default) holds recovery records with previews; at the bottom two folds — 可能有用 and 窗口布局 — expand one at a time on demand. Counts sit on every section header.
- 40px dock footer: status legend, keyboard legend, `下一项`, and last-updated time. (The former floating dock panels and their footer toggles are gone; everything has a permanent home in the rails.)

### Laptop, 901–1279px

- The grid narrows to `200px / 1fr / 300px`; the board tightens its padding and gaps; the status legend hides; plan and activity stack into one column inside the drawer.

### Mobile, 900px and narrower

- The main area becomes a single column (board only, scrolling horizontally with smaller cells); the header keeps search, a dot-only connection pill, icon actions, and two rail toggles (lanes left, inbox right).
- Each rail opens as a fixed overlay panel (`top: 52px; bottom: 40px`) over a scrim; scrim taps and `Escape` close it. Selecting a session from a rail closes the rail and opens the workbench.
- Tapping a cell opens the workbench as a full-width drawer with a `返回列表` button (desktop shows `关闭`); `Escape`, the scrim, and the back button all close it and return focus to the selected cell.
- The keyboard legend and grouping switch hide; touch targets stay at least 30px tall in rows and 44px for primary actions.

## Attention model

The four lanes are derived only from real session fields (`deriveContinuityLane` in `src/client/attention-model.ts`) and appear as cluster urgency colors, lane-nav buttons, and legend dots:

- `等待你`: attention reason, awaiting approval/input, or failed.
- `后台推进`: running without a user-attention reason.
- `可随时返回`: idle/unknown sessions that remain available.
- `稍后`: parked, buried, stale, or offline sessions.

Lane clicks only dim board cells; the keyboard navigation queue, selection, and lane counts are unaffected.

There is no fabricated percentage, ETA, productivity score, dependency, terminal transcript, or automatic archive summary. Plan fractions (`done / total`) render only when the provider reports a plan; when it does not, the workbench says so explicitly.

The continuation inbox (`ContinuationInbox` + `continuationInboxEntries` in `continuation-model.ts`) flattens every pending handoff item across every saved thread into one stream, grouped `该核验了` (due) / `即将到期` (timed, future) / `稍后` (no due time). Each row shows the kind chip, item title, parent thread and its location status, and the due label; rows expand in place for the full time block, condition, next action, and open-resume actions. Per-item completion writes the handoff with only that item marked done; bookmarks are untouched. `打开线程卡片` switches the rail section to the per-thread card (the scoped `ContinuationShelf`) for full editing, registration, and close actions; `返回待续列表` (or `Escape`) returns to the stream. The `⌃⌥⌘B` shortcut target forces the same scoped mode with the full record list so registration can pick a thread. Pending items use labeled blue time, purple condition, orange input, and muted later chips. A due date is derived only from recorded evidence and displayed in Asia/Shanghai; unanchored time items say `时间待确认`. Completion and terminal lifetime remain separate. The 可能有用 fold lists explicit bookmarks with teal labels, a topic and a reason, and no due date or task completion action; its cards can jump to the thread's 待续 card via 登记待续. Both forms can coexist on a thread; removing either preserves the other. Section badges count pending items (待续), closed records (最近关闭), bookmarks (可能有用), and closed layouts (窗口布局).

## Cell identity

- Hexagon rim: status tone (attention / running / returnable / muted); the running tone pulses softly.
- Icon: the current attention reason or activity state.
- Label: `窗口·标签` locator (with `/P3` on split tabs, or a compact conversation id) plus the cleaned title. Tooltips and return actions spell out the full window, tab, and pane location.
- A compact saved-thread label shows unregistered, pending-item count, bookmark, or ended/completed handoff state, based only on the matching original-thread record. Unknown associations say `待核对`; plain shells have no registration label. The workbench repeats the label. The attention-only parked toggle is named `稍后再看`.
- The bridge-reported focused iTerm session carries an amber dot and glow; selection (`is-selected`) and physical focus stay visually separate.

## Visual language

Thread tags use compact neutral chips, separate from attention and handoff status colors. The board shows a bounded preview; the workbench and continuation/recovery cards expose incremental add/remove editing. A tag filter below the header combines selections with AND and shows counts of distinct original threads, not panes. Tags also participate in text search. A tag alone never creates a handoff or bookmark, and tag filter contents are held only in React memory.

- Modern, quiet, dark-first: layered surfaces (`--bg-0` → `--bg-3`), 1px `--line` borders, 8–10px radii, soft shadows only for overlays, tooltips, dock panels, and the drawer.
- Status color appears as hexagon rims, small dots, and tinted soft surfaces — never as large solid fills.
- Monospace is reserved for metadata: locators, TTY, times, commands, plan fractions.
- Typography: system stack with PingFang SC, base 13px.
- Motion: 120–160ms ease-out transitions on selection, hover, and dock toggles; `prefers-reduced-motion` disables animation.

## Themes

Four palettes in two families share one variable set via `data-theme` on the root element; component CSS never branches per theme:

- `dark` 深空 (default): deep blue-charcoal, `#0f131a` base, `#7ea0f8` accent, restrained `#e2a94f` amber for attention.
- `light` 日间: cool daylight surfaces, `#e8ecf2` base, `#3a5ed8` accent, `#a56d10` amber for attention.
- `emerald` 翠绿: deep ink-green, `#0a1410` base, `#3ddc97` emerald accent, same amber attention.
- `sakura` 樱花: soft rose daylight, `#f4edef` base, `#b34677` rose accent, same amber attention.

Each theme also names its header motif via `--header-deco-image` (and an optional `--header-deco-size`), so the decoration swaps with the palette without component-level theme branches. The motifs are generated transparent PNGs in `public/header-deco/`; regenerate them with the local imagegen flow rather than editing by hand.

Each theme defines: `--bg-0..3`, `--line`, `--line-strong`, `--text-1..3`, `--accent(-soft/-line)`, `--attention(-soft/-line)`, `--running`, `--returnable`, `--later`, `--danger(-soft/-line)`, `--success`, `--scrim`, `--shadow-soft/strong`, and `color-scheme`.

Appearance persists to `localStorage["session-atlas.appearance.v2"]` (`{"theme": "…", "shape": "…"}`). The pre-paint bootstrap (`public/appearance-bootstrap.js`) reads v2 first and falls back to the v1 entry, so an upgraded install never flashes the wrong theme. `readAppearance()` performs the same migration and deletes the v1 key. Retired themes resolve through `RETIRED_THEME_MAP` in `appearance.ts` (`midnight → dark`, `sand → light`): the bootstrap normalizes them at paint time (read-only), and `readAppearance()` rewrites the stored value so the next launch reads the new name directly.

The board's cell shape is a second, independent appearance dimension: `shape` (`hex` 蜂巢, default; `dot` 圆点) lives in the same v2 entry and is applied as `data-shape` on the root element by both the bootstrap and `applyAppearance()`. Dot cells swap the clip-path hexagons for bordered circles and drop the row stagger; every status tone, rim, and the focus glow carry over unchanged. v1 entries that predate the shape removal keep their `shape` through migration.

The board grouping preference stores only `project` or `window` at `localStorage["session-atlas.board-grouping.v1"]`. Window mode uses actual window/tab/pane order so background activity and focus changes do not move cells; project mode retains attention ordering.

## Component families

- `Header`: brand, search, connection pill, appearance menu, create action; mobile-only rail toggles.
- `LaneRail`: focus chip + lane navigation (lane filter toggles with counts) + vertical attention queue (from `buildAttentionQueue`).
- `HoneycombBoard`: project/window clusters of hexagon cells; each cell hosts the hover tooltip with session details and the focus-in-iTerm quick action (gated on `capabilities.focus` and not stale). Accepts `laneFilter` and dims non-matching cells.
- `InboxRail`: the stacked right rail — 待续 section (global inbox or scoped thread card), 最近关闭 accordion, and 可能有用/窗口布局 folds.
- `ContinuationInbox`: the flattened pending-item stream with grouping, per-item completion, and in-place expansion.
- `ContinuationShelf`: the per-thread card/editor host, reused inside the rail (scoped thread card and controlled 可能有用 fold via `view`/`hideTabs`/`hideHeading`).
- `SessionShelf`, `RecoveryShelf`, `WindowLayoutSection`: rail-section bodies for buried sessions (lane rail), closed-session recovery (first/latest request previews + checked open action + copyable fallback resume command + one-click restore for restart placeholders), and closed window layouts (tab/pane inventory + restore, partial restores shown disabled with the server's message). `SessionShelf` rows reuse `SessionRow`.
- `Workbench`: action-first selected-session drawer — `RequestPanel` (approval/question) and `MessageComposer` before `ExecutionRoute` (plan + observed execution) and `ActivityList`.
- `CreateThreadDialog`: modal form for a dashboard-owned Codex thread.

## Capability rules

- Legacy iTerm sessions expose exact focus when supported. The separate continuation actions require a saved pending handoff or an explicit bookmark; closing additionally verifies the exact idle pane and saves its recovery position.
- Only controller-owned managed Codex sessions expose send, steer, interrupt, approval, or answer actions.
- Stale/offline sessions stay read-only; their tooltip quick action is disabled and the workbench shows the stale notice.
- Continuation and recovery open actions return to a known existing location first. Multiple locations offer explicit focus choices; closed threads use the server-checked restore action, including ordinary recovery records without a handoff. A restore command remains a manual fallback inside recovery details.
- Only a safe enabled control may carry `data-primary-action=true`; destructive-only choices never become the keyboard primary action.
- Window-layout restore is enabled only for `closed` layouts without an uncertain (`partial`) or pending-observation state, and only while iTerm is online; the server enforces the same gates with 409/503.
