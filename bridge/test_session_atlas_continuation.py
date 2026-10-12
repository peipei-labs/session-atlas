import asyncio
import importlib.util
import io
from pathlib import Path
import time
import threading
import tempfile
import types
import unittest
from unittest.mock import AsyncMock, patch

from test_session_atlas_iterm import BRIDGE


CONVERSATION = "01234567-89ab-cdef-8123-456789abcdef"


class SavedSessionCloseTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="atlas-close-proof-")
        self.addCleanup(temporary.cleanup)
        self.codex_home = Path(temporary.name) / ".codex"
        self.rollout = self.codex_home / "sessions" / ("rollout-" + CONVERSATION + ".jsonl")
        self.rollout.parent.mkdir(parents=True)
        self.rollout.write_text(BRIDGE.json.dumps({"type": "session_meta", "payload": {"id": CONVERSATION, "cwd": "/tmp/project", "source": "cli"}}) + "\n")
        original_expanduser = BRIDGE.os.path.expanduser
        patcher = patch.object(BRIDGE.os.path, "expanduser", side_effect=lambda value: str(self.codex_home) if value == "~/.codex" else original_expanduser(value))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.files_returncode = 0
        self.process_output = "42 1\n43 42\n"
        self.files_output = "p43\nf7\naw\nn" + str(self.rollout) + "\n"
        def command(args, **_kwargs):
            return types.SimpleNamespace(returncode=0 if args[0] == "/bin/ps" else self.files_returncode, stdout=self.process_output if args[0] == "/bin/ps" else self.files_output, stderr="")
        command_patcher = patch.object(BRIDGE.subprocess, "run", side_effect=command)
        command_patcher.start()
        self.addCleanup(command_patcher.stop)

    def request(self):
        return {
            "sessionId": "pane-one", "conversationId": CONVERSATION,
            "cwd": "/tmp/project", "expectedJobPid": 42,
            "expectedJobName": "codex", "expectedCommandLine": "codex",
            "expiresAt": time.time() * 1000 + 5000,
            "proof": {"rolloutPath": str(self.rollout), "size": self.rollout.stat().st_size, "mtimeNs": str(self.rollout.stat().st_mtime_ns)},
        }

    def session(self):
        values = {"path": "/tmp/project", "jobPid": 42, "jobName": "codex", "commandLine": "codex", BRIDGE.AUTO_RESUME_VARIABLE: CONVERSATION}
        session = types.SimpleNamespace(
            async_get_variable=AsyncMock(side_effect=lambda key: values.get(key)),
            async_get_profile=AsyncMock(return_value=types.SimpleNamespace(use_custom_command="No", command="")),
            async_close=AsyncMock(),
        )
        return session, values

    async def test_closes_only_validated_pane_with_native_close(self):
        session, _ = self.session()
        with patch.object(BRIDGE, "find_exact_session", return_value=session):
            await BRIDGE.close_saved_session(object(), self.request())
        session.async_close.assert_awaited_once_with(force=True)
        self.assertEqual([call.args[0] for call in session.async_get_variable.await_args_list].count("jobPid"), 3)

    async def test_changed_job_after_writer_check_never_closes(self):
        session, values = self.session()
        original_check = BRIDGE.validate_close_writer
        def changed_job(*args):
            original_check(*args)
            values.update(jobPid=99, jobName="zsh", commandLine="zsh")
        with patch.object(BRIDGE, "find_exact_session", return_value=session), patch.object(BRIDGE, "validate_close_writer", side_effect=changed_job):
            with self.assertRaisesRegex(ValueError, "changed during writer validation"):
                await BRIDGE.close_saved_session(object(), self.request())
        session.async_close.assert_not_awaited()

    async def test_changed_identity_or_expired_request_never_closes(self):
        for field, value in (("path", "/tmp/other"), ("jobPid", 43), ("jobName", "zsh"), ("commandLine", "other"), (BRIDGE.AUTO_RESUME_VARIABLE, "11234567-89ab-cdef-8123-456789abcdef")):
            session, values = self.session()
            values[field] = value
            with patch.object(BRIDGE, "find_exact_session", return_value=session):
                with self.assertRaises(ValueError):
                    await BRIDGE.close_saved_session(object(), self.request())
            session.async_close.assert_not_awaited()
        session, _ = self.session()
        request = self.request()
        request["expiresAt"] = time.time() * 1000 - 1
        with patch.object(BRIDGE, "find_exact_session", return_value=session):
            with self.assertRaisesRegex(ValueError, "expired"):
                await BRIDGE.close_saved_session(object(), request)
        session.async_close.assert_not_awaited()

    async def test_rechecks_identity_after_profile_read(self):
        session, values = self.session()
        async def profile():
            values["jobPid"] = 43
            return types.SimpleNamespace(use_custom_command="No", command="")
        session.async_get_profile.side_effect = profile
        with patch.object(BRIDGE, "find_exact_session", return_value=session):
            with self.assertRaisesRegex(ValueError, "during validation"):
                await BRIDGE.close_saved_session(object(), self.request())
        session.async_close.assert_not_awaited()

    async def test_thread_append_after_idle_check_prevents_close(self):
        session, _ = self.session()
        request = self.request()
        self.rollout.write_text(self.rollout.read_text() + '{"type":"event_msg","payload":{"type":"task_started"}}\n')
        with patch.object(BRIDGE, "find_exact_session", return_value=session):
            with self.assertRaisesRegex(ValueError, "changed after its idle check"):
                await BRIDGE.close_saved_session(object(), request)
        session.async_close.assert_not_awaited()

    async def test_replaced_same_size_rollout_prevents_close(self):
        session, _ = self.session()
        request = self.request()
        previous = self.rollout.stat()
        BRIDGE.os.utime(self.rollout, ns=(previous.st_atime_ns, previous.st_mtime_ns + 1))
        with patch.object(BRIDGE, "find_exact_session", return_value=session):
            with self.assertRaisesRegex(ValueError, "changed after its idle check"):
                await BRIDGE.close_saved_session(object(), request)
        session.async_close.assert_not_awaited()

    async def test_unrelated_proof_path_or_missing_proof_prevents_close(self):
        for proof in ({"rolloutPath": "/tmp/unrelated.jsonl", "size": 1, "mtimeNs": "1"}, None):
            session, _ = self.session()
            request = self.request()
            request["proof"] = proof
            with patch.object(BRIDGE, "find_exact_session", return_value=session):
                with self.assertRaises(ValueError):
                    await BRIDGE.close_saved_session(object(), request)
            session.async_close.assert_not_awaited()

    async def test_same_process_switch_to_another_thread_does_not_close(self):
        session, _ = self.session()
        self.files_output = "p43\nf7\naw\nn" + str(self.rollout.with_name("rollout-11234567-89ab-cdef-8123-456789abcdef.jsonl")) + "\n"
        with patch.object(BRIDGE, "find_exact_session", return_value=session):
            with self.assertRaisesRegex(ValueError, "no longer writing"):
                await BRIDGE.close_saved_session(object(), self.request())
        session.async_close.assert_not_awaited()

    async def test_multiple_root_writers_refused_but_subagent_writer_allowed(self):
        other_id = "11234567-89ab-cdef-8123-456789abcdef"
        other_path = self.rollout.with_name("rollout-" + other_id + ".jsonl")
        self.files_output += "f8\naw\nn" + str(other_path) + "\n"
        session, _ = self.session()
        other_path.write_text(BRIDGE.json.dumps({"type": "session_meta", "payload": {"id": other_id, "source": "cli"}}) + "\n")
        with patch.object(BRIDGE, "find_exact_session", return_value=session):
            with self.assertRaisesRegex(ValueError, "multiple root writers"):
                await BRIDGE.close_saved_session(object(), self.request())
        session.async_close.assert_not_awaited()
        other_path.write_text(BRIDGE.json.dumps({"type": "session_meta", "payload": {"id": other_id, "source": {"subagent": {"thread_spawn": {"parent_thread_id": CONVERSATION}}}}}) + "\n")
        with patch.object(BRIDGE, "find_exact_session", return_value=session):
            await BRIDGE.close_saved_session(object(), self.request())
        session.async_close.assert_awaited_once_with(force=True)

    async def test_read_only_rollout_fd_does_not_count_as_writer(self):
        session, _ = self.session()
        self.files_output = self.files_output.replace("\naw\n", "\nar\n")
        with patch.object(BRIDGE, "find_exact_session", return_value=session):
            with self.assertRaisesRegex(ValueError, "no longer writing"):
                await BRIDGE.close_saved_session(object(), self.request())
        session.async_close.assert_not_awaited()

    async def test_exited_sibling_lsof_status_one_still_requires_actual_writer_evidence(self):
        session, _ = self.session()
        self.files_returncode = 1
        with patch.object(BRIDGE, "find_exact_session", return_value=session):
            await BRIDGE.close_saved_session(object(), self.request())
        session.async_close.assert_awaited_once_with(force=True)


