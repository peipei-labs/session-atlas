# Open-source evaluation

Snapshot date: 2026-08-20, Asia/Shanghai.

No stock project satisfies all four current constraints: keep ordinary iTerm2 sessions, aggregate Codex state, focus the exact pane, and safely send only to sessions owned by the dashboard.

| Project | Existing ordinary iTerm2 sessions | Dashboard and actions | Fit for this v1 |
| --- | --- | --- | --- |
| [ccmux](https://github.com/epilande/ccmux) | Only sessions already inside tmux | Strong working/waiting state, pane switch and fail-closed send | Best control/state reference, but tmux is a hard requirement |
| [AgentPulse](https://github.com/jstuart0/agentpulse) | Hooks can observe sessions; ordinary panes are not precisely controllable | React grid, timeline, launch/prompt/stop for supervised sessions | Closest Web dashboard concept; small project and a different supervisor model |
| [AI Agent Session Center](https://github.com/coding-by-feng/ai-agent-session-center) | Hook discovery with an explicit display-only fallback for iTerm2 | Web/Electron dashboard; controls sessions it creates | Useful event/UI reference; ordinary iTerm matching remains heuristic |
| [Agent of Empires](https://github.com/agent-of-empires/agent-of-empires) | No; sessions move into its tmux workflow | Mature TUI/Web terminal, attach/input/diff | Strong alternative if migrating workflow is acceptable, not a transparent overlay |
| [Agent Deck](https://github.com/asheshgoplani/agent-deck) | Primarily manages its own tmux sessions | TUI/Web, attach/send, grouping and orchestration | Broad feature set, but heavier and tmux-oriented |
| [cmux](https://github.com/manaflow-ai/cmux) | No; it replaces iTerm2 | Native macOS terminal with agent notifications and workspace jumping | Compelling replacement terminal, not compatible with the keep-iTerm2 constraint |
| [AgentHUD](https://github.com/neochoon/agenthud) | Yes, by reading local agent histories | Read-only TUI/NDJSON status aggregation | Useful parser/report substrate; no focus or message control |
| [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) | No; it creates worktrees/workspaces | Task Kanban, logs, diff and review | Useful task model reference; upstream entered sunset/export-only mode |

[Cogpit](https://github.com/gentritbiba/cogpit) is closest to the Codex App Server control model, but its default surface also includes file editing, broad execution features and orphan-process cleanup. Session Atlas does not run it against live sessions and does not reuse that lifecycle code.

The implementation decision is therefore a small local controller: use the Codex App Server only for threads created by this controller, and use the official iTerm2 Python API only for inventory and exact focus. Ordinary terminal sessions deliberately remain display/focus-only. The UI reports observed state, plan steps and attention reasons instead of inventing a percentage.

The initial implementation is original code. `THIRD_PARTY_NOTICES.md` must be updated with exact files, commits and licenses before any future source-level reuse.
