# Known Issues

## DEP-001: Development dependencies have known audit advisories

Status: Open, checked on 2026-10-12 (Asia/Shanghai).

With the current lockfile, `npm audit` reports four affected development packages: `@vitest/mocker` (moderate), `source-map-js` (high), `tinypool` (critical), and the parent `vitest` package (critical). `npm audit --omit=dev` reports zero known vulnerabilities in the runtime dependency graph at this check date. That audit result is not an application security guarantee.

The relevant upstream reports are [Vitest mock redirect file access](https://github.com/advisories/GHSA-82fw-gwwq-j7x9), [Tinypool constructor options](https://github.com/advisories/GHSA-5gmw-xhrv-c9v3), [Tinypool run options](https://github.com/advisories/GHSA-85c8-ppgw-ccpr), and [source-map-js indexed source maps](https://github.com/advisories/GHSA-68fv-2mgg-jv7q). Their prerequisites differ: exposed mocker plugins, prototype-polluted worker options, or malicious source-map input. This repository runs its own test fixtures with the Vitest CLI and does not add the standalone mocker plugin to the application Vite server; Tinypool is not an application runtime dependency.

The initial public-source preparation keeps the tested toolchain. Updating the test framework and its transitive dependencies remains a separate dependency change and must pass the repository checks before this issue is closed. Do not use an automatic major-version audit fix as evidence of a working upgrade.

## PERF-001: iTerm inventory refresh can cause sustained CPU use and battery drain

Status: Mitigated and re-enabled on 2026-08-28 (Asia/Shanghai). The event storm and continuous subprocess burst are fixed and the installed service is online. A comparable long-duration PowerLog energy run has not yet been repeated, so this incident remains open for that final measurement.

### User impact

On a MacBook Pro M5 Pro, Session Atlas and iTerm2 together accounted for most of the attributable process energy during an 82-minute battery session. The machine dropped from 80% to 34% battery, averaging 32.2 W and about 31.6 percentage points per hour.

| Coalition | Attributable process energy | CPU time during the window | Approximate average CPU |
| --- | ---: | ---: | ---: |
| `com.boring.session-atlas` | 37.4% | 4,205.5 s | 85.6% |
| `com.googlecode.iterm2` | 20.3% | 3,744.4 s | 76.2% |

The same window also contained a separate Bilibili capture workload that accounted for 27.4% of attributable process energy. It contributed to total battery drain but does not explain the Session Atlas controller's sustained CPU time or subprocess activity.

### Evidence and likely mechanism

- The iTerm companion treats layout, focus, and monitored session-variable changes as refresh signals. The send loop debounces a signal for only 150 ms before rebuilding the complete inventory; the 15-second value is a fallback timeout, not a minimum refresh interval.
- Each accepted inventory snapshot reaches `SessionAtlasController.#ingestItermSessions()` and runs `LegacyCodexObserver.observeAll()`.
- Each observer pass starts a full `ps` snapshot and then one `lsof` process per candidate Codex PID. There is no cache for an unchanged terminal/process mapping.
- During a live sample, the controller LaunchAgent's `forks` counter increased from 236 to 4,881 in approximately 18 seconds. Transient `ps` children were directly observed. This is consistent with an event-driven snapshot loop repeatedly invoking legacy process discovery.
- iTerm2 remained around 50-70% CPU while the issue was active. Repeated bridge RPC and full-inventory reads are a likely contributor, but the incident did not isolate iTerm2 with and without the bridge under otherwise identical workload.

Relevant code:

- `bridge/session_atlas_iterm.py`: `send_snapshot_loop()`, variable monitors, and `build_snapshot()`
- `src/server/controller.ts`: `#ingestItermSessions()` and `#scheduleItermIngest()`
- `src/server/legacy-codex-observer.ts`: `observeAll()` and its `ps`/`lsof` fan-out

### Temporary mitigation applied

- Stopped the verified Session Atlas iTerm wrapper and Python companion without closing iTerm2 or any terminal/Codex session.
- Booted out `com.boring.session-atlas`; the controller process stopped and `127.0.0.1:4317` no longer responded.
- Preserved the installed plist, AutoLaunch link, application state, and repository files.

### 2026-08-28 implementation and live verification

- The bridge now enforces a real two-second minimum between full snapshots and coalesces event bursts. A 15-second heartbeat remains for unchanged state.
- Legacy Codex matching shares one `ps` snapshot per batch, caches an exact linked terminal/process identity, and limits unresolved or ambiguous retries to once per 30 seconds. The LaunchAgent-safe command paths are `/bin/ps` and `/usr/sbin/lsof`; the latter also fixed automatic matching under the installed LaunchAgent's restricted `PATH`.
- Automated checks cover the event storm, cache reuse, bounded retry behavior, recovery persistence, controller close transitions, and the final client component. The full suite passed with 105 Vitest tests plus the Python bridge test.
- With the installed 19-session inventory, 8 terminal mappings were uniquely linked to 6 distinct Codex session IDs; the owner-only recovery store was created with mode `0600`. Ambiguous mappings remained unrecorded rather than being guessed.
- During a 10-minute live run, the controller LaunchAgent's `forks` counter increased from 124 to 411: 287 total, or about 28.7 per minute. The incident rate was about 15,483 per minute. Controller CPU was normally 0% with brief retry peaks; the bridge process sampled at 0%.
- A same-workload 60-second comparison measured iTerm2 at 41.1% average CPU with the verified bridge stopped and 41.3% with it running. The current iTerm2 CPU load was therefore not attributable to this bridge. No terminal was closed or given input during the comparison, and the bridge returned online afterward.
- The missing closure evidence is a comparable long-duration PowerLog energy run. Do not claim the battery incident fully resolved until that measurement is materially below the original baseline.

### Closure criteria

1. Burst events from iTerm are coalesced behind a real minimum refresh interval; a continuous variable-event stream cannot trigger unbounded full snapshots.
2. Legacy Codex matching does not rerun `ps` and per-PID `lsof` when the relevant session identity inputs are unchanged.
3. Automated tests cover an iTerm event storm and verify bounded snapshot and observer invocation counts.
4. A live test with an incident-scale layout shows no continuously rising subprocess burst and materially lower Session Atlas CPU. A comparable long-duration PowerLog energy run must also be materially below this incident baseline. The subprocess and CPU checks passed on 2026-08-28; the PowerLog check remains pending.

### 2026-08-30 follow-up verification

- Observation-only timestamp changes, Codex spinner-only title changes, and unchanged recovery/layout snapshots no longer advance the registry revision or produce SSE upserts. Project-path metadata lookup is also cached for unchanged working directories.
- In a 20-second installed-service sample with 22 sessions and three active window layouts, the stream sent one initial snapshot and zero session, recovery, layout, or health upserts. The registry revision did not change and `recovery.json` was not rewritten.
- The controller sampled at 0.0% CPU and the companion at 1.0% CPU during that short check. This strengthens the event-churn verification but does not replace the still-pending comparable long-duration PowerLog run.
