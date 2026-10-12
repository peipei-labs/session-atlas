#!/bin/zsh
set -euo pipefail

project_root=${0:A:h:h}
source "$project_root/scripts/launch-agent-ownership.zsh"

default_codex_home="$HOME/.codex"
requested_codex_home="${CODEX_HOME:-$default_codex_home}"
if [[ "${requested_codex_home:A}" != "${default_codex_home:A}" ]]; then
  print -u2 "Session Atlas requires the default ~/.codex data directory; custom CODEX_HOME is not supported. Nothing was installed."
  exit 1
fi

node_bin=$(command -v node)
user_id=$(id -u)
app_support="$HOME/Library/Application Support/SessionAtlas"
allowed_project_roots="${SESSION_ATLAS_PROJECT_ROOTS:-${SESSION_ATLAS_PROJECT_ROOT:-$HOME/Code}}"
launch_agents="$HOME/Library/LaunchAgents"
plist_path="$launch_agents/com.boring.session-atlas.plist"
job_target="gui/$user_id/$SESSION_ATLAS_LAUNCH_AGENT_LABEL"
iterm_autolaunch="$HOME/Library/Application Support/iTerm2/Scripts/AutoLaunch"
bridge_source="$project_root/bridge/session_atlas_iterm.py"
bridge_link="$iterm_autolaunch/session_atlas.py"
skill_source="$project_root/skills/session-atlas-handoff"
skill_link="${CODEX_HOME:-$HOME/.codex}/skills/session-atlas-handoff"

if [[ ! -f "$skill_source/SKILL.md" ]]; then
  print -u2 "Missing Session Atlas continuation skill."
  exit 1
fi
if [[ -e "$skill_link" || -L "$skill_link" ]]; then
  if [[ "${skill_link:A}" != "${skill_source:A}" ]]; then
    print -u2 "Refusing to replace an unrelated continuation skill: $skill_link"
    exit 1
  fi
fi

if [[ ! -f "$bridge_source" ]]; then
  print -u2 "Missing iTerm bridge: $bridge_source"
  exit 1
fi

if [[ -e "$plist_path" || -L "$plist_path" ]]; then
  if ! session_atlas_launch_agent_plist_is_owned "$plist_path" "$project_root"; then
    print -u2 "Refusing to replace a LaunchAgent plist not owned by this Session Atlas checkout."
    print -u2 "The existing file was left unchanged: $plist_path"
    exit 1
  fi
elif launchctl print "$job_target" >/dev/null 2>&1; then
  print -u2 "Refusing to unload an existing '$SESSION_ATLAS_LAUNCH_AGENT_LABEL' job without an owned plist at: $plist_path"
  exit 1
fi

cd "$project_root"
npm run protocol:check
npm run check

mkdir -p "${skill_link:h}"
if [[ ! -e "$skill_link" && ! -L "$skill_link" ]]; then
  ln -s "$skill_source" "$skill_link"
fi

mkdir -p "$app_support/logs" "$launch_agents" "$iterm_autolaunch"

if [[ -e "$bridge_link" || -L "$bridge_link" ]]; then
  if [[ "${bridge_link:A}" != "${bridge_source:A}" ]]; then
    print -u2 "Refusing to replace unrelated iTerm2 AutoLaunch file: $bridge_link"
    exit 1
  fi
else
  ln -s "$bridge_source" "$bridge_link"
fi

escaped_project=${project_root//&/\\&}
escaped_node=${node_bin//&/\\&}
escaped_support=${app_support//&/\\&}
generated_plist=$(mktemp "$launch_agents/.com.boring.session-atlas.plist.XXXXXX")
sed \
  -e "s|__PROJECT_ROOT__|$escaped_project|g" \
  -e "s|__NODE_BIN__|$escaped_node|g" \
  -e "s|__APP_SUPPORT__|$escaped_support|g" \
  "$project_root/launchd/com.boring.session-atlas.plist.template" > "$generated_plist"

plutil -replace EnvironmentVariables.SESSION_ATLAS_PROJECT_ROOTS \
  -string "$allowed_project_roots" "$generated_plist"

if ! plutil -lint "$generated_plist"; then
  rm -f "$generated_plist"
  exit 1
fi

mv "$generated_plist" "$plist_path"
if launchctl print "$job_target" >/dev/null 2>&1; then
  launchctl bootout "$job_target"
  for _ in {1..150}; do
    if ! launchctl print "$job_target" >/dev/null 2>&1; then
      break
    fi
    sleep 0.1
  done
  if launchctl print "$job_target" >/dev/null 2>&1; then
    print -u2 "Timed out waiting for the previous Session Atlas LaunchAgent to unload."
    exit 1
  fi
fi
launchctl bootstrap "gui/$user_id" "$plist_path"
launchctl kickstart -k "$job_target"

session_atlas_restart_owned_iterm_bridge \
  "$bridge_link" \
  "$bridge_source"

if [[ -n "$SESSION_ATLAS_BRIDGE_RUNTIME" && -x "$SESSION_ATLAS_BRIDGE_RUNTIME" ]]; then
  "$SESSION_ATLAS_BRIDGE_RUNTIME" "$project_root/scripts/session-atlas-shortcut.py" install
else
  print "Continuation skill installed. Start iTerm2 and rerun install to register Control-Option-Command-B."
fi

if ! defaults read com.googlecode.iterm2 EnableAPIServer >/dev/null 2>&1; then
  print "iTerm2 Python API is not confirmed enabled. Enable it in iTerm2 Settings > General > Magic before expecting terminal inventory."
fi

print "Session Atlas installed: http://127.0.0.1:4317"
