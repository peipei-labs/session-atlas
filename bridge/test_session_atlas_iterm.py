import asyncio
import importlib.util
import pathlib
import sys
import types
import unittest
from unittest.mock import AsyncMock, patch


sys.modules.setdefault("iterm2", types.ModuleType("iterm2"))
MODULE_PATH = pathlib.Path(__file__).with_name("session_atlas_iterm.py")
SPEC = importlib.util.spec_from_file_location("session_atlas_iterm", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
BRIDGE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BRIDGE)


class BridgeSnapshotSchedulingTests(unittest.IsolatedAsyncioTestCase):
    def test_spinner_only_title_changes_have_one_stable_monitor_value(self):
        self.assertEqual(
            BRIDGE.stable_monitored_value("name", "⠋ Project (codex)"),
            BRIDGE.stable_monitored_value("name", "⠙ Project (codex)"),
        )

    async def test_event_storm_respects_minimum_snapshot_interval(self):
        changed = asyncio.Event()
        changed.set()
        client = BRIDGE.BridgeClient(
            object(),
            "/tmp/unused-session-atlas.sock",
            changed,
            snapshot_heartbeat_seconds=0.3,
            snapshot_min_interval_seconds=0.05,
        )
        snapshot_times = []

        async def fake_snapshot(_app):
            snapshot_times.append(asyncio.get_running_loop().time())
            return {"type": "snapshot"}

        async def fake_send(_payload):
            return None

        original_snapshot = BRIDGE.build_snapshot
        BRIDGE.build_snapshot = fake_snapshot
        client.send = fake_send
        task = asyncio.create_task(client.send_snapshot_loop())

        async def event_storm():
            loop = asyncio.get_running_loop()
            finish_at = loop.time() + 0.18
            while loop.time() < finish_at:
                changed.set()
                await asyncio.sleep(0.001)

        try:
            await event_storm()
            await asyncio.sleep(0.06)
        finally:
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            BRIDGE.build_snapshot = original_snapshot

        self.assertGreaterEqual(len(snapshot_times), 2)
        self.assertLessEqual(len(snapshot_times), 6)
        intervals = [
            later - earlier
            for earlier, later in zip(snapshot_times, snapshot_times[1:])
        ]
        self.assertTrue(all(interval >= 0.045 for interval in intervals), intervals)