class ThreadRestoreTests(unittest.IsolatedAsyncioTestCase):
    def target(self):
        return {"conversationId": CONVERSATION, "cwd": "/tmp/project", "title": "Pending work", "windowId": "original-window", "profileName": "Default"}

    async def test_creates_one_new_tab_in_original_window(self):
        session = types.SimpleNamespace(session_id="restored-pane", async_set_variable=AsyncMock())
        window = types.SimpleNamespace(window_id="original-window", async_create_tab=AsyncMock(return_value=types.SimpleNamespace(current_session=session)))
        app = types.SimpleNamespace(terminal_windows=[window])
        with patch.object(BRIDGE, "pane_profile", return_value="customization"):
            result = await BRIDGE.restore_thread(app, object(), self.target(), 5432)
        window.async_create_tab.assert_awaited_once_with(profile="Default", profile_customizations="customization")
        session.async_set_variable.assert_awaited_once_with(BRIDGE.AUTO_RESUME_VARIABLE, CONVERSATION)
        self.assertEqual(result, {"terminalSessionId": "restored-pane", "windowId": "original-window"})

    async def test_missing_original_window_creates_one_new_window(self):
        session = types.SimpleNamespace(session_id="restored-pane", async_set_variable=AsyncMock())
        window = types.SimpleNamespace(window_id="new-window", current_tab=types.SimpleNamespace(current_session=session))
        api = types.SimpleNamespace(async_create=AsyncMock(return_value=window))
        with patch.object(BRIDGE, "pane_profile", return_value="customization"), patch.object(BRIDGE.iterm2, "Window", api, create=True):
            result = await BRIDGE.restore_thread(types.SimpleNamespace(terminal_windows=[]), "connection", self.target())
        api.async_create.assert_awaited_once_with("connection", profile="Default", profile_customizations="customization")
        self.assertEqual(result["windowId"], "new-window")

    async def test_rpc_failure_is_uncertain_after_create_attempt(self):
        window = types.SimpleNamespace(window_id="original-window", async_create_tab=AsyncMock(side_effect=RuntimeError("RPC disconnected")))
        with patch.object(BRIDGE, "pane_profile", return_value="customization"):
            with self.assertRaises(BRIDGE.PartialRestoreError):
                await BRIDGE.restore_thread(types.SimpleNamespace(terminal_windows=[window]), object(), self.target())

    async def test_invalid_target_creates_nothing(self):
        window = types.SimpleNamespace(window_id="original-window", async_create_tab=AsyncMock())
        target = self.target()
        target["conversationId"] = "latest"
        with self.assertRaises(ValueError):
            await BRIDGE.restore_thread(types.SimpleNamespace(terminal_windows=[window]), object(), target)
        window.async_create_tab.assert_not_awaited()


