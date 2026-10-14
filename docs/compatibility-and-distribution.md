# Compatibility and local installation

Session Atlas currently targets one macOS user running Codex in iTerm2. Check the Codex version before installing: the runtime write gate and the protocol-check script accept different version ranges. Neither range is a claim that every patch release has passed end-to-end testing.

## Required environment

| Component | Current requirement |
| --- | --- |
| Host | macOS, one local user session; Web UI bound to `127.0.0.1:4317` |
| Node.js | Node.js 22.12+ and npm, matching the locked Vite toolchain's Node 22 requirement |
| Terminal | iTerm2 3.6+ with its Python API enabled in Settings → General → Magic; the installer does not enable it automatically |
| Codex | Codex CLI on `PATH`, using the default `~/.codex` data directory; see the version table below |
| Python | `python3` on `PATH` for process-memory sampling; the iTerm2 companion uses iTerm2's Python API runtime |
| Installed mode | A per-user LaunchAgent, an iTerm2 AutoLaunch companion, and the repository-owned handoff skill; see [installation](../README.md#macos-installation) |

Custom or multiple `CODEX_HOME` directories are not supported. The installer rejects a nondefault directory before making changes. Windows, Linux, other terminal applications, remote access, and other agents such as Claude Code are not supported integrations in this release.

## Codex version checks

The effective runtime write range is defined in [`src/server/codex/client.ts`](../src/server/codex/client.ts). The schema probe has a separate allowlist in [`scripts/check-codex-protocol.ts`](../scripts/check-codex-protocol.ts).

| Codex CLI version | Runtime write gate | `npm run protocol:check` version gate |
| --- | --- | --- |
| 0.148.x–0.154.x | Accepted; writes also require a running, healthy App Server and an Atlas-owned thread | Accepted; generated protocol must still contain the required method names |
| 0.155.x or 0.157.x | Writes disabled | Accepted; generated protocol must still contain the required method names |
| Exactly 0.162.1, checked on 2026-10-14 | Accepted; writes also require a running, healthy App Server and an Atlas-owned thread | Accepted; schema and lifecycle checks passed |
| 0.156.x or any other version outside the entries above, including other 0.162 patches and prereleases | Writes disabled | Rejected before schema generation |

The probe generates experimental TypeScript schemas and checks the presence of 10 client request methods, 4 server request methods, and 7 notifications. These include paginated thread/turn/item reads, interaction methods, approval requests, and status events. A passing probe does not test payload compatibility, App Server startup, authentication, model access, live notifications, or terminal restoration. `npm run check` tests the repository and builds the app; it is also not a live Codex integration test.

For the 2026-10-14 check, Codex 0.162.1 passed `npm run protocol:check`: all 21 required methods were present, both Atlas session hooks were trusted, and existing hooks and developer instructions were preserved. A separate App Server check used a disposable `CODEX_HOME` and project directory: the real Atlas client completed initialization, read the inventory, created a thread, and read its metadata and loaded-thread list. No real user session or configuration was changed. The probe used a local dummy model provider and sent no model request.

The isolated check also exercised `CodexProvider` metadata validation and the workbench's bounded execution read for a newly created thread. Before its first user message, 0.162.1 reports that paginated history is not materialized; Atlas shows an empty execution record for that exact thread-specific response and still surfaces unrelated errors.

The allowlist adds only the verified `0.162.1` patch, not all `0.162.x` or future releases. Fixture tests cover turn start, steer, interrupt, and continued write rejection for unverified versions. Authentication, actual model turns, live approval/question delivery, and real terminal restoration were not validated by the isolated check. Reading a version number or finding a method in a schema is not evidence of a working end-to-end integration. [OpenAI's App Server documentation](https://learn.chatgpt.com/docs/app-server) explains that generated schemas correspond to the particular CLI version used to generate them.

Outside the runtime allowlist, Atlas disables Codex send, steer, interrupt, approval, and answer actions. Read-only inventory may also fail if App Server startup or response formats have changed; do not assume that an unsupported version can still display live Codex sessions. Health and write-error messages use the same runtime version label as the client.

## Check before installing

From the repository root, with dependencies installed:

```bash
codex --version
npm run protocol:check
npm run check
```

If the protocol check rejects your CLI version, the macOS installer will stop at the same check before creating its LaunchAgent or links. A successful check on 0.155.x or 0.157.x does not expand the runtime write range.

To inspect the interface without starting the controller or the iTerm2 companion, run the fixed demo fixture:

```bash
VITE_SESSION_ATLAS_DEMO=1 npx vite --host 127.0.0.1 --port 4318
```

Open <http://127.0.0.1:4318>. The board uses demonstration data; live memory readings and terminal operations are unavailable. This preview does not verify Codex compatibility.

## What can control a session

Existing iTerm2 panes remain input-read-only. Atlas can inventory and focus an exact pane, and installed mode can set or clear its own session-local future-start command for a uniquely linked Codex pane. It does not inject terminal text, read terminal screens, or replace unrelated custom commands. An explicit handoff-and-close saves the submitted handoff and recovery metadata, rechecks the exact pane and its idle state, then uses native iTerm2 close with its Undo period. Explicit restoration opens selected saved threads or layouts through iTerm2.

Browser send, steer, interrupt, approval, and answer actions require a thread owned by this running Atlas App Server client, an accepted runtime version, and a healthy protocol. A session's presence on the board or a successful focus action does not grant these capabilities.

Atlas stores attention choices, recovery/layout metadata, and bounded handoff notes submitted by the original thread or user. Pending handoffs outlive ordinary recovery retention. It does not copy raw transcripts, terminal contents, or arbitrary command output into its state files. Closing a pane or ending a model turn does not mark unfinished work complete.