class FocusHandlingTests(unittest.IsolatedAsyncioTestCase):
    async def test_focuses_exact_session_and_activates_iterm(self):
        events = []

        class Session:
            session_id = "target-session"

            async def async_activate(self, **kwargs):
                events.append(("session", kwargs))

        session = Session()
        tab = types.SimpleNamespace(
            tab_id="tab-1",
            sessions=[session],
            root=types.SimpleNamespace(vertical=False, children=[session]),
            current_session=session,
        )
        window = types.SimpleNamespace(
            window_id="window-1",
            tabs=[tab],
            current_tab=tab,
        )

        class App:
            terminal_windows = [window]
            current_terminal_window = window
            buried_sessions = []

            async def async_activate(self, **kwargs):
                events.append(("app", kwargs))

        messages = []
        client = BRIDGE.BridgeClient(App(), "/tmp/unused-session-atlas.sock", asyncio.Event())

        async def fake_send(payload):
            messages.append(payload)

        client.send = fake_send
        await client.handle_focus(
            {
                "requestId": "focus-1",
                "sessionId": "target-session",
                "expiresAt": BRIDGE.time.time() * 1000 + 10_000,
            }
        )

        self.assertEqual(
            events,
            [
                (
                    "app",
                    {"raise_all_windows": False, "ignoring_other_apps": True},
                ),
                ("session", {"select_tab": True, "order_window_front": True}),
            ],
        )
        self.assertEqual(messages[-1]["type"], "focus-result")
        self.assertTrue(messages[-1]["ok"])

    async def test_focus_times_out_instead_of_blocking_the_bridge(self):
        class Session:
            session_id = "target-session"

            async def async_activate(self, **_kwargs):
                await asyncio.Event().wait()

        session = Session()
        tab = types.SimpleNamespace(
            tab_id="tab-1",
            sessions=[session],
            root=types.SimpleNamespace(vertical=False, children=[session]),
            current_session=session,
        )
        window = types.SimpleNamespace(
            window_id="window-1",
            tabs=[tab],
            current_tab=tab,
        )

        class App:
            terminal_windows = [window]
            current_terminal_window = window
            buried_sessions = []

            async def async_activate(self, **_kwargs):
                return None

        messages = []
        client = BRIDGE.BridgeClient(App(), "/tmp/unused-session-atlas.sock", asyncio.Event())

        async def fake_send(payload):
            messages.append(payload)

        client.send = fake_send
        original_timeout = BRIDGE.FOCUS_REQUEST_TIMEOUT_SECONDS
        BRIDGE.FOCUS_REQUEST_TIMEOUT_SECONDS = 0.01
        try:
            await client.handle_focus(
                {
                    "requestId": "focus-timeout",
                    "sessionId": "target-session",
                    "expiresAt": BRIDGE.time.time() * 1000 + 10_000,
                }
            )
        finally:
            BRIDGE.FOCUS_REQUEST_TIMEOUT_SECONDS = original_timeout

        self.assertEqual(messages[-1]["type"], "focus-result")
        self.assertFalse(messages[-1]["ok"])
        self.assertIn("Timed out", messages[-1]["error"])

    async def test_rejects_expired_focus_before_activating_iterm(self):
        events = []

        class Session:
            session_id = "target-session"

            async def async_activate(self, **_kwargs):
                events.append("session")

        session = Session()
        tab = types.SimpleNamespace(
            tab_id="tab-1",
            sessions=[session],
            root=types.SimpleNamespace(vertical=False, children=[session]),
            current_session=session,
        )
        window = types.SimpleNamespace(
            window_id="window-1", tabs=[tab], current_tab=tab
        )

        class App:
            terminal_windows = [window]
            current_terminal_window = window
            buried_sessions = []

            async def async_activate(self, **_kwargs):
                events.append("app")

        messages = []
        client = BRIDGE.BridgeClient(
            App(), "/tmp/unused-session-atlas.sock", asyncio.Event()
        )

        async def fake_send(payload):
            messages.append(payload)

        client.send = fake_send
        await client.handle_focus(
            {
                "requestId": "expired-focus",
                "sessionId": "target-session",
                "expiresAt": BRIDGE.time.time() * 1000 - 1,
            }
        )

        self.assertEqual(events, [])
        self.assertFalse(messages[-1]["ok"])
        self.assertIn("expired", messages[-1]["error"])

    async def test_cancels_focus_that_cannot_finish_before_expiry(self):
        events = []

        class Session:
            session_id = "target-session"

            async def async_activate(self, **_kwargs):
                events.append("session")

        session = Session()
        tab = types.SimpleNamespace(
            tab_id="tab-1",
            sessions=[session],
            root=types.SimpleNamespace(vertical=False, children=[session]),
            current_session=session,
        )
        window = types.SimpleNamespace(
            window_id="window-1", tabs=[tab], current_tab=tab
        )

        class App:
            terminal_windows = [window]
            current_terminal_window = window
            buried_sessions = []

            async def async_activate(self, **_kwargs):
                events.append("app-started")
                await asyncio.sleep(0.06)
                events.append("app-finished")

        messages = []
        client = BRIDGE.BridgeClient(
            App(), "/tmp/unused-session-atlas.sock", asyncio.Event()
        )

        async def fake_send(payload):
            messages.append(payload)

        client.send = fake_send
        await client.handle_focus(
            {
                "requestId": "nearly-expired-focus",
                "sessionId": "target-session",
                "expiresAt": BRIDGE.time.time() * 1000 + 80,
            }
        )

        self.assertEqual(events, ["app-started"])
        self.assertFalse(messages[-1]["ok"])
        self.assertIn("Timed out", messages[-1]["error"])


class VariableMonitorHandlingTests(unittest.IsolatedAsyncioTestCase):
    async def test_one_variable_failure_cancels_its_sibling_watchers(self):
        started = []
        cancelled = []

        async def fake_watch(_connection, _session_id, variable_name, _changed):
            started.append(variable_name)
            while len(started) < len(BRIDGE.MONITORED_VARIABLES):
                await asyncio.sleep(0)
            if variable_name == BRIDGE.MONITORED_VARIABLES[0]:
                raise RuntimeError("watch failed")
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.append(variable_name)

        original_watch = BRIDGE.watch_one_variable
        BRIDGE.watch_one_variable = fake_watch
        try:
            with self.assertRaisesRegex(RuntimeError, "watch failed"):
                await BRIDGE.watch_session_variables(
                    object(), "session-1", asyncio.Event()
                )
        finally:
            BRIDGE.watch_one_variable = original_watch

        self.assertCountEqual(
            cancelled, BRIDGE.MONITORED_VARIABLES[1:]
        )

    async def test_propagates_variable_failure_and_cleans_owned_monitors(self):
        exited = []

        class CreationMonitor:
            delivered = False

            def __init__(self, _app):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                exited.append("creation")

            async def async_get(self):
                if not self.delivered:
                    self.delivered = True
                    return "session-1"
                await asyncio.Event().wait()

        class TerminationMonitor:
            def __init__(self, _connection):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                exited.append("termination")

            async def async_get(self):
                await asyncio.Event().wait()

        async def failing_watch(_connection, _session_id, _changed):
            await asyncio.sleep(0)
            raise RuntimeError("subscription failed")

        original_creation = getattr(BRIDGE.iterm2, "EachSessionOnceMonitor", None)
        original_termination = getattr(BRIDGE.iterm2, "SessionTerminationMonitor", None)
        original_watch = BRIDGE.watch_session_variables
        BRIDGE.iterm2.EachSessionOnceMonitor = CreationMonitor
        BRIDGE.iterm2.SessionTerminationMonitor = TerminationMonitor
        BRIDGE.watch_session_variables = failing_watch
        try:
            with self.assertRaisesRegex(RuntimeError, "subscription failed"):
                await BRIDGE.variable_monitors(object(), object(), asyncio.Event())
        finally:
            BRIDGE.watch_session_variables = original_watch
            if original_creation is None:
                del BRIDGE.iterm2.EachSessionOnceMonitor
            else:
                BRIDGE.iterm2.EachSessionOnceMonitor = original_creation
            if original_termination is None:
                del BRIDGE.iterm2.SessionTerminationMonitor
            else:
                BRIDGE.iterm2.SessionTerminationMonitor = original_termination

        self.assertCountEqual(exited, ["creation", "termination"])


class MainLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_connection_close_cancels_owned_tasks(self):
        disconnected = asyncio.Event()
        cancelled = asyncio.Event()

        async def wait_closed():
            await disconnected.wait()

        async def owned_task():
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        connection = types.SimpleNamespace(
            websocket=types.SimpleNamespace(wait_closed=wait_closed)
        )
        task = asyncio.create_task(
            BRIDGE.supervise_main_tasks(connection, (owned_task(),))
        )
        await asyncio.sleep(0)
        disconnected.set()
        with self.assertRaisesRegex(ConnectionError, "connection closed"):
            await task
        self.assertTrue(cancelled.is_set())


class BridgeProcessHandlingTests(unittest.TestCase):
    def test_restarts_after_iterm_runtime_failure(self):
        calls = []
        sleeps = []

        def fake_run_once(main, *, retry):
            calls.append((main, retry))
            if len(calls) == 1:
                raise SystemExit(1)
            raise SystemExit(0)

        BRIDGE.run_bridge_forever(fake_run_once, sleeps.append)

        self.assertEqual(calls, [(BRIDGE.main, True), (BRIDGE.main, True)])
        self.assertEqual(sleeps, [BRIDGE.BRIDGE_RESTART_DELAY_SECONDS])


class LayoutRestoreTests(unittest.IsolatedAsyncioTestCase):
    def test_captures_nested_split_paths(self):
        class Session:
            def __init__(self, session_id):
                self.session_id = session_id

        class Splitter:
            def __init__(self, vertical, children):
                self.vertical = vertical
                self.children = children

        root = Splitter(
            True,
            [
                Splitter(False, [Session("a"), Session("b")]),
                Session("c"),
            ],
        )

        self.assertEqual(
            BRIDGE.split_paths(root),
            {
                "a": [
                    {"vertical": True, "index": 0},
                    {"vertical": False, "index": 0},
                ],
                "b": [
                    {"vertical": True, "index": 0},
                    {"vertical": False, "index": 1},
                ],
                "c": [{"vertical": True, "index": 1}],
            },
        )

    async def test_recreates_tabs_and_nested_splits_with_exact_codex_command(self):
        profiles = []
        sessions = []

        class FakeProfile:
            def __init__(self):
                self.values = {}
                profiles.append(self)

            def set_initial_directory_mode(self, value):
                self.values["directory_mode"] = value

            def set_custom_directory(self, value):
                self.values["cwd"] = value

            def set_name(self, value):
                self.values["name"] = value

            def set_use_custom_command(self, value):
                self.values["use_command"] = value

            def set_command(self, value):
                self.values["command"] = value

            def set_close_sessions_on_end(self, value):
                self.values["close_sessions_on_end"] = value

        class FakeSession:
            def __init__(self):
                self.splits = []
                self.variables = {}
                sessions.append(self)

            async def async_split_pane(self, **kwargs):
                created = FakeSession()
                self.splits.append((kwargs, created))
                return created

            async def async_set_variable(self, name, value):
                self.variables[name] = value

        class FakeTab:
            def __init__(self):
                self.current_session = FakeSession()

        class FakeWindow:
            def __init__(self):
                self.current_tab = FakeTab()
                self.tabs = [self.current_tab]

            async def async_create_tab(self, **_kwargs):
                tab = FakeTab()
                self.tabs.append(tab)
                return tab

        window = FakeWindow()

        class FakeWindowApi:
            @staticmethod
            async def async_create(*_args, **_kwargs):
                return window

        original = {
            "LocalWriteOnlyProfile": getattr(BRIDGE.iterm2, "LocalWriteOnlyProfile", None),
            "InitialWorkingDirectory": getattr(BRIDGE.iterm2, "InitialWorkingDirectory", None),
            "Window": getattr(BRIDGE.iterm2, "Window", None),
        }
        BRIDGE.iterm2.LocalWriteOnlyProfile = FakeProfile
        BRIDGE.iterm2.InitialWorkingDirectory = types.SimpleNamespace(
            INITIAL_WORKING_DIRECTORY_CUSTOM="custom"
        )
        BRIDGE.iterm2.Window = FakeWindowApi
        layout = {
            "status": "closed",
            "tabs": [
                {
                    "tabIndex": 1,
                    "panes": [
                        {
                            "title": "Codex",
                            "cwd": "/tmp/project",
                            "profileName": "Work",
                            "conversationId": "01234567-89ab-cdef-8123-456789abcdef",
                            "resumeCommand": "malicious command is ignored",
                            "splitPath": [
                                {"vertical": True, "index": 0},
                                {"vertical": False, "index": 0},
                            ],
                        },
                        {
                            "title": "Shell",
                            "cwd": "/tmp/project",
                            "splitPath": [
                                {"vertical": True, "index": 0},
                                {"vertical": False, "index": 1},
                            ],
                        },
                        {
                            "title": "Logs",
                            "cwd": "/tmp/logs",
                            "splitPath": [{"vertical": True, "index": 1}],
                        },
                    ],
                },
                {
                    "tabIndex": 2,
                    "panes": [
                        {
                            "title": "Second tab",
                            "cwd": "/tmp/second",
                            "splitPath": [{"vertical": False, "index": 0}],
                        }
                    ],
                },
            ],
        }
        try:
            await BRIDGE.restore_layout(object(), layout, 5432)
        finally:
            for name, value in original.items():
                if value is None:
                    delattr(BRIDGE.iterm2, name)
                else:
                    setattr(BRIDGE.iterm2, name, value)

        self.assertEqual(len(window.tabs), 2)
        self.assertEqual(sum(len(session.splits) for session in sessions), 2)
        commands = [profile.values.get("command") for profile in profiles]
        self.assertTrue(
            any(
                command is not None
                and "session-atlas-resume.zsh" in command
                and "--cwd /tmp/project" in command
                and "--session-id 01234567-89ab-cdef-8123-456789abcdef" in command
                and "--controller-port 5432" in command
                for command in commands
            ),
            commands,
        )
        self.assertNotIn("malicious command is ignored", commands)
        self.assertIn("No", [profile.values.get("use_command") for profile in profiles])
        self.assertIn(True, [profile.values.get("close_sessions_on_end") for profile in profiles])
        self.assertIn(
            "01234567-89ab-cdef-8123-456789abcdef",
            [session.variables.get(BRIDGE.AUTO_RESUME_VARIABLE) for session in sessions],
        )

    async def test_rejects_relative_restore_directories(self):
        with self.assertRaisesRegex(ValueError, "absolute path"):
            BRIDGE.validate_restore_layout(
                {
                    "status": "closed",
                    "tabs": [
                        {
                            "tabIndex": 1,
                            "panes": [
                                {
                                    "title": "Bad",
                                    "cwd": "relative/path",
                                    "splitPath": [{"vertical": True, "index": 0}],
                                }
                            ],
                        }
                    ],
                }
            )

    async def test_validates_every_split_tree_before_creating_a_window(self):
        create_calls = 0

        class FakeWindowApi:
            @staticmethod
            async def async_create(*_args, **_kwargs):
                nonlocal create_calls
                create_calls += 1
                return None

        original = getattr(BRIDGE.iterm2, "Window", None)
        BRIDGE.iterm2.Window = FakeWindowApi
        layout = {
            "status": "closed",
            "tabs": [
                {
                    "tabIndex": 1,
                    "panes": [
                        {
                            "title": "Valid",
                            "cwd": "/tmp/valid",
                            "splitPath": [{"vertical": True, "index": 0}],
                        }
                    ],
                },
                {
                    "tabIndex": 2,
                    "panes": [
                        {
                            "title": "Invalid gap",
                            "cwd": "/tmp/invalid",
                            "splitPath": [{"vertical": True, "index": 1}],
                        }
                    ],
                },
            ],
        }
        try:
            with self.assertRaisesRegex(ValueError, "contiguous"):
                await BRIDGE.restore_layout(object(), layout)
        finally:
            if original is None:
                delattr(BRIDGE.iterm2, "Window")
            else:
                BRIDGE.iterm2.Window = original

        self.assertEqual(create_calls, 0)

    async def test_marks_runtime_split_failure_as_partial_after_window_creation(self):
        class FakeProfile:
            def set_initial_directory_mode(self, _value):
                pass

            def set_custom_directory(self, _value):
                pass

            def set_name(self, _value):
                pass

            def set_use_custom_command(self, _value):
                pass

        class FailingSession:
            async def async_split_pane(self, **_kwargs):
                raise RuntimeError("split RPC failed")

        class FakeTab:
            current_session = FailingSession()

        class FakeWindow:
            window_id = "created-window"
            current_tab = FakeTab()

        class FakeWindowApi:
            @staticmethod
            async def async_create(*_args, **_kwargs):
                return FakeWindow()

        original = {
            "LocalWriteOnlyProfile": getattr(BRIDGE.iterm2, "LocalWriteOnlyProfile", None),
            "InitialWorkingDirectory": getattr(BRIDGE.iterm2, "InitialWorkingDirectory", None),
            "Window": getattr(BRIDGE.iterm2, "Window", None),
        }
        BRIDGE.iterm2.LocalWriteOnlyProfile = FakeProfile
        BRIDGE.iterm2.InitialWorkingDirectory = types.SimpleNamespace(
            INITIAL_WORKING_DIRECTORY_CUSTOM="custom"
        )
        BRIDGE.iterm2.Window = FakeWindowApi
        layout = {
            "status": "closed",
            "tabs": [
                {
                    "tabIndex": 1,
                    "panes": [
                        {
                            "title": "First",
                            "cwd": "/tmp/first",
                            "splitPath": [{"vertical": True, "index": 0}],
                        },
                        {
                            "title": "Second",
                            "cwd": "/tmp/second",
                            "splitPath": [{"vertical": True, "index": 1}],
                        },
                    ],
                }
            ],
        }
        try:
            with self.assertRaises(BRIDGE.PartialRestoreError) as raised:
                await BRIDGE.restore_layout(object(), layout)
        finally:
            for name, value in original.items():
                if value is None:
                    delattr(BRIDGE.iterm2, name)
                else:
                    setattr(BRIDGE.iterm2, name, value)

        self.assertEqual(raised.exception.created_window_id, "created-window")


