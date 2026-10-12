#!/bin/zsh
set -euo pipefail

project_root=${0:A:h:h}
source "$project_root/scripts/launch-agent-ownership.zsh"

test_root=$(mktemp -d "${TMPDIR:-/tmp}/session-atlas-plist-test.XXXXXX")
expected_server="$project_root/dist/node/server/index.js"

cleanup() {
  rm -f \
    "$test_root/owned.plist" \
    "$test_root/wrong-label.plist" \
    "$test_root/wrong-server.plist" \
    "$test_root/wrong-executable.plist" \
    "$test_root/extra-argument.plist" \
    "$test_root/no-arguments.plist" \
    "$test_root/owned-link.plist" \
    "$test_root/bridge-source.py" \
    "$test_root/it2_api_wrapper.sh" \
    "$test_root/it2run" \
    "$test_root/processes-valid.txt" \
    "$test_root/processes-unpaired.txt" \
    "$test_root/processes-no-child.txt" \
    "$test_root/processes-multiple-runtime.txt" \
    "$test_root/App Support/Scripts/AutoLaunch/session_atlas.py"
  rmdir \
    "$test_root/App Support/Scripts/AutoLaunch" \
    "$test_root/App Support/Scripts" \
    "$test_root/App Support" 2>/dev/null || true
  rmdir "$test_root"
}
trap cleanup EXIT

make_plist() {
  local output_path=$1
  local label=$2
  local server_path=$3

  plutil -create xml1 "$output_path"
  /usr/libexec/PlistBuddy -c "Add :Label string $label" "$output_path"
  /usr/libexec/PlistBuddy -c "Add :ProgramArguments array" "$output_path"
  /usr/libexec/PlistBuddy -c "Add :ProgramArguments:0 string /opt/homebrew/bin/node" "$output_path"
  /usr/libexec/PlistBuddy -c "Add :ProgramArguments:1 string $server_path" "$output_path"
}

expect_unowned() {
  local plist_path=$1
  if session_atlas_launch_agent_plist_is_owned "$plist_path" "$project_root" >/dev/null 2>&1; then
    print -u2 "Expected plist to be rejected: $plist_path"
    exit 1
  fi
}

make_plist "$test_root/owned.plist" "$SESSION_ATLAS_LAUNCH_AGENT_LABEL" "$expected_server"
session_atlas_launch_agent_plist_is_owned "$test_root/owned.plist" "$project_root"

make_plist "$test_root/wrong-label.plist" "com.example.unrelated" "$expected_server"
expect_unowned "$test_root/wrong-label.plist"

make_plist "$test_root/wrong-server.plist" "$SESSION_ATLAS_LAUNCH_AGENT_LABEL" "/tmp/unrelated/server.js"
expect_unowned "$test_root/wrong-server.plist"

make_plist "$test_root/wrong-executable.plist" "$SESSION_ATLAS_LAUNCH_AGENT_LABEL" "$expected_server"
/usr/libexec/PlistBuddy -c "Set :ProgramArguments:0 /bin/sh" "$test_root/wrong-executable.plist"
expect_unowned "$test_root/wrong-executable.plist"

make_plist "$test_root/extra-argument.plist" "$SESSION_ATLAS_LAUNCH_AGENT_LABEL" "$expected_server"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:2 string --unrelated" "$test_root/extra-argument.plist"
expect_unowned "$test_root/extra-argument.plist"

plutil -create xml1 "$test_root/no-arguments.plist"
/usr/libexec/PlistBuddy -c "Add :Label string $SESSION_ATLAS_LAUNCH_AGENT_LABEL" "$test_root/no-arguments.plist"
expect_unowned "$test_root/no-arguments.plist"

ln -s "$test_root/owned.plist" "$test_root/owned-link.plist"
expect_unowned "$test_root/owned-link.plist"

bridge_source="$test_root/bridge-source.py"
wrapper_path="$test_root/it2_api_wrapper.sh"
runner_path="$test_root/it2run"
bridge_link="$test_root/App Support/Scripts/AutoLaunch/session_atlas.py"
runtime_path="/tmp/python3-session-atlas-test"
mkdir -p "${bridge_link:h}"
touch "$bridge_source" "$wrapper_path" "$runner_path"
chmod +x "$runner_path"
ln -s "$bridge_source" "$bridge_link"