class ParkShortcutRpcTests(unittest.IsolatedAsyncioTestCase):
    def rpc_stubs(self):
        registered = []
        def rpc(function):
            function.async_register = AsyncMock(side_effect=lambda *_args, **_kwargs: registered.append(function))
            return function
        return registered, rpc

    async def test_http_wait_leaves_event_loop_available_for_bridge_close(self):
        registered, rpc = self.rpc_stubs()
        received = threading.Event()
        def http_request(session_id, port):
            self.assertEqual(session_id, "pane-one")
            self.assertEqual(port, 4317)
            return received.wait(timeout=1), None
        with patch.object(BRIDGE.iterm2, "RPC", rpc, create=True), patch.object(BRIDGE.iterm2, "Reference", lambda value: value, create=True), patch.object(BRIDGE, "park_http_request", http_request), patch.dict(BRIDGE.os.environ, {"SESSION_ATLAS_PORT": "4317"}), patch.object(BRIDGE.asyncio, "create_subprocess_exec", new_callable=AsyncMock) as opener:
            await BRIDGE.register_park_rpc(object())
            task = asyncio.create_task(registered[0]("pane-one"))
            await asyncio.sleep(0.01)
            received.set()
            await task
            opener.assert_not_awaited()

    async def test_failure_opens_precise_handoff_page_without_terminal_input(self):
        registered, rpc = self.rpc_stubs()
        process = types.SimpleNamespace(wait=AsyncMock())
        with patch.object(BRIDGE.iterm2, "RPC", rpc, create=True), patch.object(BRIDGE.iterm2, "Reference", lambda value: value, create=True), patch.object(BRIDGE, "park_http_request", return_value=(False, "SESSION_NOT_IDLE")), patch.dict(BRIDGE.os.environ, {"SESSION_ATLAS_PORT": "5432"}), patch.object(BRIDGE.asyncio, "create_subprocess_exec", new_callable=AsyncMock, return_value=process) as opener:
            await BRIDGE.register_park_rpc(object())
            await registered[0]("pane:one")
            opener.assert_awaited_once_with("/usr/bin/open", "http://127.0.0.1:5432/?handoff=iterm%3Apane%3Aone&handoffError=SESSION_NOT_IDLE")
            process.wait.assert_awaited_once()

