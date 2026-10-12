#!/usr/bin/env python3

"""iTerm2 inventory and recovery bridge for Session Atlas.

The only commands accepted from the controller are exact session-id focus,
validated recovery requests, session-local restart and saved-card profiles, and an
explicit saved-thread close request for an unchanged, uniquely linked pane.
It never injects input, reads screen contents, or directly terminates processes.
"""

import asyncio
import contextlib
import datetime
import fcntl
import json
import os
import re
import shlex
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

import iterm2


PROTOCOL_VERSION = 14
BRIDGE_VERSION = "0.16.0"
SNAPSHOT_HEARTBEAT_SECONDS = 15
SNAPSHOT_MIN_INTERVAL_SECONDS = 2
RECONNECT_MAX_SECONDS = 30
FOCUS_REQUEST_TIMEOUT_SECONDS = 3
FOCUS_RESPONSE_MARGIN_SECONDS = 0.05
BRIDGE_RESTART_DELAY_SECONDS = 5
MAX_COMMAND_BYTES = 1024 * 1024
AUTO_RESUME_VARIABLE = "user.sessionAtlasConversationId"
AUTO_RESUME_ORIGINAL_CLOSE_VARIABLE = "user.sessionAtlasOriginalCloseSessionsOnEnd"
SAVED_MARKER_VARIABLE = "user.sessionAtlasSavedMarker"
SAVED_MARKER_SUBTITLE = "Atlas · 已保留"
SAVED_MARKER_COLOR = (126, 87, 194)
SAVED_MARKER_COLOR_SUFFIXES = ("", "_light", "_dark")
MONITORED_VARIABLES = ("jobPid", "path", "name", "profileName", AUTO_RESUME_VARIABLE, SAVED_MARKER_VARIABLE)
CODEX_SESSION_ID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
IDLE_SHELLS = {"bash", "dash", "fish", "nu", "sh", "tcsh", "zsh"}
ITERM_SPINNER_PREFIX = re.compile(r"^\s*[\u2800-\u28ff]\s*")


class PartialRestoreError(RuntimeError):
    def __init__(self, message: str, created_window_id: Optional[str] = None):
        super().__init__(message)
        self.created_window_id = created_window_id