class InPlaceRecoveryTests(unittest.IsolatedAsyncioTestCase):
    def target(self, session_id, conversation_id, cwd="/tmp/project"):
        return {
            "targetSessionId": session_id,
            "cwd": cwd,
            "conversationId": conversation_id,
            "title": "Project",
            "profileName": "Default",
            "splitVertical": True,
        }

    async def test_replaces_the_exact_placeholder_and_buries_the_shell(self):
        for expected_cwd in (None, "/tmp/shell"):
            with self.subTest(expected_cwd=expected_cwd):
                await self.assert_recovery_success(expected_cwd)

    async def assert_recovery_success(self, expected_cwd):
        class Restored:
            pass

        class Placeholder:
            session_id = "shell-one"

            def __init__(self):
                self.split_kwargs = None
                self.buried = False
                self.job_reads = 0

            async def async_get_variable(self, name):
                if name == "jobName":
                    self.job_reads += 1
                return {"path": expected_cwd or "/tmp/project", "jobName": "zsh"}.get(name)

            async def async_split_pane(self, **kwargs):
                self.split_kwargs = kwargs
                return Restored()

            async def async_set_buried(self, buried):
                self.buried = buried

        placeholder = Placeholder()
        marked = []

        async def mark(session, pane):
            marked.append((session, pane["conversationId"]))

        original_visible = BRIDGE.visible_sessions
        original_profile = BRIDGE.pane_profile
        original_mark = BRIDGE.mark_auto_resume_session
        BRIDGE.visible_sessions = lambda _app: [(placeholder,)]
        BRIDGE.pane_profile = lambda pane, _controller_port=4317: pane
        BRIDGE.mark_auto_resume_session = mark
        try:
            await BRIDGE.restore_recoveries_in_place(
                object(),
                [
                    self.target(
                        "shell-one", "01234567-89ab-cdef-8123-456789abcdef"
                    ) | ({"expectedPlaceholderCwd": expected_cwd} if expected_cwd else {})
                ],
            )
        finally:
            BRIDGE.visible_sessions = original_visible
            BRIDGE.pane_profile = original_profile
            BRIDGE.mark_auto_resume_session = original_mark

        self.assertTrue(placeholder.buried)
        self.assertEqual(placeholder.split_kwargs["vertical"], True)
        self.assertEqual(placeholder.split_kwargs["before"], True)
        self.assertEqual(
            placeholder.split_kwargs["profile_customizations"]["cwd"], "/tmp/project"
        )
        self.assertEqual(len(marked), 1)
        self.assertEqual(placeholder.job_reads, 3)

    def test_rejects_invalid_expected_placeholder_cwd(self):
        target = self.target("shell-one", "01234567-89ab-cdef-8123-456789abcdef")
        legacy_target = BRIDGE.validate_recovery_targets([target])[0]
        self.assertEqual(legacy_target["expectedPlaceholderCwd"], target["cwd"])
        for cwd in (None, 42, "", "relative", "/tmp/\x00shell"):
            with self.subTest(cwd=cwd), self.assertRaisesRegex(ValueError, "placeholder cwd"):
                BRIDGE.validate_recovery_targets([target | {"expectedPlaceholderCwd": cwd}])

    async def test_rechecks_placeholder_cwd_before_split_and_bury(self):
        target = self.target("shell-one", "01234567-89ab-cdef-8123-456789abcdef")
        target["expectedPlaceholderCwd"] = "/tmp/shell"
        for changed_at in (1, 2, 3):
            placeholder = types.SimpleNamespace(
                session_id="shell-one",
                async_split_pane=AsyncMock(return_value=object()),
                async_set_buried=AsyncMock(),
            )
            snapshots = [{"path": "/tmp/shell", "jobName": "zsh"}] * (changed_at - 1)
            snapshots.append({"path": "/tmp/changed", "jobName": "zsh"})
            error = BRIDGE.PartialRestoreError if changed_at == 3 else ValueError
            with self.subTest(changed_at=changed_at), patch.multiple(
                BRIDGE,
                visible_sessions=lambda _app: [(placeholder,)],
                read_variables=AsyncMock(side_effect=snapshots),
                pane_profile=lambda pane, _controller_port: pane,
                mark_auto_resume_session=AsyncMock(),
            ):
                with self.assertRaises(error) as raised:
                    await BRIDGE.restore_recoveries_in_place(object(), [target])
                cause = raised.exception.__cause__ or raised.exception
                self.assertEqual(str(cause), "Recovery target cwd changed")
                self.assertEqual(
                    placeholder.async_split_pane.await_count, int(changed_at == 3)
                )
                placeholder.async_set_buried.assert_not_awaited()

    async def test_preflights_every_placeholder_before_creating_a_pane(self):
        class Placeholder:
            def __init__(self, session_id, job_name):
                self.session_id = session_id
                self.job_name = job_name
                self.split_calls = 0

            async def async_get_variable(self, name):
                return {"path": "/tmp/project", "jobName": self.job_name}.get(name)

            async def async_split_pane(self, **_kwargs):
                self.split_calls += 1

        first = Placeholder("shell-one", "zsh")
        second = Placeholder("shell-two", "node")
        original_visible = BRIDGE.visible_sessions
        BRIDGE.visible_sessions = lambda _app: [(first,), (second,)]
        try:
            with self.assertRaisesRegex(ValueError, "idle shell"):
                await BRIDGE.restore_recoveries_in_place(
                    object(),
                    [
                        self.target(
                            "shell-one", "01234567-89ab-cdef-8123-456789abcdef"
                        ),
                        self.target(
                            "shell-two", "11234567-89ab-cdef-8123-456789abcdef"
                        ),
                    ],
                )
        finally:
            BRIDGE.visible_sessions = original_visible

        self.assertEqual(first.split_calls, 0)

    async def test_marks_a_split_failure_as_partial(self):
        class Placeholder:
            session_id = "shell-one"

            async def async_get_variable(self, name):
                return {"path": "/tmp/project", "jobName": "zsh"}.get(name)

            async def async_split_pane(self, **_kwargs):
                raise RuntimeError("split failed")

        placeholder = Placeholder()
        original_visible = BRIDGE.visible_sessions
        original_profile = BRIDGE.pane_profile
        BRIDGE.visible_sessions = lambda _app: [(placeholder,)]
        BRIDGE.pane_profile = lambda pane, _controller_port=4317: pane
        try:
            with self.assertRaises(BRIDGE.PartialRestoreError):
                await BRIDGE.restore_recoveries_in_place(
                    object(),
                    [
                        self.target(
                            "shell-one", "01234567-89ab-cdef-8123-456789abcdef"
                        )
                    ],
                )
        finally:
            BRIDGE.visible_sessions = original_visible
            BRIDGE.pane_profile = original_profile


