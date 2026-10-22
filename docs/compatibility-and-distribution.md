# Compatibility and distribution boundary

This document separates the working v1 from possible later adapters. It is not a promise to implement every platform.

## Current v1

| Area | Current behavior |
| --- | --- |
| Host | One macOS user session; localhost Web UI and a per-user LaunchAgent |
| Terminal | iTerm2 3.6+ inventory, exact focus, session-local future-start recovery, and explicit thread/layout restoration through its Python API. An explicit continuation close saves the handoff, verifies the exact idle pane, and uses native close with Undo. Session Atlas never injects text, reads screens, directly kills processes, or replaces unrelated custom commands |
| Agent | Codex App Server passing automatic contract and handshake checks; write actions only for threads created by this running controller |
| Data directory | The default `~/.codex` directory. The installer rejects a nondefault `CODEX_HOME` before making changes; custom or multiple data directories are not supported |
| Existing sessions | Existing iTerm2/Codex sessions are visible and focusable; installed mode may set or clear its own future-start profile. The user may explicitly save and close an exactly linked idle pane from the continuation shelf or its native shortcut |
| Persistence | Attention and recovery metadata plus bounded handoff notes submitted by the original thread or user; pending handoffs outlive ordinary recovery retention. No raw transcript, terminal-content or arbitrary-command copy |

The controller, Web client and terminal companion are separate processes. The code already keeps agent operations behind `CodexProviderPort`, terminal operations behind `ItermBridgePort`, and UI actions behind per-session capabilities. A future adapter must preserve those fail-closed semantics rather than pretending every runtime supports every action.

### Automatic Codex compatibility

Every App Server start or reconnect resolves the executable and checks its version. There is no version allowlist. Atlas generates the installed CLI's experimental JSON Schema and compares the methods, parameters, responses, notifications and referenced types it uses against structural hashes from Codex 0.163.0. Only protocol hashes are stored in source; generated schemas stay in a temporary directory and are removed after detection.

Unrelated methods, documentation changes and new optional fields in ordinary protocol objects can pass automatically. Missing fields, changed types, required fields, enums and other structural changes require review. Approval and user-input structures are stricter: even new optional fields require review, because permissions must not silently expand. The comparator is deliberately conservative; a rejected structural change may be harmless and does not by itself prove that Codex is broken.

Successful checks are cached only in process memory, keyed by the resolved executable path, file identity/size/timestamps and CLI version. A replacement or new version triggers a fresh check on the next start/reconnect. Failures are not cached. Detection has subprocess timeouts, never edits the baseline, never sends a model request, and never restarts an active App Server to pick up an upgrade. It is not a periodic updater or a background code-repair agent.

Writes become available only after the contract check and the actual child's initialize handshake pass and the reported versions agree. A failed probe or incompatible contract leaves inventory reads available when the child can start, with the concrete reason exposed in health. Existing terminal sessions remain read-only, and managed-thread ownership checks remain required. A successful structural check cannot guarantee unchanged behavior inside Codex or successful model/authentication access.

`npm run protocol:check` uses the same client/checker with a temporary `CODEX_HOME`, verifies initialize and the empty loaded-thread inventory, and runs the existing lifecycle-hook check. It does not exercise model inference or live terminal controls.

When a used contract really changes, inspect the reported schema paths, adapt the affected calls, and validate against an isolated App Server before regenerating `src/server/codex/compatibility-baseline.ts` with `contractSignatures()` from the new CLI's `codex_app_server_protocol.schemas.json`. Update its provenance version and run `npm run protocol:check` and `npm run check`. Do not automatically replace the baseline just because a newer version exists.

## When another environment becomes a real requirement

- **Another Mac:** reuse the same localhost controller. Package the existing LaunchAgent only when a signed app or installer is actually requested.
- **Windows:** run a per-user controller in the interactive desktop session. Do not use a Windows Service for window focus because services run outside the user's interactive desktop. Terminal inventory/focus needs a Windows Terminal-specific adapter and must remain read-only until exact targeting is proven.
- **Linux:** use a `systemd --user` service for the controller. Terminal focus is adapter-specific and best-effort under Wayland; unsupported focus must appear as a missing capability, not a failing button.
- **Desktop shell:** wrap the same Web client only when native installation becomes a requirement. Tauri is the first candidate for a small wrapper. Electron plus `node-pty` is justified only if an embedded terminal becomes a core product feature.
- **Remote viewing:** requires an explicitly designed authenticated transport between per-machine controllers. The current loopback service must not be exposed directly.

## Other agents, including Claude Code

Add an agent adapter only after its current official interface can provide stable conversation identity, state and the exact actions shown in the UI. Inventory-only support should expose inventory capabilities only. In particular, an attach/logs workflow must not be presented as direct send/steer support.

The shared minimum is `provider`, `conversationId`, optional `runtimeId`, observed activity, pending attention and an explicit capability set. This lets a future Claude Code adapter coexist without weakening the current rule: only the runtime that demonstrably owns a session may write to it.
