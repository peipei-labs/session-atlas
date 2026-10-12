import asyncio
import copy
import json
import types
import unittest
from unittest.mock import AsyncMock, patch

from test_session_atlas_iterm import BRIDGE


CONVERSATION = "01234567-89ab-cdef-8123-456789abcdef"
OTHER_CONVERSATION = "11234567-89ab-cdef-8123-456789abcdef"


class Color:
    def __init__(self, red=0, green=0, blue=0):
        self.value = {"Red Component": red / 255, "Green Component": green / 255, "Blue Component": blue / 255, "Alpha Component": 1.0, "Color Space": "sRGB"}

    def get_dict(self):
        return copy.deepcopy(self.value)

    def from_dict(self, value):
        for name in ("Red Component", "Green Component", "Blue Component"):
            if not isinstance(value[name], (int, float)):
                raise ValueError("Invalid color")
        self.value = copy.deepcopy(value)


class Customization:
    def __init__(self):
        self.values = {}

    def __getattr__(self, name):
        if not name.startswith("set_"):
            raise AttributeError(name)
        return lambda value: self.values.update({name[4:]: value})


class MarkerTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        for name, value in (("Color", Color), ("LocalWriteOnlyProfile", Customization)):
            patcher = patch.object(BRIDGE.iterm2, name, value, create=True)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.profile = types.SimpleNamespace(
            badge_text="Original badge", tab_color=Color(12, 34, 56), use_tab_color=False,
            subtitle="",
            tab_color_light=None, use_tab_color_light=None,
            tab_color_dark=Color(78, 90, 12), use_tab_color_dark=True,
            use_custom_command="No", command="",
        )
        self.original = BRIDGE.marker_profile_values(self.profile)
        self.variables = {"path": "/tmp/project", "jobPid": 42, "jobName": "codex", "commandLine": "codex", BRIDGE.AUTO_RESUME_VARIABLE: CONVERSATION}
        self.session = types.SimpleNamespace(
            session_id="pane-one",
            async_get_variable=AsyncMock(side_effect=lambda key: self.variables.get(key)),
            async_set_variable=AsyncMock(side_effect=lambda key, value: self.variables.update({key: value})),
            async_get_profile=AsyncMock(side_effect=lambda: copy.deepcopy(self.profile)),
            async_set_profile_properties=AsyncMock(side_effect=lambda customization: vars(self.profile).update(copy.deepcopy(customization.values))),
        )
        patcher = patch.object(BRIDGE, "find_exact_session", return_value=self.session)
        patcher.start()
        self.addCleanup(patcher.stop)

    def request(self, **changes):
        return {
            "sessionId": "pane-one", "conversationId": CONVERSATION,
            "cwd": "/tmp/project", "expectedJobPid": 42,
            "expectedJobName": "codex", "expectedCommandLine": "codex",
            "expiresAt": BRIDGE.time.time() * 1000 + 5000,
            **changes,
        }

    def marker(self):
        return BRIDGE.parse_saved_marker(self.variables.get(BRIDGE.SAVED_MARKER_VARIABLE))

    async def apply(self):
        await BRIDGE.configure_saved_marker(object(), self.request())

    async def test_applies_pane_local_purple_for_both_themes_without_badge_writes(self):
        self.profile.tab_color_light = Color(20, 30, 40)
        self.profile.use_tab_color_light = False
        self.original = BRIDGE.marker_profile_values(self.profile)
        await self.apply()
        self.assertEqual(self.profile.badge_text, "Original badge")
        self.assertEqual(self.profile.subtitle, "Atlas · 已保留")
        self.assertNotIn("badge_text", self.session.async_set_profile_properties.await_args.args[0].values)
        self.assertFalse(any("badge_max" in key for key in self.session.async_set_profile_properties.await_args.args[0].values))
        self.assertEqual(set(self.session.async_set_profile_properties.await_args.args[0].values),
                         {"subtitle", "tab_color", "use_tab_color", "tab_color_light", "use_tab_color_light", "tab_color_dark", "use_tab_color_dark"})
        purple = Color(*BRIDGE.SAVED_MARKER_COLOR).get_dict()
        for suffix in BRIDGE.SAVED_MARKER_COLOR_SUFFIXES:
            self.assertEqual(getattr(self.profile, "tab_color" + suffix).get_dict(), purple)
            self.assertTrue(getattr(self.profile, "use_tab_color" + suffix))
        self.assertEqual(self.marker()["original"], self.original)
        self.assertEqual(self.marker()["ownerSessionId"], "pane-one")
        self.assertEqual(self.marker()["phase"], "applied")

    async def test_empty_badge_stays_empty(self):
        self.profile.badge_text = ""
        await self.apply()
        self.assertEqual(self.profile.badge_text, "")

    async def test_original_subtitle_is_preserved_appended_once_and_restored(self):
        self.profile.subtitle = "Original subtitle"
        await self.apply()
        self.assertEqual(self.profile.subtitle, "Original subtitle · Atlas · 已保留")
        writes = self.session.async_set_profile_properties.await_count
        await self.apply()
        self.assertEqual(self.session.async_set_profile_properties.await_count, writes)
        self.assertEqual(self.profile.subtitle, "Original subtitle · Atlas · 已保留")
        await BRIDGE.clear_saved_marker(object(), self.request())
        self.assertEqual(self.profile.subtitle, "Original subtitle")

    async def test_unset_subtitle_uses_empty_string_for_restore(self):
        self.profile.subtitle = None
        await self.apply()
        self.assertEqual(self.marker()["original"]["subtitle"], "")
        await BRIDGE.clear_saved_marker(object(), self.request())
        self.assertEqual(self.profile.subtitle, "")

    async def test_real_iterm_numeric_boolean_readback_is_normalized(self):
        async def numeric_write(customization):
            values = copy.deepcopy(customization.values)
            for key, value in values.items():
                if key.startswith("use_tab_color") and isinstance(value, bool):
                    values[key] = int(value)
            vars(self.profile).update(values)
        self.session.async_set_profile_properties.side_effect = numeric_write
        await self.apply()
        self.assertEqual(self.marker()["phase"], "applied")
        await BRIDGE.clear_saved_marker(object(), self.request())
        self.assertEqual(BRIDGE.marker_profile_values(self.profile), self.original)

    async def test_absent_theme_properties_are_never_created_or_sent_as_null(self):
        async def reject_null(customization):
            self.assertNotIn(None, customization.values.values())
            vars(self.profile).update(copy.deepcopy(customization.values))
        self.session.async_set_profile_properties.side_effect = reject_null
        await self.apply()
        self.assertIsNone(self.profile.tab_color_light)
        self.assertIsNone(self.profile.use_tab_color_light)
        await BRIDGE.clear_saved_marker(object(), self.request())
        self.assertEqual(BRIDGE.marker_profile_values(self.profile), self.original)

    async def test_repeat_apply_does_not_repaint_user_overrides(self):
        await self.apply()
        self.profile.badge_text = "User replacement"
        self.profile.subtitle = "User subtitle"
        self.profile.tab_color = Color(255, 0, 0)
        writes = self.session.async_set_profile_properties.await_count
        await self.apply()
        self.assertEqual(self.session.async_set_profile_properties.await_count, writes)
        self.assertEqual(self.profile.badge_text, "User replacement")
        self.assertEqual(self.profile.subtitle, "User subtitle")
        self.assertEqual(self.profile.tab_color.get_dict(), Color(255, 0, 0).get_dict())

    async def test_clear_restores_originals_and_forgets_ownership(self):
        await self.apply()
        await BRIDGE.clear_saved_marker(object(), self.request())
        self.assertEqual(BRIDGE.marker_profile_values(self.profile), self.original)
        self.assertIsNone(self.marker())

    async def install_legacy_marker(self, watermark=True):
        await self.apply()
        marker = self.marker()
        if watermark:
            self.profile.badge_text += "\nAtlas · 已保留"
        marker["applied"]["badge_text"] = self.profile.badge_text
        self.profile.subtitle = marker["original"].pop("subtitle")
        del marker["applied"]["subtitle"]
        self.variables[BRIDGE.SAVED_MARKER_VARIABLE] = json.dumps(marker)

    async def test_legacy_watermark_is_removed_after_fresh_identity_check_only_once(self):
        await self.install_legacy_marker()
        snapshot = await BRIDGE.describe_session(self.session, observed_at="now", selected_id=None, buried=False)
        self.assertEqual(snapshot["savedMarkerState"], "requested")
        self.assertIn("Atlas · 已保留", self.profile.badge_text)
        await self.apply()
        self.assertEqual(self.profile.badge_text, self.original["badge_text"])
        self.assertEqual(self.marker()["original"], self.original)
        self.assertEqual(self.marker()["applied"]["badge_text"], self.original["badge_text"])
        self.assertEqual(self.profile.subtitle, "Atlas · 已保留")
        self.assertEqual(self.profile.tab_color.get_dict(), Color(*BRIDGE.SAVED_MARKER_COLOR).get_dict())
        snapshot = await BRIDGE.describe_session(self.session, observed_at="now", selected_id=None, buried=False)
        self.assertEqual(snapshot["savedMarkerState"], "applied")
        writes = self.session.async_set_profile_properties.await_count
        await self.apply()
        self.assertEqual(self.session.async_set_profile_properties.await_count, writes)

    async def test_legacy_tab_only_marker_gets_subtitle_after_fresh_configuration(self):
        self.profile.subtitle = "Original subtitle"
        await self.install_legacy_marker(watermark=False)
        snapshot = await BRIDGE.describe_session(self.session, observed_at="now", selected_id=None, buried=False)
        self.assertEqual(snapshot["savedMarkerState"], "requested")
        self.assertEqual(self.profile.subtitle, "Original subtitle")
        await self.apply()
        self.assertEqual(self.profile.subtitle, "Original subtitle · Atlas · 已保留")
        self.assertFalse(BRIDGE.saved_marker_needs_configuration(self.marker()))
        await BRIDGE.clear_saved_marker(object(), self.request())
        self.assertEqual(self.profile.subtitle, "Original subtitle")

    async def test_legacy_clear_does_not_touch_an_unowned_subtitle(self):
        await self.install_legacy_marker()
        self.profile.subtitle = "User subtitle"
        self.session.async_set_profile_properties.reset_mock()
        await BRIDGE.clear_saved_marker(object(), self.request())
        self.assertEqual(self.profile.subtitle, "User subtitle")
        self.assertNotIn("subtitle", self.session.async_set_profile_properties.await_args.args[0].values)

    async def test_legacy_upgrade_rechecks_identity_before_removing_watermark(self):
        await self.install_legacy_marker()
        writes = self.session.async_set_profile_properties.await_count
        self.variables["jobPid"] = 99
        with self.assertRaisesRegex(ValueError, "identity changed"):
            await self.apply()
        self.assertEqual(self.session.async_set_profile_properties.await_count, writes)
        self.assertIn("Atlas · 已保留", self.profile.badge_text)

    async def test_legacy_upgrade_preserves_user_badge_and_color_edits(self):
        await self.install_legacy_marker()
        self.profile.badge_text = "User replacement"
        self.profile.tab_color = Color(255, 0, 0)
        await self.apply()
        self.assertEqual(self.profile.badge_text, "User replacement")
        self.assertEqual(self.profile.tab_color.get_dict(), Color(255, 0, 0).get_dict())
        self.assertEqual(self.marker()["overrides"], ["badge_text", "tab_color"])
        await BRIDGE.clear_saved_marker(object(), self.request())
        self.assertEqual(self.profile.badge_text, "User replacement")

    async def test_legacy_watermark_removal_retries_after_lost_write_acknowledgement(self):
        await self.install_legacy_marker()
        failed = False
        async def write(customization):
            nonlocal failed
            vars(self.profile).update(copy.deepcopy(customization.values))
            if not failed:
                failed = True
                raise RuntimeError("Write acknowledgement lost")
        self.session.async_set_profile_properties.side_effect = write
        with self.assertRaises(RuntimeError):
            await self.apply()
        self.assertEqual(self.profile.badge_text, self.original["badge_text"])
        self.assertTrue(self.marker()["restoring"])
        await self.apply()
        self.assertFalse(self.marker().get("overrides"))
        self.assertFalse(BRIDGE.saved_marker_needs_configuration(self.marker()))
        self.assertEqual(self.profile.badge_text, self.original["badge_text"])
        self.assertTrue(self.profile.use_tab_color)
        await BRIDGE.clear_saved_marker(object(), self.request())
        self.assertEqual(BRIDGE.marker_profile_values(self.profile), self.original)

    async def test_inherited_legacy_split_loses_watermark_and_color_before_snapshot(self):
        await self.install_legacy_marker()
        self.profile.subtitle = "Split subtitle"
        self.session.session_id = "new-split"
        snapshot = await BRIDGE.describe_session(self.session, observed_at="now", selected_id=None, buried=False)
        self.assertNotIn("savedMarkerState", snapshot)
        self.assertIsNone(self.marker())
        self.assertEqual(BRIDGE.marker_profile_values(self.profile), {**self.original, "subtitle": "Split subtitle"})

    async def test_clear_retains_requested_provenance_for_temporarily_unknown_identity(self):
        await self.apply()
        self.variables.update(jobName="zsh", commandLine="zsh", jobPid=88)
        await BRIDGE.clear_saved_marker(object(), self.request(forget=False))
        self.assertEqual(BRIDGE.marker_profile_values(self.profile), self.original)
        self.assertEqual(self.marker(), BRIDGE.requested_saved_marker("pane-one", CONVERSATION))

    async def test_clear_keeps_user_badge_and_color_override(self):
        await self.apply()
        self.profile.badge_text = "Replacement"
        self.profile.tab_color = Color(255, 0, 0)
        self.profile.use_tab_color_dark = False
        await BRIDGE.clear_saved_marker(object(), self.request())
        self.assertEqual(self.profile.badge_text, "Replacement")
        self.assertEqual(self.profile.tab_color.get_dict(), Color(255, 0, 0).get_dict())
        self.assertTrue(self.profile.use_tab_color)
        self.assertEqual(self.profile.tab_color_dark.get_dict(), Color(*BRIDGE.SAVED_MARKER_COLOR).get_dict())
        self.assertFalse(self.profile.use_tab_color_dark)
        self.assertIsNone(self.profile.tab_color_light)

    async def test_user_overrides_survive_suspension_and_reapply(self):
        await self.apply()
        self.profile.badge_text = "User replacement"
        self.profile.tab_color = Color(255, 0, 0)
        await BRIDGE.clear_saved_marker(object(), self.request(forget=False))
        await self.apply()
        self.assertEqual(self.profile.badge_text, "User replacement")
        self.assertEqual(self.profile.tab_color.get_dict(), Color(255, 0, 0).get_dict())
        await BRIDGE.clear_saved_marker(object(), self.request())
        self.assertEqual(self.profile.badge_text, "User replacement")
        self.assertEqual(self.profile.tab_color.get_dict(), Color(255, 0, 0).get_dict())

    async def test_user_subtitle_override_survives_suspension_reapply_and_clear(self):
        await self.apply()
        self.profile.subtitle = "User subtitle"
        await BRIDGE.clear_saved_marker(object(), self.request(forget=False))
        self.assertEqual(self.marker()["overrides"], ["subtitle"])
        await self.apply()
        self.assertEqual(self.profile.subtitle, "User subtitle")
        await BRIDGE.clear_saved_marker(object(), self.request())
        self.assertEqual(self.profile.subtitle, "User subtitle")

    async def test_one_failed_ownership_readback_can_retry_application(self):
        failed = False
        async def read(key):
            nonlocal failed
            if key == BRIDGE.SAVED_MARKER_VARIABLE and self.marker() is not None and not failed:
                failed = True
                raise RuntimeError("Readback temporarily failed")
            return self.variables.get(key)
        self.session.async_get_variable.side_effect = read
        with self.assertRaises(RuntimeError):
            await self.apply()
        self.assertEqual(self.marker()["phase"], "requested")
        await self.apply()
        self.assertEqual(self.marker()["phase"], "applied")
        self.assertEqual(self.profile.badge_text, self.original["badge_text"])
        self.assertTrue(self.profile.use_tab_color)

    async def test_failed_profile_write_can_retry_without_disabling_marker_fields(self):
        original_write = self.session.async_set_profile_properties.side_effect
        self.session.async_set_profile_properties.side_effect = RuntimeError("Write unavailable")
        with self.assertRaises(RuntimeError):
            await self.apply()
        self.assertEqual(self.marker()["phase"], "requested")
        self.assertFalse(self.marker().get("overrides"))
        self.session.async_set_profile_properties.side_effect = original_write
        await self.apply()
        self.assertEqual(self.profile.badge_text, self.original["badge_text"])
        self.assertTrue(self.profile.use_tab_color)

    async def test_restore_readback_failure_does_not_turn_our_restoration_into_user_overrides(self):
        await self.apply()
        reads = 0
        async def read():
            nonlocal reads
            reads += 1
            if reads == 2:
                raise RuntimeError("Restoration readback unavailable")
            return copy.deepcopy(self.profile)
        self.session.async_get_profile.side_effect = read
        with self.assertRaises(RuntimeError):
            await BRIDGE.clear_saved_marker(object(), self.request(forget=False))
        await BRIDGE.clear_saved_marker(object(), self.request(forget=False))
        await self.apply()
        self.assertFalse(self.marker().get("overrides"))
        self.assertEqual(self.profile.badge_text, self.original["badge_text"])
        self.assertTrue(self.profile.use_tab_color)

    async def test_applied_profile_with_lost_acknowledgement_can_retry(self):
        failed = False
        async def write(customization):
            nonlocal failed
            vars(self.profile).update(copy.deepcopy(customization.values))
            if not failed:
                failed = True
                raise RuntimeError("Write acknowledgement lost")
        self.session.async_set_profile_properties.side_effect = write
        with self.assertRaises(RuntimeError):
            await self.apply()
        await self.apply()
        self.assertFalse(self.marker().get("overrides"))
        self.assertEqual(self.profile.badge_text, self.original["badge_text"])
        self.assertEqual(self.profile.subtitle, "Atlas · 已保留")
        self.assertTrue(self.profile.use_tab_color)
        await BRIDGE.clear_saved_marker(object(), self.request())
        self.assertEqual(BRIDGE.marker_profile_values(self.profile), self.original)

    async def test_partial_subtitle_write_failure_restores_and_retries_without_false_override(self):
        original_write = self.session.async_set_profile_properties.side_effect
        failed = False
        async def write(customization):
            nonlocal failed
            if not failed:
                failed = True
                self.profile.subtitle = customization.values["subtitle"]
                raise RuntimeError("Partial profile write")
            original_write(customization)
        self.session.async_set_profile_properties.side_effect = write
        with self.assertRaises(RuntimeError):
            await self.apply()
        self.assertEqual(BRIDGE.marker_profile_values(self.profile), self.original)
        self.assertFalse(self.marker().get("overrides"))
        await self.apply()
        self.assertEqual(self.profile.subtitle, "Atlas · 已保留")
        self.assertTrue(self.profile.use_tab_color)

    async def test_user_reverting_badge_to_original_survives_a_failed_restore_readback(self):
        await self.install_legacy_marker()
        self.profile.badge_text = self.original["badge_text"]
        reads = 0
        async def read():
            nonlocal reads
            reads += 1
            if reads == 2:
                raise RuntimeError("Restoration readback unavailable")
            return copy.deepcopy(self.profile)
        self.session.async_get_profile.side_effect = read
        with self.assertRaises(RuntimeError):
            await BRIDGE.clear_saved_marker(object(), self.request(forget=False))
        await BRIDGE.clear_saved_marker(object(), self.request(forget=False))
        await self.apply()
        self.assertEqual(self.marker()["overrides"], ["badge_text"])
        self.assertEqual(self.profile.badge_text, self.original["badge_text"])
        self.assertTrue(self.profile.use_tab_color)

    async def test_failed_rollback_remains_requested_and_recoverable(self):
        reads = 0
        async def read():
            nonlocal reads
            reads += 1
            if reads >= 3:
                raise RuntimeError("Rollback unavailable")
            return copy.deepcopy(self.profile)
        self.session.async_get_profile.side_effect = read
        self.session.async_set_profile_properties.side_effect = RuntimeError("Write unavailable")
        with self.assertRaises(RuntimeError):
            await self.apply()
        snapshot = await BRIDGE.describe_session(self.session, observed_at="now", selected_id=None, buried=False)
        self.assertEqual(snapshot["savedMarkerState"], "requested")
        self.session.async_get_profile.side_effect = lambda: copy.deepcopy(self.profile)
        self.session.async_set_profile_properties.side_effect = lambda c: vars(self.profile).update(copy.deepcopy(c.values))
        await self.apply()
        self.assertTrue(self.marker()["verified"])
        self.assertEqual(self.profile.badge_text, self.original["badge_text"])
        self.assertTrue(self.profile.use_tab_color)

    async def test_clear_without_ownership_does_not_touch_profile(self):
        await BRIDGE.clear_saved_marker(object(), self.request())
        self.session.async_set_profile_properties.assert_not_awaited()
        self.session.async_set_variable.assert_not_awaited()

    async def test_clear_rejects_other_conversation(self):
        await self.apply()
        writes = self.session.async_set_profile_properties.await_count
        with self.assertRaisesRegex(ValueError, "ownership changed"):
            await BRIDGE.clear_saved_marker(object(), self.request(conversationId=OTHER_CONVERSATION))
        self.assertEqual(self.session.async_set_profile_properties.await_count, writes)

    async def test_clear_requested_does_not_read_or_modify_profile(self):
        self.variables[BRIDGE.SAVED_MARKER_VARIABLE] = json.dumps(BRIDGE.requested_saved_marker("pane-one", CONVERSATION))
        await BRIDGE.clear_saved_marker(object(), self.request())
        self.session.async_get_profile.assert_not_awaited()
        self.session.async_set_profile_properties.assert_not_awaited()
        self.assertIsNone(self.marker())

    async def test_apply_rejects_inherited_owner_or_different_conversation(self):
        for owner, conversation in (("old-pane", CONVERSATION), ("pane-one", OTHER_CONVERSATION)):
            self.variables[BRIDGE.SAVED_MARKER_VARIABLE] = json.dumps(BRIDGE.requested_saved_marker(owner, conversation))
            with self.assertRaisesRegex(ValueError, "ownership changed"):
                await self.apply()
        self.session.async_set_profile_properties.assert_not_awaited()

    async def test_request_can_be_upgraded_to_applied(self):
        self.variables[BRIDGE.SAVED_MARKER_VARIABLE] = json.dumps(BRIDGE.requested_saved_marker("pane-one", CONVERSATION))
        await self.apply()
        self.assertEqual(self.marker()["phase"], "applied")

    async def test_rejects_changed_cwd_or_process_before_any_write(self):
        for key, value in (("path", "/tmp/other"), ("jobPid", 99), ("jobName", "zsh"), ("commandLine", "different")):
            original = self.variables[key]
            self.variables[key] = value
            with self.assertRaisesRegex(ValueError, "identity changed"):
                await self.apply()
            self.variables[key] = original
        self.session.async_set_profile_properties.assert_not_awaited()
        self.session.async_set_variable.assert_not_awaited()

    async def test_rechecks_identity_after_profile_read(self):
        def get_profile():
            self.variables["jobPid"] = 99
            return copy.deepcopy(self.profile)
        self.session.async_get_profile.side_effect = get_profile
        with self.assertRaisesRegex(ValueError, "identity changed"):
            await self.apply()
        self.session.async_set_profile_properties.assert_not_awaited()
        self.session.async_set_variable.assert_not_awaited()

    async def test_rechecks_identity_after_ownership_write(self):
        def set_variable(key, value):
            self.variables[key] = value
            self.variables["jobPid"] = 99
        self.session.async_set_variable.side_effect = set_variable
        with self.assertRaisesRegex(ValueError, "identity changed"):
            await self.apply()
        self.assertEqual(BRIDGE.marker_profile_values(self.profile), self.original)
        self.assertEqual(self.marker()["phase"], "requested")

    async def test_rechecks_profile_and_keeps_concurrent_user_change(self):
        reads = 0
        def get_profile():
            nonlocal reads
            reads += 1
            if reads == 2:
                self.profile.badge_text = "Concurrent edit"
            return copy.deepcopy(self.profile)
        self.session.async_get_profile.side_effect = get_profile
        with self.assertRaisesRegex(ValueError, "profile changed"):
            await self.apply()
        self.assertEqual(self.profile.badge_text, "Concurrent edit")
        self.assertEqual(self.marker()["phase"], "requested")

    async def test_failed_profile_readback_preserves_cleanup_provenance(self):
        self.session.async_set_profile_properties.side_effect = None
        with self.assertRaisesRegex(RuntimeError, "did not retain"):
            await self.apply()
        self.assertEqual(BRIDGE.marker_profile_values(self.profile), self.original)
        self.assertEqual(self.marker()["phase"], "requested")

    async def test_failed_ownership_readback_prevents_profile_mutation(self):
        self.session.async_set_variable.side_effect = None
        with self.assertRaisesRegex(RuntimeError, "ownership"):
            await self.apply()
        self.session.async_set_profile_properties.assert_not_awaited()

    async def test_changed_process_after_apply_restores_display(self):
        def set_profile(customization):
            vars(self.profile).update(copy.deepcopy(customization.values))
            self.variables["jobPid"] = 99
        self.session.async_set_profile_properties.side_effect = set_profile
        with self.assertRaisesRegex(ValueError, "identity changed"):
            await self.apply()
        self.assertEqual(BRIDGE.marker_profile_values(self.profile), self.original)
        self.assertEqual(self.marker()["phase"], "requested")

    async def test_failed_clear_keeps_applied_backup_for_retry(self):
        await self.apply()
        self.session.async_set_profile_properties.side_effect = None
        with self.assertRaisesRegex(RuntimeError, "did not restore"):
            await BRIDGE.clear_saved_marker(object(), self.request())
        self.assertEqual(self.marker()["phase"], "applied")

    async def test_snapshot_exports_only_bounded_marker_identity(self):
        self.profile.subtitle = "Original subtitle"
        await self.apply()
        snapshot = await BRIDGE.describe_session(self.session, observed_at="now", selected_id=None, buried=False)
        self.assertEqual(snapshot["savedMarkerConversationId"], CONVERSATION)
        self.assertEqual(snapshot["savedMarkerOwnerSessionId"], "pane-one")
        self.assertEqual(snapshot["savedMarkerState"], "applied")
        serialized = json.dumps(snapshot)
        for sensitive in ("Original badge", "Original subtitle", "subtitle", "badge_text", "Red Component", "original"):
            self.assertNotIn(sensitive, serialized)

    async def test_inherited_split_profile_is_restored_before_snapshot(self):
        await self.apply()
        self.session.session_id = "new-split"
        snapshot = await BRIDGE.describe_session(self.session, observed_at="now", selected_id=None, buried=False)
        self.assertNotIn("savedMarkerState", snapshot)
        self.assertIsNone(self.marker())
        self.assertEqual(BRIDGE.marker_profile_values(self.profile), self.original)

    async def test_inherited_clear_failure_exposes_only_owner_for_retry(self):
        await self.apply()
        self.session.session_id = "new-split"
        self.session.async_set_profile_properties.side_effect = RuntimeError("RPC error")
        snapshot = await BRIDGE.describe_session(self.session, observed_at="now", selected_id=None, buried=False)
        self.assertEqual(snapshot["savedMarkerOwnerSessionId"], "pane-one")
        self.assertNotIn("RPC error", json.dumps(snapshot))

    async def test_invalid_request_never_mutates_profile(self):
        for changes in (
            {"conversationId": "not-a-uuid"}, {"sessionId": "bad\n"}, {"cwd": "relative"},
            {"expectedJobPid": False}, {"expectedJobName": ""}, {"expectedCommandLine": None},
            {"expiresAt": BRIDGE.time.time() * 1000 - 1},
        ):
            with self.assertRaises(ValueError):
                await BRIDGE.configure_saved_marker(object(), self.request(**changes))
        self.session.async_set_profile_properties.assert_not_awaited()
        self.session.async_set_variable.assert_not_awaited()

    async def test_handler_does_not_leak_api_exception_profile_contents(self):
        self.session.async_get_profile.side_effect = RuntimeError("private badge string")
        client = BRIDGE.BridgeClient(object(), "/tmp/unused.sock", asyncio.Event())
        client.send = AsyncMock()
        await client.handle_saved_marker({**self.request(), "requestId": "one"}, clear=False)
        response = client.send.await_args.args[0]
        self.assertEqual(response["type"], "configure-saved-marker-result")
        self.assertFalse(response["ok"])
        self.assertNotIn("private", response["error"])

    async def test_handler_returns_success_after_verified_profile_write(self):
        client = BRIDGE.BridgeClient(object(), "/tmp/unused.sock", asyncio.Event())
        client.send = AsyncMock()
        await client.handle_saved_marker({**self.request(), "requestId": "one"}, clear=False)
        self.assertTrue(client.send.await_args.args[0]["ok"])
        self.assertTrue(client.changed.is_set())

    def test_invalid_marker_metadata_is_ignored(self):
        for value in (None, "", "[1]", "not json", json.dumps({"version": 1}), "x" * 65537):
            self.assertIsNone(BRIDGE.parse_saved_marker(value))
        state = {**BRIDGE.requested_saved_marker("pane-one", CONVERSATION), "phase": "applied", "original": {}, "applied": {}}
        self.assertIsNone(BRIDGE.parse_saved_marker(json.dumps(state)))

    async def test_subtitle_metadata_requires_bounded_text_in_both_profile_snapshots(self):
        await self.apply()
        valid = self.marker()
        for value in (None, True, 42, "x" * 32769):
            state = copy.deepcopy(valid)
            state["original"]["subtitle"] = value
            self.assertIsNone(BRIDGE.parse_saved_marker(json.dumps(state)))
        for snapshot in ("original", "applied"):
            state = copy.deepcopy(valid)
            del state[snapshot]["subtitle"]
            self.assertIsNone(BRIDGE.parse_saved_marker(json.dumps(state)))

    def test_restore_target_requires_boolean_saved_card_flag(self):
        target = {"conversationId": CONVERSATION, "cwd": "/tmp", "title": "Work", "savedCard": True}
        self.assertTrue(BRIDGE.validate_thread_restore_target(target)["savedCard"])
        with self.assertRaises(ValueError):
            BRIDGE.validate_thread_restore_target({**target, "savedCard": "true"})

    async def test_saved_restore_records_requested_owner_without_color_or_badge(self):
        tab = types.SimpleNamespace(current_session=self.session)
        window = types.SimpleNamespace(window_id="window-one", async_create_tab=AsyncMock(return_value=tab))
        app = types.SimpleNamespace(terminal_windows=[window])
        target = {"conversationId": CONVERSATION, "cwd": "/tmp/project", "title": "Work", "windowId": "window-one", "savedCard": True}
        with patch.object(BRIDGE, "pane_profile", return_value="customization"), patch.object(BRIDGE, "mark_auto_resume_session", AsyncMock()):
            await BRIDGE.restore_thread(app, object(), target)
        self.assertEqual(self.marker(), BRIDGE.requested_saved_marker("pane-one", CONVERSATION))
        self.session.async_set_profile_properties.assert_not_awaited()

    async def test_unsaved_restore_does_not_request_marker(self):
        tab = types.SimpleNamespace(current_session=self.session)
        window = types.SimpleNamespace(window_id="window-one", async_create_tab=AsyncMock(return_value=tab))
        app = types.SimpleNamespace(terminal_windows=[window])
        target = {"conversationId": CONVERSATION, "cwd": "/tmp/project", "title": "Work", "windowId": "window-one"}
        with patch.object(BRIDGE, "pane_profile", return_value="customization"), patch.object(BRIDGE, "mark_auto_resume_session", AsyncMock()):
            await BRIDGE.restore_thread(app, object(), target)
        self.assertIsNone(self.marker())
        self.session.async_set_variable.assert_not_awaited()

    async def test_optional_marker_failures_keep_created_restore_successful(self):
        for failure in ("write", "readback"):
            with self.subTest(failure=failure):
                tab = types.SimpleNamespace(current_session=self.session)
                window = types.SimpleNamespace(window_id="window-one", async_create_tab=AsyncMock(return_value=tab))
                app = types.SimpleNamespace(terminal_windows=[window])
                target = {"conversationId": CONVERSATION, "cwd": "/tmp/project", "title": "Work", "windowId": "window-one", "savedCard": True}
                self.session.async_set_variable.side_effect = RuntimeError("Marker write failed") if failure == "write" else None
                self.session.async_get_variable.side_effect = lambda key: None
                with patch.object(BRIDGE, "pane_profile", return_value="customization"), patch.object(BRIDGE, "mark_auto_resume_session", AsyncMock()) as mark:
                    result = await BRIDGE.restore_thread(app, object(), target)
                self.assertEqual(result, {"terminalSessionId": "pane-one", "windowId": "window-one"})
                window.async_create_tab.assert_awaited_once()
                mark.assert_awaited_once_with(self.session, target)


if __name__ == "__main__":
    unittest.main()