class AutoResumeConfigurationTests(unittest.IsolatedAsyncioTestCase):
    def test_recognizes_only_exact_session_atlas_and_legacy_resume_commands(self):
        conversation_id = "01234567-89ab-cdef-8123-456789abcdef"
        helper_profile = types.SimpleNamespace(
            use_custom_command="Yes",
            command=BRIDGE.auto_resume_command("/tmp/project", conversation_id),
        )
        legacy_profile = types.SimpleNamespace(
            use_custom_command="Yes",
            command=f"codex resume -C /tmp/project {conversation_id}",
        )
        unrelated_profile = types.SimpleNamespace(
            use_custom_command="Yes",
            command=f"codex resume -C /tmp/project {conversation_id}; echo changed",
        )

        self.assertEqual(
            BRIDGE.profile_auto_resume_identity(helper_profile, "/tmp/project"),
            (conversation_id, "helper"),
        )
        self.assertEqual(
            BRIDGE.profile_auto_resume_details(helper_profile, "/tmp/project"),
            (conversation_id, "helper", 4317),
        )
        self.assertEqual(
            BRIDGE.profile_auto_resume_identity(legacy_profile, "/tmp/project"),
            (conversation_id, "legacy"),
        )
        self.assertIsNone(
            BRIDGE.profile_auto_resume_identity(unrelated_profile, "/tmp/project")
        )
        self.assertIsNone(
            BRIDGE.profile_auto_resume_identity(legacy_profile, "/tmp/other")
        )

    async def test_describes_markerless_owned_helper_after_codex_exits(self):
        conversation_id = "01234567-89ab-cdef-8123-456789abcdef"

        class FakeSession:
            session_id = "terminal-one"

            async def async_get_variable(self, name):
                return {
                    "path": "/tmp/project",
                    "jobName": "zsh",
                    "commandLine": "-zsh",
                }.get(name)

            async def async_get_profile(self):
                return types.SimpleNamespace(
                    use_custom_command="Yes",
                    command=BRIDGE.auto_resume_command(
                        "/tmp/project", conversation_id
                    ),
                )

        described = await BRIDGE.describe_session(
            FakeSession(),
            observed_at="2026-09-02T12:00:00.000Z",
            selected_id=None,
            buried=False,
        )

        self.assertEqual(described["autoResumeConversationId"], conversation_id)
        self.assertEqual(described["autoResumeKind"], "helper")
        self.assertEqual(described["autoResumeControllerPort"], 4317)

    async def test_configures_only_the_exact_running_codex_session(self):
        conversation_id = "01234567-89ab-cdef-8123-456789abcdef"
        cwd = "/tmp/project"

        class CurrentProfile:
            use_custom_command = "No"
            command = ""
            close_sessions_on_end = False

        class FakeProfile:
            def __init__(self):
                self.values = {}

            def set_initial_directory_mode(self, value):
                self.values["directory_mode"] = value

            def set_custom_directory(self, value):
                self.values["cwd"] = value

            def set_use_custom_command(self, value):
                self.values["use_command"] = value

            def set_command(self, value):
                self.values["command"] = value

            def set_close_sessions_on_end(self, value):
                self.values["close_sessions_on_end"] = value

        class FakeSession:
            def __init__(self):
                self.profile = CurrentProfile()
                self.variables = {}
                self.job_name = "node"
                self.job_pid = 42
                self.command_line = "node worker.js"

            async def async_get_variable(self, name):
                return self.variables.get(name, {
                    "path": cwd,
                    "jobName": self.job_name,
                    "jobPid": self.job_pid,
                    "commandLine": self.command_line,
                }.get(name))

            async def async_get_profile(self):
                return self.profile

            async def async_set_profile_properties(self, customization):
                self.profile = types.SimpleNamespace(
                    use_custom_command=customization.values["use_command"],
                    command=customization.values.get("command", ""),
                )
                self.customization = customization

            async def async_set_variable(self, name, value):
                self.variables[name] = value

        session = FakeSession()
        original = {
            "LocalWriteOnlyProfile": getattr(BRIDGE.iterm2, "LocalWriteOnlyProfile", None),
            "InitialWorkingDirectory": getattr(BRIDGE.iterm2, "InitialWorkingDirectory", None),
            "find_exact_session": BRIDGE.find_exact_session,
        }
        BRIDGE.iterm2.LocalWriteOnlyProfile = FakeProfile
        BRIDGE.iterm2.InitialWorkingDirectory = types.SimpleNamespace(
            INITIAL_WORKING_DIRECTORY_CUSTOM="custom"
        )
        BRIDGE.find_exact_session = lambda _app, session_id: (
            session if session_id == "terminal-one" else None
        )
        request = {
            "sessionId": "terminal-one",
            "cwd": cwd,
            "conversationId": conversation_id,
            "controllerPort": 5432,
            "expectedJobPid": 42,
            "expectedJobName": "node",
            "expectedCommandLine": "node worker.js",
        }
        try:
            await BRIDGE.configure_auto_resume(object(), request)
            self.assertIn("session-atlas-resume.zsh", session.profile.command)
            self.assertIn("--cwd /tmp/project", session.profile.command)
            self.assertIn(f"--session-id {conversation_id}", session.profile.command)
            self.assertIn("--controller-port 5432", session.profile.command)
            self.assertEqual(
                session.variables[BRIDGE.AUTO_RESUME_VARIABLE], conversation_id
            )
            self.assertNotIn(
                "close_sessions_on_end", session.customization.values
            )
            await BRIDGE.clear_auto_resume(
                object(),
                {
                    "sessionId": "terminal-one",
                    "conversationId": conversation_id,
                },
            )
            session.profile = types.SimpleNamespace(
                use_custom_command="Yes",
                command=f"codex resume -C {cwd} {conversation_id}",
                close_sessions_on_end=False,
            )
            session.variables[BRIDGE.AUTO_RESUME_VARIABLE] = conversation_id
            await BRIDGE.configure_auto_resume(object(), request)
            self.assertIn("session-atlas-resume.zsh", session.profile.command)
            session.job_pid = 43
            with self.assertRaisesRegex(ValueError, "process identity changed"):
                await BRIDGE.configure_auto_resume(object(), request)
            session.job_pid = 42
            session.command_line = "node other.js"
            with self.assertRaisesRegex(ValueError, "process identity changed"):
                await BRIDGE.configure_auto_resume(object(), request)
            session.job_name = "zsh"
            session.command_line = "-zsh"
            with self.assertRaisesRegex(ValueError, "process identity changed"):
                await BRIDGE.configure_auto_resume(object(), request)
            # A Cmd-D split inherits the session-local command but may not
            # inherit Session Atlas's user variable. The exact owned command
            # is sufficient identity for clearing only that duplicate pane.
            session.profile = types.SimpleNamespace(
                use_custom_command="Yes",
                command=BRIDGE.auto_resume_command(cwd, conversation_id),
            )
            session.variables[BRIDGE.AUTO_RESUME_VARIABLE] = ""
            session.variables[BRIDGE.AUTO_RESUME_ORIGINAL_CLOSE_VARIABLE] = "0"
            await BRIDGE.clear_auto_resume(
                object(),
                {
                    "sessionId": "terminal-one",
                    "conversationId": conversation_id,
                },
            )
        finally:
            BRIDGE.find_exact_session = original["find_exact_session"]
            for name in ("LocalWriteOnlyProfile", "InitialWorkingDirectory"):
                value = original[name]
                if value is None:
                    delattr(BRIDGE.iterm2, name)
                else:
                    setattr(BRIDGE.iterm2, name, value)

        self.assertEqual(session.profile.use_custom_command, "No")
        self.assertNotIn("close_sessions_on_end", session.customization.values)
        self.assertEqual(session.variables[BRIDGE.AUTO_RESUME_VARIABLE], "")
        self.assertEqual(
            session.variables[BRIDGE.AUTO_RESUME_ORIGINAL_CLOSE_VARIABLE], ""
        )

    async def test_refuses_to_replace_an_unrelated_custom_command(self):
        class CurrentProfile:
            use_custom_command = "Yes"
            command = ""

        class FakeSession:
            async def async_get_variable(self, name):
                return {
                    "path": "/tmp/project",
                    "jobName": "codex",
                    "jobPid": 42,
                    "commandLine": "codex",
                }.get(name)

            async def async_get_profile(self):
                return CurrentProfile()

        session = FakeSession()
        original = BRIDGE.find_exact_session
        BRIDGE.find_exact_session = lambda _app, _session_id: session
        try:
            for command in (
                "ssh production",
                "codex resume -C /tmp/project 01234567-89ab-cdef-8123-456789abcdef",
            ):
                CurrentProfile.command = command
                with self.subTest(command=command), self.assertRaisesRegex(
                    ValueError, "unrelated custom command"
                ):
                    await BRIDGE.configure_auto_resume(
                        object(),
                        {
                            "sessionId": "terminal-one",
                            "cwd": "/tmp/project",
                            "conversationId": "01234567-89ab-cdef-8123-456789abcdef",
                            "controllerPort": 4317,
                            "expectedJobPid": 42,
                            "expectedJobName": "codex",
                            "expectedCommandLine": "codex",
                        },
                    )
        finally:
            BRIDGE.find_exact_session = original

    def test_rejects_relative_working_directories(self):
        with self.assertRaisesRegex(ValueError, "must be absolute"):
            BRIDGE.validate_auto_resume_request(
                {
                    "sessionId": "terminal-one",
                    "cwd": "relative/project",
                    "conversationId": "01234567-89ab-cdef-8123-456789abcdef",
                }
            )


if __name__ == "__main__":
    unittest.main()
