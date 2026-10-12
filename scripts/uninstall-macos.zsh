#!/bin/zsh
set -euo pipefail

project_root=${0:A:h:h}
source "$project_root/scripts/launch-agent-ownership.zsh"

user_id=$(id -u)
plist_path="$HOME/Library/LaunchAgents/com.boring.session-atlas.plist"
bridge_source="$project_root/bridge/session_atlas_iterm.py"
bridge_link="$HOME/Library/Application Support/iTerm2/Scripts/AutoLaunch/session_atlas.py"
skill_source="$project_root/skills/session-atlas-handoff"
skill_link="${CODEX_HOME:-$HOME/.codex}/skills/session-atlas-handoff"

owned_plist=0
owned_bridge=0
controller_port=4317
if [[ -e "$plist_path" || -L "$plist_path" ]]; then
  if ! session_atlas_launch_agent_plist_is_owned "$plist_path" "$project_root"; then
    print -u2 "Refusing to unload or remove a LaunchAgent plist not owned by this Session Atlas checkout."
    print -u2 "The existing file and loaded job were left unchanged: $plist_path"
    exit 1
  fi
  owned_plist=1
  configured_port=$(plutil -extract EnvironmentVariables.SESSION_ATLAS_PORT raw -o - -- "$plist_path" 2>/dev/null || true)
  if [[ -n "$configured_port" ]]; then
    if [[ ! "$configured_port" =~ '^[0-9]{1,5}$' ]] ||
      (( configured_port < 1 || configured_port > 65535 )); then
      print -u2 "Refusing to uninstall with an invalid SESSION_ATLAS_PORT in the owned LaunchAgent plist."
      exit 1
    fi
    controller_port=$configured_port
  fi
fi

if session_atlas_bridge_link_is_owned "$bridge_link" "$bridge_source"; then
  owned_bridge=1
fi

if (( owned_plist || owned_bridge )); then
  curl_path=$(command -v curl || true)
  disarmed=0
  if [[ -n "$curl_path" ]]; then
    for _ in {1..5}; do
      if "$curl_path" \
        --fail \
        --silent \
        --show-error \
        --noproxy '*' \
        --max-time 2 \
        --header 'Content-Type: application/json' \
        --data-binary '{}' \
        "http://127.0.0.1:${controller_port}/api/recoveries/disarm" \
        >/dev/null 2>&1; then
        disarmed=1
        break
      fi
      sleep 0.2
    done
  fi
  if (( ! disarmed )); then
    print -u2 "Refusing to remove Session Atlas while owned iTerm recovery commands cannot be disarmed."
    print -u2 "Start iTerm2 and the Session Atlas service, then run uninstall again."
    exit 1
  fi
fi

if (( owned_bridge )); then
  # Complete the exact process verification before changing either service.
  # An ambiguous bridge leaves the Node job and AutoLaunch link untouched.
  session_atlas_stop_owned_iterm_bridge "$bridge_link" "$bridge_source"
  if [[ -n "$SESSION_ATLAS_BRIDGE_RUNTIME" && -x "$SESSION_ATLAS_BRIDGE_RUNTIME" ]]; then
    "$SESSION_ATLAS_BRIDGE_RUNTIME" "$project_root/scripts/session-atlas-shortcut.py" uninstall
  fi
fi

if (( owned_plist )); then
  launchctl bootout "gui/$user_id/$SESSION_ATLAS_LAUNCH_AGENT_LABEL" >/dev/null 2>&1 || true
fi

if (( owned_bridge )); then
  rm "$bridge_link"
fi

if [[ -L "$skill_link" && "${skill_link:A}" == "${skill_source:A}" ]]; then
  rm "$skill_link"
fi

if (( owned_plist )); then
  rm "$plist_path"
  print "Session Atlas service removed. Runtime state was preserved in $HOME/Library/Application Support/SessionAtlas."
else
  print "No owned Session Atlas LaunchAgent plist was found; no loaded job was changed."
  print "Runtime state was preserved in $HOME/Library/Application Support/SessionAtlas."
fi
