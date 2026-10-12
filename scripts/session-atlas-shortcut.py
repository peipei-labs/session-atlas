#!/usr/bin/env python3
"""Install, check, or remove only Session Atlas's native iTerm2 shortcut."""

import argparse
import copy
import json

import iterm2


KEY = "0x62-0x1c0000-0xb"
BINDING = {"Action": 60, "Text": "session_atlas_park()", "Version": 2}
PREFERENCE = "GlobalKeyMap"


def same_shortcut(key):
    return isinstance(key, str) and key.split("-")[:2] == KEY.split("-")[:2]


def changed_mapping(mapping, mode):
    if not isinstance(mapping, dict):
        raise ValueError("iTerm2 GlobalKeyMap is invalid")
    updated = copy.deepcopy(mapping)
    if mode == "uninstall":
        if KEY in mapping and mapping[KEY] != BINDING:
            raise ValueError("Shortcut was changed by another owner; refusing to remove it")
        updated.pop(KEY, None)
        return updated
    for key, value in mapping.items():
        if same_shortcut(key) and (key != KEY or value != BINDING):
            raise ValueError("Control-Option-Command-B already has an unrelated binding")
    if mode == "check":
        if mapping.get(KEY) != BINDING:
            raise ValueError("Session Atlas shortcut is not installed")
    else:
        updated[KEY] = dict(BINDING)
    return updated


async def read_mapping(connection):
    response = await iterm2.rpc.async_get_preference(connection, PREFERENCE)
    value = response.preferences_response.results[0].get_preference_result.json_value
    return json.loads(value) if value else {}


async def run(connection, mode):
    if mode != "uninstall":
        profiles = await iterm2.PartialProfile.async_query(connection)
        for partial in profiles:
            profile = await partial.async_get_full_profile()
            for key, value in (profile.key_mappings or {}).items():
                if same_shortcut(key) and (key != KEY or value != BINDING):
                    raise ValueError("An iTerm2 profile overrides Control-Option-Command-B; leaving all bindings unchanged")
    original = await read_mapping(connection)
    updated = changed_mapping(original, mode)
    if updated != original:
        if await read_mapping(connection) != original:
            raise ValueError("iTerm2 key bindings changed while checking; retry the installer")
        response = await iterm2.rpc.async_set_preference(connection, PREFERENCE, json.dumps(updated))
        result = response.preferences_response.results[0].set_preference_result
        if result.status != iterm2.api_pb2.PreferencesResponse.Result.SetPreferenceResult.Status.Value("OK"):
            raise RuntimeError("iTerm2 did not accept the shortcut update")
    if await read_mapping(connection) != updated:
        raise RuntimeError("iTerm2 did not retain the exact shortcut update")
    print(f"session-atlas-shortcut-{mode}-ok")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("install", "check", "uninstall"))
    args = parser.parse_args()

    async def main(connection):
        await run(connection, args.mode)

    iterm2.run_until_complete(main)