class ParkHttpErrorTests(unittest.TestCase):
    def request_error(self, body):
        error = BRIDGE.urllib.error.HTTPError("http://127.0.0.1:4317", 409, "Conflict", {}, io.BytesIO(body))
        opener = types.SimpleNamespace(open=lambda *_args, **_kwargs: self.raise_error(error))
        with patch.object(BRIDGE.urllib.request, "build_opener", return_value=opener):
            return BRIDGE.park_http_request("pane:one", 4317)

    @staticmethod
    def raise_error(error):
        raise error

    def test_forwards_only_the_declared_error_codes(self):
        for code in BRIDGE.PARK_ERROR_CODES:
            body = BRIDGE.json.dumps({"error": {"code": code, "message": "private sentinel"}}).encode()
            self.assertEqual(self.request_error(body), (False, code))
        self.assertEqual(self.request_error(b'{"error":{"code":"private sentinel"}}'), (False, "CLOSE_FAILED"))

    def test_invalid_or_oversized_errors_have_a_fixed_fallback(self):
        for body in (b"not-json", b"[]", b'{"error":{"code":42}}', b'{"error":{"code":"HANDOFF_REQUIRED"},"padding":"' + b"a" * 8192 + b'"}'):
            self.assertEqual(self.request_error(body), (False, "CLOSE_FAILED"))

    def test_transport_failure_has_a_fixed_fallback(self):
        opener = types.SimpleNamespace(open=lambda *_args, **_kwargs: self.raise_error(BRIDGE.urllib.error.URLError("private sentinel")))
        with patch.object(BRIDGE.urllib.request, "build_opener", return_value=opener):
            self.assertEqual(BRIDGE.park_http_request("pane:one", 4317), (False, "CLOSE_FAILED"))



class ShortcutMappingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("shortcut", Path(__file__).resolve().parents[1] / "scripts/session-atlas-shortcut.py")
        cls.shortcut = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.shortcut)

    def test_install_and_remove_preserve_all_unrelated_entries(self):
        mapping = {"other": {"Action": 19, "Text": "private-command", "Custom": True}}
        installed = self.shortcut.changed_mapping(mapping, "install")
        self.assertEqual(installed["other"], mapping["other"])
        self.assertNotIn(self.shortcut.KEY, mapping)
        self.assertEqual(self.shortcut.changed_mapping(installed, "uninstall"), mapping)

    def test_conflicting_legacy_binding_is_not_overwritten(self):
        with self.assertRaisesRegex(ValueError, "unrelated binding"):
            self.shortcut.changed_mapping({"0x62-0x1c0000": {"Action": 19}}, "install")
        with self.assertRaisesRegex(ValueError, "another owner"):
            self.shortcut.changed_mapping({self.shortcut.KEY: {"Action": 19}}, "uninstall")


if __name__ == "__main__":
    unittest.main()