def utc_now() -> str:
    return (
        datetime.datetime.now(datetime.timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def default_socket_path() -> str:
    configured = os.environ.get("SESSION_ATLAS_BRIDGE_SOCKET")
    if configured:
        return os.path.abspath(os.path.expanduser(configured))
    return os.path.expanduser(
        "~/Library/Application Support/SessionAtlas/bridge.sock"
    )


def default_process_lock_path() -> str:
    configured = os.environ.get("SESSION_ATLAS_BRIDGE_LOCK")
    if configured:
        return os.path.abspath(os.path.expanduser(configured))
    return os.path.expanduser(
        "~/Library/Application Support/SessionAtlas/iterm-bridge.lock"
    )


def acquire_process_lock(path: Optional[str] = None) -> int:
    """Hold a per-user lock for this process without deleting any lock file."""
    lock_path = path or default_process_lock_path()
    lock_directory = os.path.dirname(lock_path)
    os.makedirs(lock_directory, mode=0o700, exist_ok=True)
    descriptor = os.open(
        lock_path,
        os.O_RDWR | os.O_CREAT | getattr(os, "O_CLOEXEC", 0),
        0o600,
    )
    try:
        os.fchmod(descriptor, 0o600)
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except Exception:
        os.close(descriptor)
        raise
    return descriptor


def optional_string(value: Any) -> Optional[str]:
    return value if isinstance(value, str) and value else None


def optional_pid(value: Any) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, int) and value > 0:
        return value
    if isinstance(value, str):
        try:
            parsed = int(value)
        except ValueError:
            return None
        return parsed if parsed > 0 else None
    return None


def optional_port(value: Any) -> Optional[int]:
    port = optional_pid(value)
    return port if port is not None and port <= 65535 else None


def optional_codex_session_id(value: Any) -> Optional[str]:
    value = optional_string(value)
    if value is None or CODEX_SESSION_ID.fullmatch(value) is None:
        return None
    return value


def stable_monitored_value(variable_name: str, value: Any) -> Any:
    if variable_name == "name" and isinstance(value, str):
        return ITERM_SPINNER_PREFIX.sub("", value).strip()
    return value


def visible_sessions(
    app: Any,
) -> Iterable[Tuple[Any, str, str, int, int, int, int, int, bool, List[Dict[str, Any]]]]:
    current_window = app.current_terminal_window
    current_window_id = (
        current_window.window_id if current_window is not None else None
    )
    for window_index, window in enumerate(app.terminal_windows, start=1):
        tabs = window.tabs
        tab_count = len(tabs)
        for tab_index, tab in enumerate(tabs, start=1):
            sessions = tab.sessions
            pane_count = len(sessions)
            paths = split_paths(tab.root)
            for pane_index, session in enumerate(sessions, start=1):
                yield (
                    session,
                    window.window_id,
                    tab.tab_id,
                    window_index,
                    tab_index,
                    pane_index,
                    tab_count,
                    pane_count,
                    window.window_id == current_window_id,
                    paths.get(session.session_id, []),
                )


def split_paths(root: Any) -> Dict[str, List[Dict[str, Any]]]:
    result: Dict[str, List[Dict[str, Any]]] = {}

    def visit(node: Any, path: List[Dict[str, Any]]) -> None:
        for index, child in enumerate(getattr(node, "children", [])):
            step = {"vertical": bool(getattr(node, "vertical", False)), "index": index}
            next_path = [*path, step]
            session_id = getattr(child, "session_id", None)
            if isinstance(session_id, str) and session_id:
                result[session_id] = next_path
            else:
                visit(child, next_path)

    visit(root, [])
    return result


def selected_session_id(app: Any) -> Optional[str]:
    window = app.current_terminal_window
    if window is None or window.current_tab is None:
        return None
    session = window.current_tab.current_session
    return session.session_id if session is not None else None


def find_exact_session(app: Any, session_id: str) -> Optional[Any]:
    for session, *_ in visible_sessions(app):
        if session.session_id == session_id:
            return session
    for session in app.buried_sessions:
        if session.session_id == session_id:
            return session
    return None


async def read_variables(session: Any) -> Dict[str, Any]:
    names = (
        "name",
        "path",
        "tty",
        "jobName",
        "jobPid",
        "commandLine",
        "profileName",
        AUTO_RESUME_VARIABLE,
        SAVED_MARKER_VARIABLE,
    )
    values = await asyncio.gather(
        *(session.async_get_variable(name) for name in names),
        return_exceptions=True,
    )
    result: Dict[str, Any] = {}
    for name, value in zip(names, values):
        if not isinstance(value, BaseException):
            result[name] = value
    return result


async def describe_session(
    session: Any,
    *,
    observed_at: str,
    selected_id: Optional[str],
    buried: bool,
    window_id: Optional[str] = None,
    tab_id: Optional[str] = None,
    window_index: Optional[int] = None,
    tab_index: Optional[int] = None,
    pane_index: Optional[int] = None,
    tab_count: Optional[int] = None,
    pane_count: Optional[int] = None,
    current_window: Optional[bool] = None,
    split_path: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    variables = await read_variables(session)
    saved_marker = parse_saved_marker(variables.get(SAVED_MARKER_VARIABLE))
    if saved_marker is not None and saved_marker["ownerSessionId"] != session.session_id:
        try:
            await clear_session_saved_marker(session, saved_marker, forget=True)
            saved_marker = None
        except Exception:
            # Keep only ownership in inventory so the controller can retry cleanup.
            pass
    cwd = optional_string(variables.get("path")) or ""
    auto_resume_conversation_id = optional_codex_session_id(
        variables.get(AUTO_RESUME_VARIABLE)
    )
    auto_resume_kind = "marker" if auto_resume_conversation_id else None
    auto_resume_controller_port = None
    try:
        inferred = profile_auto_resume_details(await session.async_get_profile(), cwd)
    except Exception:  # Profile reads can race with a closing session.
        inferred = None
    if inferred is not None:
        (
            auto_resume_conversation_id,
            auto_resume_kind,
            auto_resume_controller_port,
        ) = inferred
    item: Dict[str, Any] = {
        "sessionId": session.session_id,
        "name": optional_string(variables.get("name")) or "iTerm session",
        "cwd": cwd,
        "focused": not buried and session.session_id == selected_id,
        "buried": buried,
        "observedAt": observed_at,
    }

    optional_fields = {
        "windowId": window_id,
        "tabId": tab_id,
        "windowIndex": window_index,
        "tabIndex": tab_index,
        "paneIndex": pane_index,
        "tabCount": tab_count,
        "paneCount": pane_count,
        "currentWindow": current_window,
        "tty": optional_string(variables.get("tty")),
        "jobName": optional_string(variables.get("jobName")),
        "jobPid": optional_pid(variables.get("jobPid")),
        "commandLine": optional_string(variables.get("commandLine")),
        "profileName": optional_string(variables.get("profileName")),
        "autoResumeConversationId": auto_resume_conversation_id,
        "autoResumeKind": auto_resume_kind,
        "autoResumeControllerPort": auto_resume_controller_port,
        "savedMarkerConversationId": saved_marker["conversationId"] if saved_marker else None,
        "savedMarkerOwnerSessionId": saved_marker["ownerSessionId"] if saved_marker else None,
        "savedMarkerState": ("requested" if saved_marker_needs_configuration(saved_marker) else saved_marker["phase"]) if saved_marker else None,
        "splitPath": split_path,
    }
    item.update({key: value for key, value in optional_fields.items() if value is not None})
    return item


async def build_snapshot(app: Any) -> Dict[str, Any]:
    observed_at = utc_now()
    selected_id = selected_session_id(app)
    work = []
    seen: Set[str] = set()

    for (
        session,
        window_id,
        tab_id,
        window_index,
        tab_index,
        pane_index,
        tab_count,
        pane_count,
        current_window,
        split_path,
    ) in visible_sessions(app):
        if session.session_id in seen:
            continue
        seen.add(session.session_id)
        work.append(
            describe_session(
                session,
                observed_at=observed_at,
                selected_id=selected_id,
                buried=False,
                window_id=window_id,
                tab_id=tab_id,
                window_index=window_index,
                tab_index=tab_index,
                pane_index=pane_index,
                tab_count=tab_count,
                pane_count=pane_count,
                current_window=current_window,
                split_path=split_path,
            )
        )

    for session in app.buried_sessions:
        if session.session_id in seen:
            continue
        seen.add(session.session_id)
        work.append(
            describe_session(
                session,
                observed_at=observed_at,
                selected_id=selected_id,
                buried=True,
            )
        )

    sessions = await asyncio.gather(*work) if work else []
    sessions.sort(
        key=lambda item: (
            item["buried"],
            item.get("windowIndex", 0),
            item.get("tabIndex", 0),
            item.get("paneIndex", 0),
        )
    )
    return {
        "type": "snapshot",
        "protocol": PROTOCOL_VERSION,
        "observedAt": observed_at,
        "sessions": sessions,
    }


def validate_restore_layout(value: Any) -> Dict[str, Any]:
    if not isinstance(value, dict) or value.get("status") != "closed":
        raise ValueError("Only a closed window layout can be restored")
    tabs = value.get("tabs")
    if not isinstance(tabs, list) or not tabs or len(tabs) > 64:
        raise ValueError("Window layout must contain between 1 and 64 tabs")
    sanitized_tabs = []
    for tab in tabs:
        if not isinstance(tab, dict):
            raise ValueError("Window layout contains an invalid tab")
        panes = tab.get("panes")
        if not isinstance(panes, list) or not panes or len(panes) > 128:
            raise ValueError("Each restored tab must contain between 1 and 128 panes")
        sanitized_panes = []
        for pane in panes:
            if not isinstance(pane, dict):
                raise ValueError("Window layout contains an invalid pane")
            cwd = pane.get("cwd")
            title = pane.get("title")
            profile_name = pane.get("profileName")
            conversation_id = pane.get("conversationId")
            split_path = pane.get("splitPath")
            if not isinstance(cwd, str) or "\x00" in cwd or (cwd and not os.path.isabs(cwd)):
                raise ValueError("Restored pane cwd must be an absolute path")
            if not isinstance(title, str) or not title or len(title) > 4096:
                raise ValueError("Restored pane title is invalid")
            if profile_name is not None and (
                not isinstance(profile_name, str) or len(profile_name) > 512
            ):
                raise ValueError("Restored pane profile is invalid")
            if conversation_id is not None and (
                not isinstance(conversation_id, str)
                or CODEX_SESSION_ID.fullmatch(conversation_id) is None
            ):
                raise ValueError("Restored Codex session id is invalid")
            if not isinstance(split_path, list) or not split_path or len(split_path) > 32:
                raise ValueError("Restored pane split path is invalid")
            sanitized_path = []
            for step in split_path:
                if (
                    not isinstance(step, dict)
                    or set(step) != {"vertical", "index"}
                    or not isinstance(step.get("vertical"), bool)
                    or isinstance(step.get("index"), bool)
                    or not isinstance(step.get("index"), int)
                    or not 0 <= step["index"] < 128
                ):
                    raise ValueError("Restored pane split path is invalid")
                sanitized_path.append(
                    {"vertical": step["vertical"], "index": step["index"]}
                )
            sanitized_panes.append(
                {
                    "title": title,
                    "cwd": cwd,
                    "profileName": profile_name,
                    "conversationId": conversation_id,
                    "splitPath": sanitized_path,
                }
            )
        sanitized_tabs.append(
            {
                "tabIndex": tab.get("tabIndex")
                if isinstance(tab.get("tabIndex"), int)
                else len(sanitized_tabs) + 1,
                "panes": sanitized_panes,
            }
        )
    sanitized_tabs.sort(key=lambda tab: tab["tabIndex"])
    return {"tabs": sanitized_tabs}


def validate_recovery_targets(value: Any) -> List[Dict[str, Any]]:
    if not isinstance(value, list) or not value or len(value) > 32:
        raise ValueError("Recovery batch must contain between 1 and 32 sessions")
    sanitized = []
    seen_sessions: Set[str] = set()
    seen_conversations: Set[str] = set()
    for target in value:
        if not isinstance(target, dict):
            raise ValueError("Recovery batch contains an invalid target")
        session_id = optional_string(target.get("targetSessionId"))
        cwd = optional_string(target.get("cwd"))
        expected_cwd = optional_string(target.get("expectedPlaceholderCwd", cwd))
        conversation_id = optional_codex_session_id(target.get("conversationId"))
        title = optional_string(target.get("title"))
        profile_name = target.get("profileName")
        split_vertical = target.get("splitVertical")
        if (
            session_id is None
            or len(session_id) > 512
            or "\n" in session_id
            or "\r" in session_id
            or session_id in seen_sessions
        ):
            raise ValueError("Recovery target iTerm session id is invalid")
        if cwd is None or "\x00" in cwd or not os.path.isabs(cwd):
            raise ValueError("Recovery target cwd must be absolute")
        if expected_cwd is None or "\x00" in expected_cwd or not os.path.isabs(expected_cwd):
            raise ValueError("Recovery placeholder cwd must be absolute")
        if conversation_id is None or conversation_id in seen_conversations:
            raise ValueError("Recovery target Codex session id is invalid")
        if title is None or len(title) > 4096:
            raise ValueError("Recovery target title is invalid")
        if profile_name is not None and (
            not isinstance(profile_name, str) or len(profile_name) > 512
        ):
            raise ValueError("Recovery target profile is invalid")
        if not isinstance(split_vertical, bool):
            raise ValueError("Recovery target split orientation is invalid")
        seen_sessions.add(session_id)
        seen_conversations.add(conversation_id)
        sanitized.append(
            {
                "targetSessionId": session_id,
                "cwd": cwd,
                "expectedPlaceholderCwd": expected_cwd,
                "conversationId": conversation_id,
                "title": title,
                "profileName": profile_name,
                "splitVertical": split_vertical,
            }
        )
    return sanitized


def build_split_tree(panes: List[Dict[str, Any]]) -> Dict[str, Any]:
    root: Optional[Dict[str, Any]] = None
    for pane in panes:
        path = pane["splitPath"]
        if root is None:
            root = {"vertical": path[0]["vertical"], "children": {}}
        node = root
        for depth, step in enumerate(path):
            if node["vertical"] != step["vertical"]:
                raise ValueError("Split paths disagree about pane orientation")
            index = step["index"]
            last = depth == len(path) - 1
            existing = node["children"].get(index)
            if last:
                if existing is not None:
                    raise ValueError("Split paths contain duplicate panes")
                node["children"][index] = pane
                continue
            if existing is None:
                existing = {
                    "vertical": path[depth + 1]["vertical"],
                    "children": {},
                }
                node["children"][index] = existing
            if "children" not in existing:
                raise ValueError("Split paths contain a pane/tree conflict")
            node = existing
    if root is None:
        raise ValueError("Cannot restore an empty split tree")

    def normalize(node: Dict[str, Any]) -> Dict[str, Any]:
        indices = sorted(node["children"])
        if indices != list(range(len(indices))):
            raise ValueError("Split path child indices must be contiguous")
        children = []
        for index in indices:
            child = node["children"][index]
            children.append(normalize(child) if "children" in child else child)
        return {"vertical": node["vertical"], "children": children}

    return normalize(root)


def first_pane(node: Dict[str, Any]) -> Dict[str, Any]:
    current = node
    while "children" in current:
        current = current["children"][0]
    return current


def auto_resume_helper_path() -> str:
    return os.path.abspath(
        os.path.join(
            os.path.dirname(os.path.realpath(__file__)),
            "..",
            "scripts",
            "session-atlas-resume.zsh",
        )
    )


def auto_resume_command(
    cwd: str, conversation_id: str, controller_port: int = 4317
) -> str:
    if optional_port(controller_port) is None:
        raise ValueError("Session Atlas controller port is invalid")
    helper = auto_resume_helper_path()
    return " ".join(
        (
            shlex.quote(helper),
            "--cwd",
            shlex.quote(cwd),
            "--session-id",
            shlex.quote(conversation_id),
            "--controller-port",
            str(controller_port),
        )
    )


def profile_auto_resume_details(
    profile: Any, cwd: str
) -> Optional[Tuple[str, str, Optional[int]]]:
    if getattr(profile, "use_custom_command", None) != "Yes":
        return None
    command = getattr(profile, "command", None)
    if not isinstance(command, str):
        return None
    try:
        parts = shlex.split(command)
    except ValueError:
        return None
    if (
        len(parts) in (5, 7)
        and parts[0] == auto_resume_helper_path()
        and parts[1] == "--cwd"
        and os.path.isabs(parts[2])
        and parts[3] == "--session-id"
        and (
            len(parts) == 5
            or (parts[5] == "--controller-port" and optional_port(parts[6]) is not None)
        )
    ):
        conversation_id = optional_codex_session_id(parts[4])
        controller_port = optional_port(parts[6]) if len(parts) == 7 else 4317
        return (
            (conversation_id, "helper", controller_port)
            if conversation_id
            else None
        )
    if (
        len(parts) == 5
        and os.path.basename(parts[0]) == "codex"
        and parts[1:3] == ["resume", "-C"]
        and parts[3] == cwd
    ):
        conversation_id = optional_codex_session_id(parts[4])
        return (conversation_id, "legacy", None) if conversation_id else None
    return None


def profile_auto_resume_identity(
    profile: Any, cwd: str
) -> Optional[Tuple[str, str]]:
    details = profile_auto_resume_details(profile, cwd)
    return details[:2] if details is not None else None


def is_legacy_auto_resume_command(
    profile: Any, cwd: str, conversation_id: str
) -> bool:
    return profile_auto_resume_identity(profile, cwd) == (
        conversation_id,
        "legacy",
    )


def apply_auto_resume_profile(
    profile: Any,
    cwd: str,
    conversation_id: str,
    controller_port: int = 4317,
    *,
    configure_directory: bool = True,
) -> str:
    helper = auto_resume_helper_path()
    if not os.path.isfile(helper) or not os.access(helper, os.X_OK):
        raise RuntimeError("Session Atlas resume helper is unavailable")
    command = auto_resume_command(cwd, conversation_id, controller_port)
    if configure_directory:
        profile.set_initial_directory_mode(
            iterm2.InitialWorkingDirectory.INITIAL_WORKING_DIRECTORY_CUSTOM
        )
        profile.set_custom_directory(cwd)
        profile.set_close_sessions_on_end(True)
    profile.set_use_custom_command("Yes")
    profile.set_command(command)
    return command


def pane_profile(pane: Dict[str, Any], controller_port: int = 4317) -> Any:
    profile = iterm2.LocalWriteOnlyProfile()
    cwd = pane["cwd"]
    if cwd:
        profile.set_initial_directory_mode(
            iterm2.InitialWorkingDirectory.INITIAL_WORKING_DIRECTORY_CUSTOM
        )
        profile.set_custom_directory(cwd)
    profile.set_name(pane["title"])
    conversation_id = pane.get("conversationId")
    if conversation_id:
        apply_auto_resume_profile(profile, cwd, conversation_id, controller_port)
    else:
        profile.set_use_custom_command("No")
    return profile


async def mark_auto_resume_session(session: Any, pane: Dict[str, Any]) -> None:
    conversation_id = pane.get("conversationId")
    if conversation_id:
        await session.async_set_variable(AUTO_RESUME_VARIABLE, conversation_id)


async def restore_split_tree(
    base_session: Any, node: Dict[str, Any], controller_port: int = 4317
) -> List[Tuple[Any, Dict[str, Any]]]:
    children = node["children"]
    sessions = [base_session]
    for child in children[1:]:
        pane = first_pane(child) if "children" in child else child
        sessions.append(
            await sessions[-1].async_split_pane(
                vertical=node["vertical"],
                profile=pane.get("profileName"),
                profile_customizations=pane_profile(pane, controller_port),
            )
        )
    restored: List[Tuple[Any, Dict[str, Any]]] = []
    for child, session in zip(children, sessions):
        if "children" in child:
            restored.extend(await restore_split_tree(session, child, controller_port))
        else:
            restored.append((session, child))
    return restored


async def restore_layout(
    connection: Any, raw_layout: Any, controller_port: int = 4317
) -> Optional[str]:
    layout = validate_restore_layout(raw_layout)
    prepared_tabs = [
        (tab, build_split_tree(tab["panes"])) for tab in layout["tabs"]
    ]
    _, first_tree = prepared_tabs[0]
    first = first_pane(first_tree)
    first_profile = pane_profile(first, controller_port)
    window = None
    side_effect_started = False
    try:
        side_effect_started = True
        window = await iterm2.Window.async_create(
            connection,
            profile=first.get("profileName"),
            profile_customizations=first_profile,
        )
        if (
            window is None
            or window.current_tab is None
            or window.current_tab.current_session is None
        ):
            raise RuntimeError("iTerm2 did not keep the restored window open")
        restored_sessions = await restore_split_tree(
            window.current_tab.current_session, first_tree, controller_port
        )
        for tab, tree in prepared_tabs[1:]:
            pane = first_pane(tree)
            restored_tab = await window.async_create_tab(
                profile=pane.get("profileName"),
                index=max(0, tab["tabIndex"] - 1),
                profile_customizations=pane_profile(pane, controller_port),
            )
            if restored_tab is None or restored_tab.current_session is None:
                raise RuntimeError("iTerm2 did not keep a restored tab open")
            restored_sessions.extend(
                await restore_split_tree(
                    restored_tab.current_session, tree, controller_port
                )
            )
        await asyncio.gather(
            *(mark_auto_resume_session(session, pane) for session, pane in restored_sessions)
        )
    except Exception as error:
        if side_effect_started:
            created_window_id = optional_string(getattr(window, "window_id", None))
            raise PartialRestoreError(
                "iTerm2 may have created only part of the requested window",
                created_window_id,
            ) from error
        raise
    return optional_string(getattr(window, "window_id", None))


async def restore_recoveries_in_place(
    app: Any, raw_targets: Any, controller_port: int = 4317
) -> None:
    targets = validate_recovery_targets(raw_targets)
    visible_by_id = {
        session.session_id: session for session, *_ in visible_sessions(app)
    }
    prepared = []
    for target in targets:
        placeholder = visible_by_id.get(target["targetSessionId"])
        if placeholder is None:
            raise ValueError("Recovery target is no longer a visible iTerm pane")
        await validate_recovery_placeholder(placeholder, target)
        prepared.append((placeholder, target))

    side_effect_started = False
    try:
        for placeholder, target in prepared:
            await validate_recovery_placeholder(placeholder, target)
            side_effect_started = True
            restored = await placeholder.async_split_pane(
                vertical=target["splitVertical"],
                before=True,
                profile=target.get("profileName"),
                profile_customizations=pane_profile(target, controller_port),
            )
            if restored is None:
                raise RuntimeError("iTerm2 did not keep the recovered session open")
            await mark_auto_resume_session(restored, target)
            await validate_recovery_placeholder(placeholder, target)
            await placeholder.async_set_buried(True)
    except Exception as error:
        if side_effect_started:
            raise PartialRestoreError(
                "iTerm2 may have recovered only part of the requested sessions"
            ) from error
        raise


async def validate_recovery_placeholder(session: Any, target: Dict[str, Any]) -> None:
    variables = await read_variables(session)
    expected_cwd = target.get("expectedPlaceholderCwd", target["cwd"])
    if optional_string(variables.get("path")) != expected_cwd:
        raise ValueError("Recovery target cwd changed")
    job_name = (optional_string(variables.get("jobName")) or "").lower()
    if job_name not in IDLE_SHELLS:
        raise ValueError("Recovery target is no longer an idle shell")


def validate_auto_resume_request(
    value: Any,
) -> Tuple[str, str, str, int, int, str, str]:
    if not isinstance(value, dict):
        raise ValueError("Automatic recovery request is invalid")
    session_id = optional_string(value.get("sessionId"))
    cwd = optional_string(value.get("cwd"))
    conversation_id = optional_codex_session_id(value.get("conversationId"))
    controller_port = optional_port(value.get("controllerPort"))
    expected_job_pid = optional_pid(value.get("expectedJobPid"))
    expected_job_name = optional_string(value.get("expectedJobName"))
    expected_command_line = optional_string(value.get("expectedCommandLine"))
    if session_id is None or len(session_id) > 512 or "\n" in session_id or "\r" in session_id:
        raise ValueError("Automatic recovery iTerm session id is invalid")
    if cwd is None or "\x00" in cwd or not os.path.isabs(cwd):
        raise ValueError("Automatic recovery cwd must be absolute")
    if conversation_id is None:
        raise ValueError("Automatic recovery Codex session id is invalid")
    if controller_port is None:
        raise ValueError("Automatic recovery controller port is invalid")
    if expected_job_pid is None or expected_job_name is None or expected_command_line is None:
        raise ValueError("Automatic recovery process identity is invalid")
    return session_id, cwd, conversation_id, controller_port, expected_job_pid, expected_job_name, expected_command_line


async def configure_auto_resume(app: Any, raw_request: Any) -> None:
    session_id, cwd, conversation_id, controller_port, expected_pid, expected_name, expected_command = validate_auto_resume_request(raw_request)
    session = find_exact_session(app, session_id)
    if session is None:
        raise ValueError("Automatic recovery target no longer exists")

    variables = await read_variables(session)
    if optional_string(variables.get("path")) != cwd:
        raise ValueError("Automatic recovery target cwd changed")
    if (
        optional_pid(variables.get("jobPid")) != expected_pid
        or optional_string(variables.get("jobName")) != expected_name
        or optional_string(variables.get("commandLine")) != expected_command
    ):
        raise ValueError("Automatic recovery target process identity changed")
    expected_command = auto_resume_command(cwd, conversation_id, controller_port)
    current_profile = await session.async_get_profile()
    current_identity = profile_auto_resume_identity(current_profile, cwd)
    owns_existing_profile = (
        optional_codex_session_id(variables.get(AUTO_RESUME_VARIABLE))
        == conversation_id
        and current_identity is not None
        and current_identity[0] == conversation_id
    )
    if (
        current_profile.use_custom_command == "Yes"
        and current_profile.command != expected_command
        and not owns_existing_profile
    ):
        raise ValueError("Automatic recovery will not replace an unrelated custom command")

    customization = iterm2.LocalWriteOnlyProfile()
    apply_auto_resume_profile(
        customization,
        cwd,
        conversation_id,
        controller_port,
        configure_directory=False,
    )
    await session.async_set_profile_properties(customization)
    await session.async_set_variable(AUTO_RESUME_VARIABLE, conversation_id)

    verified = await session.async_get_profile()
    if verified.use_custom_command != "Yes" or verified.command != expected_command:
        raise RuntimeError("iTerm2 did not retain the automatic recovery profile")


def validate_clear_auto_resume_request(value: Any) -> Tuple[str, str]:
    if not isinstance(value, dict):
        raise ValueError("Automatic recovery clear request is invalid")
    session_id = optional_string(value.get("sessionId"))
    conversation_id = optional_codex_session_id(value.get("conversationId"))
    if (
        session_id is None
        or len(session_id) > 512
        or "\n" in session_id
        or "\r" in session_id
    ):
        raise ValueError("Automatic recovery iTerm session id is invalid")
    if conversation_id is None:
        raise ValueError("Automatic recovery Codex session id is invalid")
    return session_id, conversation_id


def is_our_auto_resume_command(command: Any, conversation_id: str) -> bool:
    if not isinstance(command, str):
        return False
    try:
        parts = shlex.split(command)
    except ValueError:
        return False
    return (
        len(parts) in (5, 7)
        and parts[0] == auto_resume_helper_path()
        and parts[1] == "--cwd"
        and os.path.isabs(parts[2])
        and parts[3] == "--session-id"
        and parts[4] == conversation_id
        and (
            len(parts) == 5
            or (parts[5] == "--controller-port" and optional_port(parts[6]) is not None)
        )
    )


async def clear_auto_resume(app: Any, raw_request: Any) -> None:
    session_id, conversation_id = validate_clear_auto_resume_request(raw_request)
    session = find_exact_session(app, session_id)
    if session is None:
        raise ValueError("Automatic recovery target no longer exists")
    marker = optional_codex_session_id(
        await session.async_get_variable(AUTO_RESUME_VARIABLE)
    )
    current_profile = await session.async_get_profile()
    owns_profile = (
        current_profile.use_custom_command == "Yes"
        and is_our_auto_resume_command(current_profile.command, conversation_id)
    )
    if marker != conversation_id and not owns_profile:
        raise ValueError("Automatic recovery identity changed")

    if owns_profile:
        customization = iterm2.LocalWriteOnlyProfile()
        customization.set_use_custom_command("No")
        await session.async_set_profile_properties(customization)

    await session.async_set_variable(AUTO_RESUME_VARIABLE, "")
    await session.async_set_variable(AUTO_RESUME_ORIGINAL_CLOSE_VARIABLE, "")


def parse_saved_marker(value: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(value, str) or not value or len(value) > 65536:
        return None
    try:
        marker = json.loads(value)
    except (ValueError, TypeError):
        return None
    if (
        not isinstance(marker, dict)
        or marker.get("version") != 1
        or marker.get("phase") not in ("requested", "applied")
        or optional_codex_session_id(marker.get("conversationId")) is None
        or not isinstance(marker.get("ownerSessionId"), str)
        or not 0 < len(marker["ownerSessionId"]) <= 512
        or any(c in marker["ownerSessionId"] for c in "\0\r\n")
    ):
        return None
    if marker["phase"] == "applied":
        if not all(valid_marker_profile_values(marker.get(key)) for key in ("original", "applied")):
            return None
        if ("subtitle" in marker["original"]) != ("subtitle" in marker["applied"]):
            return None
    if any(key in marker and not isinstance(marker[key], bool) for key in ("verified", "restoring")):
        return None
    overrides = marker.get("overrides", [])
    if not isinstance(overrides, list) or len(overrides) > 5 or any(
        key not in ("badge_text", "subtitle", "tab_color", "tab_color_light", "tab_color_dark") for key in overrides
    ):
        return None
    return marker


def valid_marker_profile_values(value: Any) -> bool:
    if not isinstance(value, dict) or not isinstance(value.get("badge_text"), str) or len(value["badge_text"]) > 32768:
        return False
    expected = {"badge_text"}
    if "subtitle" in value:
        if not isinstance(value["subtitle"], str) or len(value["subtitle"]) > 32768:
            return False
        expected.add("subtitle")
    for suffix in SAVED_MARKER_COLOR_SUFFIXES:
        color_key, use_key = "tab_color" + suffix, "use_tab_color" + suffix
        expected.update((color_key, use_key))
        if value.get(use_key) not in (None, False, True):
            return False
        color = value.get(color_key)
        if color is not None:
            if not isinstance(color, dict):
                return False
            try:
                restored = iterm2.Color()
                restored.from_dict(color)
            except (ValueError, TypeError, KeyError):
                return False
    return set(value) == expected


def marker_profile_values(profile: Any) -> Dict[str, Any]:
    values = {"badge_text": profile.badge_text or "", "subtitle": profile.subtitle or ""}
    for suffix in SAVED_MARKER_COLOR_SUFFIXES:
        color = getattr(profile, "tab_color" + suffix)
        values["tab_color" + suffix] = color.get_dict() if color is not None else None
        use_color = getattr(profile, "use_tab_color" + suffix)
        values["use_tab_color" + suffix] = bool(use_color) if use_color in (0, 1) else use_color
    if not valid_marker_profile_values(values):
        raise ValueError("Saved-card marker profile cannot be preserved")
    return values


def marker_values_equal(left: Any, right: Any) -> bool:
    if isinstance(left, dict) and isinstance(right, dict):
        return set(left) == set(right) and all(marker_values_equal(left[key], right[key]) for key in left)
    if isinstance(left, (int, float)) and not isinstance(left, bool) and isinstance(right, (int, float)) and not isinstance(right, bool):
        return abs(left - right) < 0.000001
    return type(left) is type(right) and left == right


def saved_marker_needs_configuration(marker: Dict[str, Any]) -> bool:
    return (
        marker["phase"] == "requested"
        or marker.get("verified") is False
        or bool(marker.get("restoring"))
        or "subtitle" not in marker["applied"]
        or marker["applied"]["badge_text"] != marker["original"]["badge_text"]
    )


def set_marker_profile_values(customization: Any, values: Dict[str, Any]) -> None:
    for key, value in values.items():
        # iTerm rejects null profile writes. Absent theme values use its fallback colors.
        if value is None:
            continue
        if key.startswith("tab_color") and value is not None:
            color = iterm2.Color()
            color.from_dict(value)
            value = color
        getattr(customization, "set_" + key)(value)


def requested_saved_marker(session_id: str, conversation_id: str) -> Dict[str, Any]:
    return {"version": 1, "phase": "requested", "ownerSessionId": session_id, "conversationId": conversation_id}


async def write_saved_marker(session: Any, marker: Optional[Dict[str, Any]]) -> None:
    value = json.dumps(marker, ensure_ascii=False, separators=(",", ":")) if marker else ""
    if len(value) > 65536:
        raise ValueError("Saved-card marker profile is too large to preserve")
    await session.async_set_variable(SAVED_MARKER_VARIABLE, value)
    if await session.async_get_variable(SAVED_MARKER_VARIABLE) != value:
        raise RuntimeError("iTerm2 did not retain saved-card marker ownership")


async def clear_session_saved_marker(session: Any, marker: Dict[str, Any], *, forget: bool) -> None:
    overrides = set(marker.get("overrides", []))
    if marker["phase"] == "applied":
        current = marker_profile_values(await session.async_get_profile())
        uncertain = marker.get("verified") is False or marker.get("restoring", False)
        restore: Dict[str, Any] = {}
        for key in ("badge_text", "subtitle"):
            if key not in marker["applied"]:
                continue
            if current[key] != marker["applied"][key] and (not uncertain or current[key] != marker["original"][key]):
                overrides.add(key)
            if current[key] == marker["applied"][key]:
                restore[key] = marker["original"][key]
        for suffix in SAVED_MARKER_COLOR_SUFFIXES:
            keys = ("tab_color" + suffix, "use_tab_color" + suffix)
            if any(not marker_values_equal(current[key], marker["applied"][key]) for key in keys) and (
                not uncertain or any(not marker_values_equal(current[key], marker["original"][key]) for key in keys)
            ):
                overrides.add("tab_color" + suffix)
            if all(marker_values_equal(current[key], marker["applied"][key]) for key in keys):
                restore.update({key: marker["original"][key] for key in keys})
        restore = {key: value for key, value in restore.items()
                   if value is not None and not marker_values_equal(current[key], value)}
        # Record our restoration before the RPC so a lost acknowledgement cannot look like a user edit.
        await write_saved_marker(session, {**marker, "restoring": True, "overrides": sorted(overrides)})
        if restore:
            customization = iterm2.LocalWriteOnlyProfile()
            set_marker_profile_values(customization, restore)
            await session.async_set_profile_properties(customization)
            verified = marker_profile_values(await session.async_get_profile())
            if not all(marker_values_equal(verified[key], value) for key, value in restore.items()):
                raise RuntimeError("iTerm2 did not restore the saved-card marker profile")
    next_marker = None if forget else requested_saved_marker(session.session_id, marker["conversationId"])
    if next_marker is not None and overrides:
        next_marker["overrides"] = sorted(overrides)
    await write_saved_marker(session, next_marker)


def validate_saved_marker_request(value: Any, *, configure: bool) -> Tuple[str, str]:
    if not isinstance(value, dict):
        raise ValueError("Saved-card marker request is invalid")
    session_id, conversation_id = value.get("sessionId"), optional_codex_session_id(value.get("conversationId"))
    if not isinstance(session_id, str) or not 0 < len(session_id) <= 512 or any(c in session_id for c in "\0\r\n"):
        raise ValueError("Saved-card marker iTerm session id is invalid")
    if conversation_id is None:
        raise ValueError("Saved-card marker conversation id is invalid")
    validate_command_expiry(value.get("expiresAt"))
    if configure:
        cwd = value.get("cwd")
        if not isinstance(cwd, str) or not os.path.isabs(cwd) or any(c in cwd for c in "\0\r\n"):
            raise ValueError("Saved-card marker cwd is invalid")
        if optional_pid(value.get("expectedJobPid")) is None or not all(optional_string(value.get(key)) for key in ("expectedJobName", "expectedCommandLine")):
            raise ValueError("Saved-card marker process identity is invalid")
    elif "forget" in value and not isinstance(value["forget"], bool):
        raise ValueError("Saved-card marker clear mode is invalid")
    return session_id, conversation_id


def check_saved_marker_identity(variables: Dict[str, Any], request: Dict[str, Any]) -> None:
    if (
        variables.get("path") != request["cwd"]
        or optional_pid(variables.get("jobPid")) != optional_pid(request["expectedJobPid"])
        or variables.get("jobName") != request["expectedJobName"]
        or variables.get("commandLine") != request["expectedCommandLine"]
    ):
        raise ValueError("Saved-card marker target identity changed")


async def configure_saved_marker(app: Any, request: Any) -> None:
    session_id, conversation_id = validate_saved_marker_request(request, configure=True)
    session = find_exact_session(app, session_id)
    if session is None:
        raise ValueError("Saved-card marker target no longer exists")
    variables = await read_variables(session)
    check_saved_marker_identity(variables, request)
    current = parse_saved_marker(variables.get(SAVED_MARKER_VARIABLE))
    if current is not None:
        if current["ownerSessionId"] != session_id or current["conversationId"] != conversation_id:
            raise ValueError("Saved-card marker ownership changed")
        if current["phase"] == "applied":
            if not saved_marker_needs_configuration(current):
                # Repeated reconciliation must not repaint a user's later override.
                return
            await clear_session_saved_marker(session, current, forget=False)
            variables = await read_variables(session)
            check_saved_marker_identity(variables, request)
            current = parse_saved_marker(variables.get(SAVED_MARKER_VARIABLE))
    original = marker_profile_values(await session.async_get_profile())
    applied = dict(original)
    overrides = current.get("overrides", []) if current else []
    if "subtitle" not in overrides:
        applied["subtitle"] = original["subtitle"] + (" · " if original["subtitle"] else "") + SAVED_MARKER_SUBTITLE
    color = iterm2.Color(*SAVED_MARKER_COLOR).get_dict()
    for suffix in SAVED_MARKER_COLOR_SUFFIXES:
        if "tab_color" + suffix in overrides:
            continue
        if original["tab_color" + suffix] is not None:
            applied["tab_color" + suffix] = color
        if original["use_tab_color" + suffix] is not None:
            applied["use_tab_color" + suffix] = True
    if not valid_marker_profile_values(applied):
        raise ValueError("Saved-card marker text is too large to preserve")
    marker = {**requested_saved_marker(session_id, conversation_id), "phase": "applied", "verified": False, "original": original, "applied": applied}
    if overrides:
        marker["overrides"] = overrides
    latest = await read_variables(session)
    check_saved_marker_identity(latest, request)
    if latest.get(SAVED_MARKER_VARIABLE) != variables.get(SAVED_MARKER_VARIABLE):
        raise ValueError("Saved-card marker ownership changed during validation")
    validate_command_expiry(request.get("expiresAt"))
    try:
        await write_saved_marker(session, marker)
        latest_profile = marker_profile_values(await session.async_get_profile())
        if not marker_values_equal(latest_profile, original):
            raise ValueError("Saved-card marker profile changed during validation")
        check_saved_marker_identity(await read_variables(session), request)
        validate_command_expiry(request.get("expiresAt"))
        customization = iterm2.LocalWriteOnlyProfile()
        set_marker_profile_values(customization, {key: value for key, value in applied.items() if key != "badge_text"})
        await session.async_set_profile_properties(customization)
        verified = marker_profile_values(await session.async_get_profile())
        if not marker_values_equal(verified, applied):
            raise RuntimeError("iTerm2 did not retain the saved-card marker profile")
        check_saved_marker_identity(await read_variables(session), request)
        await write_saved_marker(session, {**marker, "verified": True})
    except Exception:
        with contextlib.suppress(Exception):
            await clear_session_saved_marker(session, marker, forget=False)
        raise


async def clear_saved_marker(app: Any, request: Any) -> None:
    session_id, conversation_id = validate_saved_marker_request(request, configure=False)
    session = find_exact_session(app, session_id)
    if session is None:
        raise ValueError("Saved-card marker target no longer exists")
    marker = parse_saved_marker(await session.async_get_variable(SAVED_MARKER_VARIABLE))
    if marker is None:
        return
    if marker["conversationId"] != conversation_id:
        raise ValueError("Saved-card marker ownership changed")
    await clear_session_saved_marker(session, marker, forget=request.get("forget", True))


def validate_command_expiry(value: Any) -> None:
    if isinstance(value, bool) or not isinstance(value, (float, int)) or not time.time() * 1000 < value <= time.time() * 1000 + 180_000:
        raise ValueError("Request expired or expiry is invalid")


def validate_close_proof(value: Any, conversation_id: str) -> None:
    if not isinstance(value, dict):
        raise ValueError("Close requires fresh rollout evidence")
    path = value.get("rolloutPath")
    size = value.get("size")
    mtime_ns = value.get("mtimeNs")
    if (
        not isinstance(path, str) or not os.path.isabs(path) or any(c in path for c in "\0\r\n")
        or isinstance(size, bool) or not isinstance(size, int) or size <= 0
        or not isinstance(mtime_ns, str) or not mtime_ns.isdecimal()
    ):
        raise ValueError("Close rollout evidence is invalid")
    real_path = os.path.realpath(path)
    codex_home = os.path.realpath(os.path.expanduser("~/.codex"))
    if (
        not any(real_path.startswith(os.path.join(codex_home, directory) + os.sep) for directory in ("sessions", "archived_sessions"))
        or not os.path.basename(real_path).endswith(conversation_id + ".jsonl")
    ):
        raise ValueError("Close rollout path does not identify the original Codex thread")
    try:
        current = os.stat(real_path)
    except OSError as error:
        raise ValueError("Close rollout evidence is no longer available") from error
    if current.st_size != size or current.st_mtime_ns != int(mtime_ns):
        raise ValueError("The original thread changed after its idle check; the pane was left open")


def validate_close_writer(expected_pid: int, proof: Dict[str, Any], conversation_id: str) -> None:
    validate_close_proof(proof, conversation_id)
    try:
        process_result = subprocess.run(
            ["/bin/ps", "-axo", "pid=,ppid="], capture_output=True, text=True, timeout=1, check=False,
        )
        if process_result.returncode != 0 or len(process_result.stdout) > 1024 * 1024:
            raise ValueError("Current Codex writer could not be verified")
        parents = {}
        for line in process_result.stdout.splitlines():
            parts = line.split()
            if len(parts) == 2 and all(part.isdecimal() for part in parts):
                parents[int(parts[0])] = int(parts[1])
        if expected_pid not in parents:
            raise ValueError("Close target process no longer exists")
        descendants = {expected_pid}
        while True:
            expanded = descendants | {pid for pid, parent in parents.items() if parent in descendants}
            if expanded == descendants:
                break
            descendants = expanded
        files_result = subprocess.run(
            ["/usr/sbin/lsof", "-nP", "-a", "-p", ",".join(str(pid) for pid in sorted(descendants)), "-Fpfan"],
            capture_output=True, text=True, timeout=2, check=False,
        )
        if files_result.returncode not in (0, 1) or files_result.stderr.strip() or len(files_result.stdout) > 1024 * 1024:
            raise ValueError("Current Codex writer could not be verified")
        codex_home = os.path.realpath(os.path.expanduser("~/.codex"))
        writable_rollouts = set()
        access = None
        for line in files_result.stdout.splitlines():
            if line.startswith(("p", "f")):
                access = None
            elif line.startswith("a"):
                access = line[1:]
            elif line.startswith("n") and access in ("u", "w"):
                path = os.path.realpath(line[1:])
                if any(path.startswith(os.path.join(codex_home, directory) + os.sep) for directory in ("sessions", "archived_sessions")) and path.endswith(".jsonl"):
                    writable_rollouts.add(path)
        root_ids = set()
        expected_path = os.path.realpath(proof["rolloutPath"])
        if expected_path not in writable_rollouts:
            raise ValueError("The pane is no longer writing the original Codex thread")
        for path in writable_rollouts:
            with open(path, "rb") as handle:
                first = handle.readline(256 * 1024 + 1)
            if len(first) > 256 * 1024:
                raise ValueError("Current Codex thread identity could not be verified")
            metadata = json.loads(first)
            payload = metadata.get("payload") if isinstance(metadata, dict) else None
            thread_id = optional_codex_session_id(payload.get("id")) if isinstance(payload, dict) else None
            if metadata.get("type") != "session_meta" or thread_id is None or not os.path.basename(path).endswith(thread_id + ".jsonl"):
                raise ValueError("Current Codex thread identity could not be verified")
            source = payload.get("source")
            if not isinstance(source, dict) or not source.get("subagent"):
                root_ids.add(thread_id)
        if root_ids != {conversation_id}:
            raise ValueError("The pane switched Codex threads or has multiple root writers; it was left open")
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError, UnicodeDecodeError) as error:
        raise ValueError("Current Codex writer could not be verified") from error


async def close_saved_session(app: Any, raw_request: Any) -> None:
    request = dict(raw_request) if isinstance(raw_request, dict) else {}
    request["controllerPort"] = 4317
    session_id, cwd, conversation_id, _, expected_pid, expected_name, expected_command = validate_auto_resume_request(request)
    validate_command_expiry(request.get("expiresAt"))
    session = find_exact_session(app, session_id)
    if session is None:
        raise ValueError("Close target no longer exists")
    variables = await read_variables(session)
    if optional_string(variables.get("path")) != cwd:
        raise ValueError("Close target cwd changed")
    if (
        optional_pid(variables.get("jobPid")) != expected_pid
        or optional_string(variables.get("jobName")) != expected_name
        or optional_string(variables.get("commandLine")) != expected_command
    ):
        raise ValueError("Close target process identity changed")
    marker = optional_codex_session_id(variables.get(AUTO_RESUME_VARIABLE))
    if marker is not None and marker != conversation_id:
        raise ValueError("Close target Codex identity changed")
    profile = await session.async_get_profile()
    profile_identity = profile_auto_resume_identity(profile, cwd)
    if profile_identity is not None and profile_identity[0] != conversation_id:
        raise ValueError("Close target recovery identity changed")
    # Repeat process reads after the profile RPC.
    latest = await read_variables(session)
    for name in ("path", "jobPid", "jobName", "commandLine", AUTO_RESUME_VARIABLE):
        if latest.get(name) != variables.get(name):
            raise ValueError("Close target identity changed during validation")
    try:
        await asyncio.wait_for(
            asyncio.to_thread(validate_close_writer, expected_pid, request.get("proof"), conversation_id),
            timeout=3.5,
        )
    except asyncio.TimeoutError as error:
        raise ValueError("Current Codex writer check timed out; the pane was left open") from error
    latest = await read_variables(session)
    for name in ("path", "jobPid", "jobName", "commandLine", AUTO_RESUME_VARIABLE):
        if latest.get(name) != variables.get(name):
            raise ValueError("Close target identity changed during writer validation")
    validate_command_expiry(request.get("expiresAt"))
    validate_close_proof(request.get("proof"), conversation_id)
    await session.async_close(force=True)


def validate_thread_restore_target(value: Any) -> Dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("Thread restore target is invalid")
    conversation_id = optional_codex_session_id(value.get("conversationId"))
    cwd = optional_string(value.get("cwd"))
    title = optional_string(value.get("title"))
    if conversation_id is None or cwd is None or not os.path.isabs(cwd) or any(c in cwd for c in "\0\r\n"):
        raise ValueError("Thread restore identity is invalid")
    if title is None or len(title) > 4096 or any(c in title for c in "\0\r\n"):
        raise ValueError("Thread restore title is invalid")
    target = {"conversationId": conversation_id, "cwd": cwd, "title": title}
    if "savedCard" in value:
        if not isinstance(value["savedCard"], bool):
            raise ValueError("Thread restore saved-card marker is invalid")
        target["savedCard"] = value["savedCard"]
    for name in ("profileName", "windowId"):
        if name in value:
            item = optional_string(value[name])
            if item is None or len(item) > 512 or any(c in item for c in "\0\r\n"):
                raise ValueError("Thread restore profile or window is invalid")
            target[name] = item
    return target


async def restore_thread(app: Any, connection: Any, raw_target: Any, controller_port: int = 4317) -> Dict[str, str]:
    target = validate_thread_restore_target(raw_target)
    if optional_port(controller_port) is None:
        raise ValueError("Thread restore controller port is invalid")
    customization = pane_profile(target, controller_port)
    window = next((item for item in app.terminal_windows if item.window_id == target.get("windowId")), None)
    try:
        if window is None:
            window = await iterm2.Window.async_create(
                connection, profile=target.get("profileName"), profile_customizations=customization,
            )
            tab = window.current_tab if window is not None else None
        else:
            tab = await window.async_create_tab(
                profile=target.get("profileName"), profile_customizations=customization,
            )
        session = tab.current_session if tab is not None else None
        if session is None or not optional_string(session.session_id):
            raise RuntimeError("iTerm2 did not keep the restored thread open")
        await mark_auto_resume_session(session, target)
        if target.get("savedCard"):
            with contextlib.suppress(Exception):
                await write_saved_marker(session, requested_saved_marker(session.session_id, target["conversationId"]))
        result = {"terminalSessionId": session.session_id}
        window_id = optional_string(getattr(window, "window_id", None))
        if window_id:
            result["windowId"] = window_id
        return result
    except Exception as error:
        raise PartialRestoreError(
            "iTerm2 may have created the restored thread; inspect it before retrying",
            optional_string(getattr(window, "window_id", None)),
        ) from error


PARK_ERROR_CODES = {
    "SESSION_NOT_LINKED", "HANDOFF_REQUIRED", "SESSION_REQUIRES_PROCESS", "SESSION_NOT_IDLE", "HANDOFF_STALE",
    "SESSION_TARGET_CHANGED", "ITERM_OFFLINE", "BRIDGE_UPDATE_REQUIRED", "PROVIDER_UNAVAILABLE", "CONTINUATION_CANCELLED",
}


def park_http_request(session_id: str, controller_port: int) -> Tuple[bool, Optional[str]]:
    url = f"http://127.0.0.1:{controller_port}/api/terminals/{urllib.parse.quote(session_id, safe='')}/park"
    request = urllib.request.Request(url, data=b"{}", headers={"Content-Type": "application/json"}, method="POST")
    # Local controller requests must not inherit an HTTP proxy or follow redirects.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *_args, **_kwargs):
            return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(request, timeout=12) as response:
            return (True, None) if response.status == 200 else (False, "CLOSE_FAILED")
    except urllib.error.HTTPError as error:
        code = "CLOSE_FAILED"
        try:
            body = error.read(8193)
            if len(body) <= 8192:
                payload = json.loads(body)
                failure = payload.get("error") if isinstance(payload, dict) else None
                candidate = failure.get("code") if isinstance(failure, dict) else None
                if isinstance(candidate, str) and candidate in PARK_ERROR_CODES:
                    code = candidate
        except (ValueError, OSError):
            pass
        finally:
            error.close()
        return False, code
    except (urllib.error.URLError, OSError):
        return False, "CLOSE_FAILED"


async def register_park_rpc(connection: Any) -> None:
    controller_port = optional_port(os.environ.get("SESSION_ATLAS_PORT")) or 4317

    @iterm2.RPC
    async def session_atlas_park(session_id=iterm2.Reference("id?")):
        if not isinstance(session_id, str) or not session_id or len(session_id) > 512:
            return
        # The HTTP response waits for this bridge's command reader; keep it free.
        ok, error_code = await asyncio.to_thread(park_http_request, session_id, controller_port)
        if not ok:
            query = urllib.parse.urlencode({"handoff": "iterm:" + session_id, "handoffError": error_code or "CLOSE_FAILED"})
            process = await asyncio.create_subprocess_exec("/usr/bin/open", f"http://127.0.0.1:{controller_port}/?{query}")
            await process.wait()
    await session_atlas_park.async_register(connection, timeout=20)


class BridgeClient:
    def __init__(
        self,
        app: Any,
        socket_path: str,
        changed: asyncio.Event,
        *,
        connection: Any = None,
        snapshot_heartbeat_seconds: float = SNAPSHOT_HEARTBEAT_SECONDS,
        snapshot_min_interval_seconds: float = SNAPSHOT_MIN_INTERVAL_SECONDS,
    ):
        self.app = app
        self.socket_path = socket_path
        self.changed = changed
        self.connection = connection
        self.snapshot_heartbeat_seconds = snapshot_heartbeat_seconds
        self.snapshot_min_interval_seconds = snapshot_min_interval_seconds
        self.writer: Optional[asyncio.StreamWriter] = None
        self.write_lock = asyncio.Lock()

    async def send(self, payload: Dict[str, Any]) -> None:
        if self.writer is None:
            raise ConnectionError("Session Atlas controller is not connected")
        encoded = json.dumps(
            payload,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8") + b"\n"
        async with self.write_lock:
            self.writer.write(encoded)
            await self.writer.drain()

    async def send_snapshot_loop(self) -> None:
        loop = asyncio.get_running_loop()
        last_sent_at: Optional[float] = None
        while True:
            now = loop.time()
            heartbeat_remaining = (
                self.snapshot_heartbeat_seconds
                if last_sent_at is None
                else max(
                    0,
                    self.snapshot_heartbeat_seconds - (now - last_sent_at),
                )
            )
            try:
                await asyncio.wait_for(
                    self.changed.wait(), timeout=heartbeat_remaining
                )
            except asyncio.TimeoutError:
                pass
            if self.changed.is_set() and last_sent_at is not None:
                earliest_send_at = (
                    last_sent_at + self.snapshot_min_interval_seconds
                )
                delay = earliest_send_at - loop.time()
                if delay > 0:
                    await asyncio.sleep(delay)
            self.changed.clear()
            await self.send(await build_snapshot(self.app))
            await self.send(
                {
                    "type": "health",
                    "protocol": PROTOCOL_VERSION,
                    "status": "online",
                    "sentAt": utc_now(),
                }
            )
            last_sent_at = loop.time()

    async def handle_focus(self, message: Dict[str, Any]) -> None:
        request_id = message.get("requestId")
        session_id = message.get("sessionId")
        expires_at = message.get("expiresAt")
        if not isinstance(request_id, str) or not request_id or len(request_id) > 128:
            return
        if (
            isinstance(expires_at, bool)
            or not isinstance(expires_at, (int, float))
            or expires_at <= 0
        ):
            await self.send(
                {
                    "type": "focus-result",
                    "protocol": PROTOCOL_VERSION,
                    "requestId": request_id,
                    "ok": False,
                    "error": "Invalid focus request expiry",
                }
            )
            return
        if time.time() * 1000 >= expires_at:
            await self.send(
                {
                    "type": "focus-result",
                    "protocol": PROTOCOL_VERSION,
                    "requestId": request_id,
                    "ok": False,
                    "error": "Focus request expired before execution",
                }
            )
            return
        if (
            not isinstance(session_id, str)
            or not session_id
            or len(session_id) > 512
            or "\n" in session_id
            or "\r" in session_id
        ):
            await self.send(
                {
                    "type": "focus-result",
                    "protocol": PROTOCOL_VERSION,
                    "requestId": request_id,
                    "ok": False,
                    "error": "Invalid session ID",
                }
            )
            return

        session = find_exact_session(self.app, session_id)
        if session is None:
            await self.send(
                {
                    "type": "focus-result",
                    "protocol": PROTOCOL_VERSION,
                    "requestId": request_id,
                    "ok": False,
                    "error": "Session is no longer available",
                }
            )
            return

        async def activate() -> None:
            await self.app.async_activate(
                raise_all_windows=False,
                ignoring_other_apps=True,
            )
            await session.async_activate(select_tab=True, order_window_front=True)

        try:
            remaining_seconds = (
                (expires_at - time.time() * 1000) / 1000
                - FOCUS_RESPONSE_MARGIN_SECONDS
            )
            if remaining_seconds <= 0:
                raise asyncio.TimeoutError
            await asyncio.wait_for(
                activate(),
                timeout=min(FOCUS_REQUEST_TIMEOUT_SECONDS, remaining_seconds),
            )
        except asyncio.TimeoutError:
            await self.send(
                {
                    "type": "focus-result",
                    "protocol": PROTOCOL_VERSION,
                    "requestId": request_id,
                    "ok": False,
                    "error": "Timed out while focusing the iTerm2 session",
                }
            )
            return
        except Exception as error:  # iTerm RPC exceptions differ by release.
            await self.send(
                {
                    "type": "focus-result",
                    "protocol": PROTOCOL_VERSION,
                    "requestId": request_id,
                    "ok": False,
                    "error": str(error) or "iTerm2 could not focus the session",
                }
            )
            return

        self.changed.set()
        await self.send(
            {
                "type": "focus-result",
                "protocol": PROTOCOL_VERSION,
                "requestId": request_id,
                "ok": True,
            }
        )

    async def handle_restore_layout(self, message: Dict[str, Any]) -> None:
        request_id = message.get("requestId")
        if not isinstance(request_id, str) or not request_id or len(request_id) > 128:
            return
        if self.connection is None:
            await self.send(
                {
                    "type": "restore-layout-result",
                    "protocol": PROTOCOL_VERSION,
                    "requestId": request_id,
                    "ok": False,
                    "error": "iTerm2 connection is unavailable",
                }
            )
            return
        try:
            controller_port = optional_port(message.get("controllerPort"))
            if controller_port is None:
                raise ValueError("Session Atlas controller port is invalid")
            created_window_id = await restore_layout(
                self.connection, message.get("layout"), controller_port
            )
        except PartialRestoreError as error:
            await self.send(
                {
                    "type": "restore-layout-result",
                    "protocol": PROTOCOL_VERSION,
                    "requestId": request_id,
                    "ok": False,
                    "partial": True,
                    "error": str(error),
                    **(
                        {"createdWindowId": error.created_window_id}
                        if error.created_window_id
                        else {}
                    ),
                }
            )
            return
        except Exception as error:  # iTerm RPC exceptions differ by release.
            await self.send(
                {
                    "type": "restore-layout-result",
                    "protocol": PROTOCOL_VERSION,
                    "requestId": request_id,
                    "ok": False,
                    "error": str(error) or "iTerm2 could not restore the window",
                }
            )
            return
        self.changed.set()
        await self.send(
            {
                "type": "restore-layout-result",
                "protocol": PROTOCOL_VERSION,
                "requestId": request_id,
                "ok": True,
                **(
                    {"createdWindowId": created_window_id}
                    if created_window_id
                    else {}
                ),
            }
        )

    async def handle_restore_recoveries(self, message: Dict[str, Any]) -> None:
        request_id = message.get("requestId")
        if not isinstance(request_id, str) or not request_id or len(request_id) > 128:
            return
        try:
            controller_port = optional_port(message.get("controllerPort"))
            if controller_port is None:
                raise ValueError("Session Atlas controller port is invalid")
            await restore_recoveries_in_place(
                self.app, message.get("recoveries"), controller_port
            )
        except PartialRestoreError as error:
            await self.send(
                {
                    "type": "restore-recoveries-result",
                    "protocol": PROTOCOL_VERSION,
                    "requestId": request_id,
                    "ok": False,
                    "partial": True,
                    "error": str(error),
                }
            )
            return
        except Exception as error:  # iTerm RPC exceptions differ by release.
            await self.send(
                {
                    "type": "restore-recoveries-result",
                    "protocol": PROTOCOL_VERSION,
                    "requestId": request_id,
                    "ok": False,
                    "error": str(error) or "iTerm2 could not restore the sessions",
                }
            )
            return
        self.changed.set()
        await self.send(
            {
                "type": "restore-recoveries-result",
                "protocol": PROTOCOL_VERSION,
                "requestId": request_id,
                "ok": True,
            }
        )

    async def handle_configure_auto_resume(self, message: Dict[str, Any]) -> None:
        request_id = message.get("requestId")
        if not isinstance(request_id, str) or not request_id or len(request_id) > 128:
            return
        try:
            await configure_auto_resume(self.app, message)
        except Exception as error:  # iTerm RPC exceptions differ by release.
            await self.send(
                {
                    "type": "configure-auto-resume-result",
                    "protocol": PROTOCOL_VERSION,
                    "requestId": request_id,
                    "ok": False,
                    "error": str(error) or "iTerm2 could not configure automatic recovery",
                }
            )
            return
        self.changed.set()
        await self.send(
            {
                "type": "configure-auto-resume-result",
                "protocol": PROTOCOL_VERSION,
                "requestId": request_id,
                "ok": True,
            }
        )

    async def handle_clear_auto_resume(self, message: Dict[str, Any]) -> None:
        request_id = message.get("requestId")
        if not isinstance(request_id, str) or not request_id or len(request_id) > 128:
            return
        try:
            await clear_auto_resume(self.app, message)
        except Exception as error:  # iTerm RPC exceptions differ by release.
            await self.send(
                {
                    "type": "clear-auto-resume-result",
                    "protocol": PROTOCOL_VERSION,
                    "requestId": request_id,
                    "ok": False,
                    "error": str(error) or "iTerm2 could not clear automatic recovery",
                }
            )
            return
        self.changed.set()
        await self.send(
            {
                "type": "clear-auto-resume-result",
                "protocol": PROTOCOL_VERSION,
                "requestId": request_id,
                "ok": True,
            }
        )

    async def handle_close_session(self, message: Dict[str, Any]) -> None:
        request_id = message.get("requestId")
        if not isinstance(request_id, str) or not request_id or len(request_id) > 128:
            return
        result = {"type": "close-session-result", "protocol": PROTOCOL_VERSION, "requestId": request_id, "ok": False}
        try:
            await close_saved_session(self.app, message)
            result["ok"] = True
            self.changed.set()
        except Exception as error:
            result["error"] = str(error) if isinstance(error, ValueError) else "iTerm2 close result is uncertain; refresh the saved thread"
        await self.send(result)

    async def handle_saved_marker(self, message: Dict[str, Any], *, clear: bool) -> None:
        request_id = message.get("requestId")
        if not isinstance(request_id, str) or not request_id or len(request_id) > 128:
            return
        action = "clear" if clear else "configure"
        result = {"type": action + "-saved-marker-result", "protocol": PROTOCOL_VERSION, "requestId": request_id, "ok": False}
        try:
            if clear:
                await clear_saved_marker(self.app, message)
            else:
                await configure_saved_marker(self.app, message)
            result["ok"] = True
            self.changed.set()
        except Exception as error:
            result["error"] = str(error) if isinstance(error, ValueError) else "iTerm2 could not update the saved-card marker"
        await self.send(result)

    async def handle_restore_thread(self, message: Dict[str, Any]) -> None:
        request_id = message.get("requestId")
        if not isinstance(request_id, str) or not request_id or len(request_id) > 128:
            return
        result = {"type": "restore-thread-result", "protocol": PROTOCOL_VERSION, "requestId": request_id, "ok": False}
        try:
            validate_command_expiry(message.get("expiresAt"))
            restored = await restore_thread(self.app, self.connection, message.get("target"), message.get("controllerPort"))
            result.update(restored)
            result["ok"] = True
            self.changed.set()
        except PartialRestoreError as error:
            result["partial"] = True
            result["error"] = str(error)
            if error.created_window_id:
                result["windowId"] = error.created_window_id
            self.changed.set()
        except Exception as error:
            result["error"] = str(error) if isinstance(error, ValueError) else "iTerm2 could not restore the saved thread"
        await self.send(result)

    async def receive_loop(self, reader: asyncio.StreamReader) -> None:
        while True:
            line = await reader.readline()
            if not line:
                return
            if len(line) > MAX_COMMAND_BYTES:
                raise ValueError("Controller message exceeded the protocol limit")
            try:
                message = json.loads(line.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue
            if not isinstance(message, dict):
                continue
            if message.get("protocol") != PROTOCOL_VERSION:
                continue
            if message.get("type") == "close-session":
                await self.handle_close_session(message)
                continue
            if message.get("type") == "restore-thread":
                await self.handle_restore_thread(message)
                continue
            if message.get("type") == "focus":
                await self.handle_focus(message)
                continue
            if message.get("type") == "restore-layout":
                await self.handle_restore_layout(message)
                continue
            if message.get("type") == "restore-recoveries":
                await self.handle_restore_recoveries(message)
                continue
            if message.get("type") == "configure-auto-resume":
                await self.handle_configure_auto_resume(message)
                continue
            if message.get("type") == "clear-auto-resume":
                await self.handle_clear_auto_resume(message)
                continue
            if message.get("type") in ("configure-saved-marker", "clear-saved-marker"):
                await self.handle_saved_marker(message, clear=message["type"] == "clear-saved-marker")
                continue

            request_id = message.get("requestId")
            if isinstance(request_id, str) and request_id:
                await self.send(
                    {
                        "type": "error",
                        "protocol": PROTOCOL_VERSION,
                        "requestId": request_id,
                        "code": "unsupported_action",
                        "message": "The iTerm bridge only supports focus, recovery, saved-thread close, automatic recovery profiles, and saved-card markers",
                    }
                )

    async def connected(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self.writer = writer
        try:
            await self.send(
                {
                    "type": "hello",
                    "protocol": PROTOCOL_VERSION,
                    "bridgeVersion": BRIDGE_VERSION,
                    "sentAt": utc_now(),
                }
            )
            await self.send(
                {
                    "type": "health",
                    "protocol": PROTOCOL_VERSION,
                    "status": "online",
                    "sentAt": utc_now(),
                }
            )
            self.changed.set()

            receiver = asyncio.create_task(self.receive_loop(reader))
            snapshots = asyncio.create_task(self.send_snapshot_loop())
            done, pending = await asyncio.wait(
                (receiver, snapshots), return_when=asyncio.FIRST_COMPLETED
            )
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
            for task in done:
                task.result()
        finally:
            self.writer = None
            writer.close()
            with contextlib.suppress(Exception):
                await writer.wait_closed()

    async def run(self) -> None:
        delay = 1
        while True:
            try:
                reader, writer = await asyncio.open_unix_connection(
                    self.socket_path, limit=MAX_COMMAND_BYTES + 1
                )
                delay = 1
                await self.connected(reader, writer)
            except asyncio.CancelledError:
                raise
            except Exception:
                await asyncio.sleep(delay)
                delay = min(delay * 2, RECONNECT_MAX_SECONDS)


async def layout_monitor(connection: Any, changed: asyncio.Event) -> None:
    async with iterm2.LayoutChangeMonitor(connection) as monitor:
        while True:
            await monitor.async_get()
            changed.set()


async def focus_monitor(connection: Any, changed: asyncio.Event) -> None:
    async with iterm2.FocusMonitor(connection) as monitor:
        while True:
            await monitor.async_get_next_update()
            changed.set()


async def watch_one_variable(
    connection: Any,
    session_id: str,
    variable_name: str,
    changed: asyncio.Event,
) -> None:
    previous = object()
    async with iterm2.VariableMonitor(
        connection,
        iterm2.VariableScopes.SESSION,
        variable_name,
        session_id,
    ) as monitor:
        while True:
            value = stable_monitored_value(
                variable_name, await monitor.async_get()
            )
            if value != previous:
                previous = value
                changed.set()


async def watch_session_variables(
    connection: Any, session_id: str, changed: asyncio.Event
) -> None:
    tasks = [
        asyncio.create_task(
            watch_one_variable(connection, session_id, name, changed)
        )
        for name in MONITORED_VARIABLES
    ]
    try:
        done, _pending = await asyncio.wait(
            tasks, return_when=asyncio.FIRST_COMPLETED
        )
        for task in done:
            task.result()
        raise RuntimeError("A session variable watcher stopped unexpectedly")
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def variable_monitors(
    app: Any, connection: Any, changed: asyncio.Event
) -> None:
    session_tasks: Dict[str, asyncio.Task[Any]] = {}
    failures: asyncio.Queue[asyncio.Task[Any]] = asyncio.Queue()

    def track_failure(task: asyncio.Task[Any]) -> None:
        if not task.cancelled():
            failures.put_nowait(task)

    async def stop_session_task(session_id: str) -> None:
        task = session_tasks.pop(session_id, None)
        if task is None:
            return
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    async def session_creations() -> None:
        async with iterm2.EachSessionOnceMonitor(app) as monitor:
            while True:
                session_id = await monitor.async_get()
                await stop_session_task(session_id)
                task = asyncio.create_task(
                    watch_session_variables(connection, session_id, changed)
                )
                task.add_done_callback(track_failure)
                session_tasks[session_id] = task

    async def session_terminations() -> None:
        async with iterm2.SessionTerminationMonitor(connection) as monitor:
            while True:
                await stop_session_task(await monitor.async_get())

    async def propagate_session_failure() -> None:
        task = await failures.get()
        task.result()
        raise RuntimeError("Session variable monitor stopped unexpectedly")

    lifecycle_tasks = [
        asyncio.create_task(session_creations()),
        asyncio.create_task(session_terminations()),
        asyncio.create_task(propagate_session_failure()),
    ]
    try:
        await asyncio.gather(*lifecycle_tasks)
    finally:
        for task in lifecycle_tasks:
            task.cancel()
        for task in session_tasks.values():
            task.cancel()
        await asyncio.gather(
            *lifecycle_tasks,
            *session_tasks.values(),
            return_exceptions=True,
        )


async def supervise_main_tasks(
    connection: Any, coroutines: Iterable[Any]
) -> None:
    websocket = getattr(connection, "websocket", None)
    wait_closed = getattr(websocket, "wait_closed", None)
    if not callable(wait_closed):
        raise RuntimeError("iTerm connection does not expose a close monitor")
    owned_tasks = [asyncio.create_task(coroutine) for coroutine in coroutines]
    disconnect_task = asyncio.create_task(wait_closed())
    all_tasks = [*owned_tasks, disconnect_task]
    try:
        done, _pending = await asyncio.wait(
            all_tasks, return_when=asyncio.FIRST_COMPLETED
        )
        if disconnect_task in done:
            disconnect_task.result()
            raise ConnectionError("iTerm Python API connection closed")
        for task in done:
            task.result()
        raise RuntimeError("A Session Atlas bridge task stopped unexpectedly")
    finally:
        for task in all_tasks:
            task.cancel()
        await asyncio.gather(*all_tasks, return_exceptions=True)


async def main(connection: Any) -> None:
    app = await iterm2.async_get_app(connection)
    await register_park_rpc(connection)
    changed = asyncio.Event()
    changed.set()
    bridge = BridgeClient(app, default_socket_path(), changed, connection=connection)
    await supervise_main_tasks(
        connection,
        (
            bridge.run(),
            layout_monitor(connection, changed),
            focus_monitor(connection, changed),
            variable_monitors(app, connection, changed),
        ),
    )


def run_bridge_forever(
    run_once: Optional[Any] = None, sleep: Optional[Any] = None
) -> None:
    run_once = run_once or iterm2.run_forever
    sleep = sleep or time.sleep
    while True:
        try:
            run_once(main, retry=True)
        except SystemExit as error:
            if error.code in (None, 0):
                return
        sleep(BRIDGE_RESTART_DELAY_SECONDS)


if __name__ == "__main__":
    try:
        PROCESS_LOCK_FD = acquire_process_lock()
    except BlockingIOError:
        raise SystemExit("Session Atlas iTerm bridge is already running") from None
    try:
        run_bridge_forever()
    finally:
        os.close(PROCESS_LOCK_FD)