session_atlas_plan_iterm_bridge_launch "$bridge_link" "$bridge_source" "$runner_path"
[[ "${(j:,:)SESSION_ATLAS_ITERM_LAUNCH_COMMAND}" == "$runner_path,session_atlas.py" ]]
chmod -x "$runner_path"
if session_atlas_plan_iterm_bridge_launch "$bridge_link" "$bridge_source" "$runner_path" >/dev/null 2>&1; then
  print -u2 "Expected a non-executable it2run path to be rejected."
  exit 1
fi
(( ${#SESSION_ATLAS_ITERM_LAUNCH_COMMAND} == 0 ))
chmod +x "$runner_path"

print "90 1 $(id -u) /tmp/iTerm2-test" > "$test_root/processes-valid.txt"
session_atlas_iterm_is_running_in_snapshot "$test_root/processes-valid.txt" "$(id -u)" "/tmp/iTerm2-test"
if session_atlas_iterm_is_running_in_snapshot "$test_root/processes-valid.txt" "$(( $(id -u) + 1 ))" "/tmp/iTerm2-test"; then
  print -u2 "Expected another user's iTerm2 process to be ignored."
  exit 1
fi

expect_process_plan_failure() {
  local snapshot=$1
  if session_atlas_plan_owned_bridge_processes "$snapshot" "$(id -u)" "$wrapper_path" "$bridge_source" >/dev/null 2>&1; then
    print -u2 "Expected bridge process snapshot to be rejected: $snapshot"
    exit 1
  fi
  if (( ${#SESSION_ATLAS_BRIDGE_TARGET_PIDS} != 0 )); then
    print -u2 "Rejected bridge process snapshot left signalable targets: $snapshot"
    exit 1
  fi
}

current_uid=$(id -u)
{
  print "101 1 $current_uid /bin/bash $wrapper_path $runtime_path $bridge_link"
  print "102 101 $current_uid $runtime_path $bridge_link"
  print "201 1 $current_uid /bin/bash $wrapper_path $runtime_path $test_root/App Support/Scripts/AutoLaunch/unrelated.py"
  print "202 201 $current_uid $runtime_path $test_root/App Support/Scripts/AutoLaunch/unrelated.py"
  print "301 1 $(( current_uid + 1 )) /bin/bash $wrapper_path /tmp/other-python3 $bridge_link"
  print "302 301 $(( current_uid + 1 )) /tmp/other-python3 $bridge_link"
} > "$test_root/processes-valid.txt"

session_atlas_plan_owned_bridge_processes \
  "$test_root/processes-valid.txt" \
  "$current_uid" \
  "$wrapper_path" \
  "$bridge_source"
[[ "$SESSION_ATLAS_BRIDGE_RUNTIME" == "$runtime_path" ]]
[[ "${(j:,:)SESSION_ATLAS_BRIDGE_WRAPPER_PIDS}" == "101" ]]
[[ "${(j:,:)SESSION_ATLAS_BRIDGE_TARGET_PIDS}" == "102,101" ]]

{
  print "101 1 $current_uid /bin/bash $wrapper_path $runtime_path $bridge_link"
  print "102 101 $current_uid $runtime_path $bridge_link"
  print "103 1 $current_uid $runtime_path $bridge_link"
} > "$test_root/processes-unpaired.txt"
expect_process_plan_failure "$test_root/processes-unpaired.txt"

print "101 1 $current_uid /bin/bash $wrapper_path $runtime_path $bridge_link" \
  > "$test_root/processes-no-child.txt"
expect_process_plan_failure "$test_root/processes-no-child.txt"

{
  print "101 1 $current_uid /bin/bash $wrapper_path $runtime_path $bridge_link"
  print "102 101 $current_uid $runtime_path $bridge_link"
  print "111 1 $current_uid /bin/bash $wrapper_path /tmp/python3-session-atlas-other $bridge_link"
  print "112 111 $current_uid /tmp/python3-session-atlas-other $bridge_link"
} > "$test_root/processes-multiple-runtime.txt"
expect_process_plan_failure "$test_root/processes-multiple-runtime.txt"

print "LaunchAgent and iTerm bridge ownership checks passed."
