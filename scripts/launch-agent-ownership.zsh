#!/bin/zsh

SESSION_ATLAS_LAUNCH_AGENT_LABEL="com.boring.session-atlas"
SESSION_ATLAS_ITERM_API_WRAPPER="/Applications/iTerm.app/Contents/Resources/it2_api_wrapper.sh"
SESSION_ATLAS_ITERM_RUNNER="/Applications/iTerm.app/Contents/Resources/it2run"
SESSION_ATLAS_ITERM_EXECUTABLE="/Applications/iTerm.app/Contents/MacOS/iTerm2"

typeset -ga SESSION_ATLAS_BRIDGE_TARGET_PIDS=()
typeset -ga SESSION_ATLAS_BRIDGE_WRAPPER_PIDS=()
typeset -ga SESSION_ATLAS_ITERM_LAUNCH_COMMAND=()
typeset -g SESSION_ATLAS_BRIDGE_RUNTIME=""

session_atlas_bridge_link_is_owned() {
  emulate -L zsh

  local bridge_link=$1
  local bridge_source=$2

  [[ -L "$bridge_link" && -f "$bridge_source" && "${bridge_link:A}" == "${bridge_source:A}" ]]
}

session_atlas_bridge_script_is_owned() {
  emulate -L zsh

  local script_path=$1
  local bridge_source=$2

  [[ "$script_path" == */Scripts/AutoLaunch/session_atlas.py ]] || return 1
  session_atlas_bridge_link_is_owned "$script_path" "$bridge_source"
}

session_atlas_plan_owned_bridge_processes() {
  emulate -L zsh
  setopt extendedglob

  local process_snapshot=$1
  local current_uid=$2
  local wrapper_path=$3
  local bridge_source=$4
  local row pid ppid uid command_line remainder runtime script_path wrapper_pid
  local child_count
  local -a rows runtimes owned_runtimes
  local -A wrapper_runtimes wrapper_scripts paired_child_pids

  SESSION_ATLAS_BRIDGE_TARGET_PIDS=()
  SESSION_ATLAS_BRIDGE_WRAPPER_PIDS=()
  SESSION_ATLAS_BRIDGE_RUNTIME=""

  if [[ ! -r "$process_snapshot" ]]; then
    print -u2 "Cannot read the process snapshot: $process_snapshot"
    return 1
  fi

  rows=("${(@f)$(<"$process_snapshot")}")

  # First identify exact iTerm wrapper invocations. The final argument may contain
  # spaces, so strip only the known wrapper prefix and the runtime's first token.
  for row in "${rows[@]}"; do
    row=${row##[[:space:]]#}
    [[ -n "$row" ]] || continue
    IFS=' ' read -r pid ppid uid command_line <<< "$row"
    [[ "$pid" == <-> && "$ppid" == <-> && "$uid" == "$current_uid" ]] || continue
    [[ "$command_line" == "/bin/bash $wrapper_path "* ]] || continue

    remainder=${command_line#"/bin/bash $wrapper_path "}
    runtime=${remainder%%[[:space:]]*}
    script_path=${remainder#"$runtime"}
    script_path=${script_path##[[:space:]]#}
    [[ "$runtime" == /* && "${runtime:t}" == python* ]] || continue

    # All iTerm wrapper processes are useful runtime evidence, but only the
    # exact owned Session Atlas link is eligible to receive a signal.
    if [[ "$script_path" == */Scripts/AutoLaunch/*.py ]]; then
      runtimes+=("$runtime")
    fi
    if session_atlas_bridge_script_is_owned "$script_path" "$bridge_source"; then
      wrapper_runtimes[$pid]=$runtime
      wrapper_scripts[$pid]=$script_path
      SESSION_ATLAS_BRIDGE_WRAPPER_PIDS+=("$pid")
      owned_runtimes+=("$runtime")
    fi
  done

  runtimes=("${(@u)runtimes}")
  owned_runtimes=("${(@u)owned_runtimes}")
  if (( ${#owned_runtimes} > 1 )); then
    print -u2 "Owned Session Atlas wrappers use multiple Python runtimes; refusing to restart them."
    return 1
  fi
  if (( ${#owned_runtimes} == 0 && ${#runtimes} > 1 )); then
    print -u2 "Multiple iTerm Python runtimes are active; refusing to choose one for Session Atlas."
    return 1
  fi

  # Every owned wrapper must have exactly one exact child. A similarly named
  # manual Python command or an unpaired orphan is deliberately not killable.
  for wrapper_pid in "${SESSION_ATLAS_BRIDGE_WRAPPER_PIDS[@]}"; do
    child_count=0
    for row in "${rows[@]}"; do
      row=${row##[[:space:]]#}
      [[ -n "$row" ]] || continue
      IFS=' ' read -r pid ppid uid command_line <<< "$row"
      [[ "$pid" == <-> && "$ppid" == "$wrapper_pid" && "$uid" == "$current_uid" ]] || continue
      if [[ "$command_line" == "${wrapper_runtimes[$wrapper_pid]} ${wrapper_scripts[$wrapper_pid]}" ]]; then
        paired_child_pids[$pid]=1
        SESSION_ATLAS_BRIDGE_TARGET_PIDS+=("$pid")
        (( child_count += 1 ))
      fi
    done
    if (( child_count != 1 )); then
      print -u2 "Owned Session Atlas wrapper PID $wrapper_pid does not have exactly one verifiable Python child."
      SESSION_ATLAS_BRIDGE_TARGET_PIDS=()
      return 1
    fi
  done

  # Detect exact owned Python invocations that cannot be tied to a wrapper.
  # Their origin is ambiguous, so preserve everything rather than partially
  # restarting the bridge.
  for row in "${rows[@]}"; do
    row=${row##[[:space:]]#}
    [[ -n "$row" ]] || continue
    IFS=' ' read -r pid ppid uid command_line <<< "$row"
    [[ "$pid" == <-> && "$uid" == "$current_uid" ]] || continue
    runtime=${command_line%%[[:space:]]*}
    script_path=${command_line#"$runtime"}
    script_path=${script_path##[[:space:]]#}
    [[ "$runtime" == /* && "${runtime:t}" == python* ]] || continue
    if session_atlas_bridge_script_is_owned "$script_path" "$bridge_source"; then
      if [[ -z "${paired_child_pids[$pid]-}" ]]; then
        print -u2 "Owned Session Atlas Python PID $pid is not paired with an exact iTerm wrapper; refusing to signal any bridge process."
        SESSION_ATLAS_BRIDGE_TARGET_PIDS=()
        return 1
      fi
    fi
  done

  if (( ${#SESSION_ATLAS_BRIDGE_WRAPPER_PIDS} > 0 )); then
    SESSION_ATLAS_BRIDGE_RUNTIME=${wrapper_runtimes[${SESSION_ATLAS_BRIDGE_WRAPPER_PIDS[1]}]}
    SESSION_ATLAS_BRIDGE_TARGET_PIDS+=("${SESSION_ATLAS_BRIDGE_WRAPPER_PIDS[@]}")
  elif (( ${#runtimes} == 1 )); then
    SESSION_ATLAS_BRIDGE_RUNTIME=${runtimes[1]}
  fi
}

session_atlas_snapshot_processes() {
  emulate -L zsh
  local output_path=$1
  ps -ww -axo pid=,ppid=,uid=,command= > "$output_path"
}

session_atlas_iterm_is_running_in_snapshot() {
  emulate -L zsh
  setopt extendedglob

  local process_snapshot=$1
  local current_uid=$2
  local iterm_executable=${3:-$SESSION_ATLAS_ITERM_EXECUTABLE}
  local row pid ppid uid command_line

  [[ -r "$process_snapshot" ]] || return 1
  for row in "${(@f)$(<"$process_snapshot")}"; do
    row=${row##[[:space:]]#}
    [[ -n "$row" ]] || continue
    IFS=' ' read -r pid ppid uid command_line <<< "$row"
    if [[ "$pid" == <-> && "$uid" == "$current_uid" && "$command_line" == "$iterm_executable" ]]; then
      return 0
    fi
  done
  return 1
}

session_atlas_plan_iterm_bridge_launch() {
  emulate -L zsh

  local bridge_link=$1
  local bridge_source=$2
  local runner_path=${3:-$SESSION_ATLAS_ITERM_RUNNER}

  SESSION_ATLAS_ITERM_LAUNCH_COMMAND=()
  if ! session_atlas_bridge_script_is_owned "$bridge_link" "$bridge_source"; then
    print -u2 "Refusing to launch an iTerm bridge link not owned by this Session Atlas checkout: $bridge_link"
    return 1
  fi
  if [[ ! -x "$runner_path" ]]; then
    print -u2 "Cannot execute the official iTerm API script runner: $runner_path"
    return 1
  fi

  # it2run resolves scripts by their AutoLaunch leaf name inside iTerm. Passing
  # a filesystem path would not use the same iTerm-owned launch lifecycle.
  SESSION_ATLAS_ITERM_LAUNCH_COMMAND=("$runner_path" "${bridge_link:t}")
}

session_atlas_stop_owned_iterm_bridge() {
  emulate -L zsh
  setopt localtraps

  local bridge_link=$1
  local bridge_source=$2
  local wrapper_path=${3:-$SESSION_ATLAS_ITERM_API_WRAPPER}
  local snapshot_before snapshot_confirm expected_runtime expected_targets actual_targets pid
  local -a expected_pids

  if ! session_atlas_bridge_link_is_owned "$bridge_link" "$bridge_source"; then
    print -u2 "Refusing to inspect or stop an iTerm bridge link not owned by this Session Atlas checkout: $bridge_link"
    return 1
  fi
  if [[ ! -f "$wrapper_path" ]]; then
    print -u2 "Cannot find the iTerm Python wrapper: $wrapper_path"
    return 1
  fi

  snapshot_before=$(mktemp "${TMPDIR:-/tmp}/session-atlas-bridge-ps.XXXXXX")
  snapshot_confirm=$(mktemp "${TMPDIR:-/tmp}/session-atlas-bridge-ps.XXXXXX")
  trap 'rm -f "$snapshot_before" "$snapshot_confirm"' EXIT INT TERM

  session_atlas_snapshot_processes "$snapshot_before"
  session_atlas_plan_owned_bridge_processes "$snapshot_before" "$(id -u)" "$wrapper_path" "$bridge_source" || return 1
  expected_runtime=$SESSION_ATLAS_BRIDGE_RUNTIME
  expected_pids=("${SESSION_ATLAS_BRIDGE_TARGET_PIDS[@]}")
  expected_targets="${(j:,:)expected_pids}"

  if (( ${#expected_pids} == 0 )); then
    rm -f "$snapshot_before" "$snapshot_confirm"
    trap - EXIT INT TERM
    return 0
  fi

  # Re-snapshot immediately before signaling to avoid acting on stale PIDs.
  session_atlas_snapshot_processes "$snapshot_confirm"
  session_atlas_plan_owned_bridge_processes "$snapshot_confirm" "$(id -u)" "$wrapper_path" "$bridge_source" || return 1
  actual_targets="${(j:,:)SESSION_ATLAS_BRIDGE_TARGET_PIDS}"
  if [[ "$SESSION_ATLAS_BRIDGE_RUNTIME" != "$expected_runtime" || "$actual_targets" != "$expected_targets" ]]; then
    print -u2 "The owned bridge process set changed during verification; no signal was sent."
    return 1
  fi

  if ! kill -TERM -- "${expected_pids[@]}"; then
    print -u2 "Could not signal the complete verified bridge process set; refusing to continue."
    return 1
  fi

  for _ in {1..50}; do
    local remaining=0
    for pid in "${expected_pids[@]}"; do
      if kill -0 "$pid" >/dev/null 2>&1; then
        remaining=1
        break
      fi
    done
    (( remaining == 0 )) && break
    sleep 0.1
  done
  for pid in "${expected_pids[@]}"; do
    if kill -0 "$pid" >/dev/null 2>&1; then
      print -u2 "Timed out waiting for verified bridge PID $pid to stop; it was not force-killed."
      return 1
    fi
  done

  SESSION_ATLAS_BRIDGE_RUNTIME=$expected_runtime
  rm -f "$snapshot_before" "$snapshot_confirm"
  trap - EXIT INT TERM
}

session_atlas_restart_owned_iterm_bridge() {
  emulate -L zsh

  local bridge_link=$1
  local bridge_source=$2
  local wrapper_path=${3:-$SESSION_ATLAS_ITERM_API_WRAPPER}
  local runner_path=${4:-$SESSION_ATLAS_ITERM_RUNNER}
  local runtime snapshot

  if ! session_atlas_bridge_link_is_owned "$bridge_link" "$bridge_source"; then
    print -u2 "Refusing to restart an iTerm bridge link not owned by this Session Atlas checkout: $bridge_link"
    return 1
  fi
  if [[ ! -f "$wrapper_path" ]]; then
    print -u2 "Cannot find the iTerm Python wrapper: $wrapper_path"
    return 1
  fi
  session_atlas_plan_iterm_bridge_launch "$bridge_link" "$bridge_source" "$runner_path" || return 1

  # Validate the runtime before stopping a healthy bridge. If its executable
  # disappeared or process ownership is ambiguous, leave every process alone.
  snapshot=$(mktemp "${TMPDIR:-/tmp}/session-atlas-bridge-ps.XXXXXX")
  session_atlas_snapshot_processes "$snapshot"
  if ! session_atlas_iterm_is_running_in_snapshot "$snapshot" "$(id -u)"; then
    rm -f "$snapshot"
    print "iTerm2 is not running. The owned bridge will start on the next iTerm AutoLaunch cycle."
    return 0
  fi
  if ! session_atlas_plan_owned_bridge_processes "$snapshot" "$(id -u)" "$wrapper_path" "$bridge_source"; then
    rm -f "$snapshot"
    return 1
  fi
  runtime=$SESSION_ATLAS_BRIDGE_RUNTIME
  rm -f "$snapshot"
  if [[ -n "$runtime" && ! -x "$runtime" ]]; then
    print -u2 "The verified iTerm Python runtime is not executable; the existing bridge was left running: $runtime"
    return 1
  fi

  session_atlas_stop_owned_iterm_bridge "$bridge_link" "$bridge_source" "$wrapper_path" || return 1
  if [[ -n "$SESSION_ATLAS_BRIDGE_RUNTIME" ]]; then
    runtime=$SESSION_ATLAS_BRIDGE_RUNTIME
  fi

  if [[ -z "$runtime" ]]; then
    snapshot=$(mktemp "${TMPDIR:-/tmp}/session-atlas-bridge-ps.XXXXXX")
    session_atlas_snapshot_processes "$snapshot"
    session_atlas_plan_owned_bridge_processes "$snapshot" "$(id -u)" "$wrapper_path" "$bridge_source" || {
      rm -f "$snapshot"
      return 1
    }
    runtime=$SESSION_ATLAS_BRIDGE_RUNTIME
    rm -f "$snapshot"
  fi

  if [[ -n "$runtime" && ! -x "$runtime" ]]; then
    print -u2 "The verified iTerm Python runtime is not executable: $runtime"
    return 1
  fi

  if ! "${SESSION_ATLAS_ITERM_LAUNCH_COMMAND[@]}"; then
    print -u2 "iTerm rejected the request to launch its Session Atlas AutoLaunch script."
    return 1
  fi

  for _ in {1..50}; do
    snapshot=$(mktemp "${TMPDIR:-/tmp}/session-atlas-bridge-ps.XXXXXX")
    session_atlas_snapshot_processes "$snapshot"
    if session_atlas_plan_owned_bridge_processes "$snapshot" "$(id -u)" "$wrapper_path" "$bridge_source" >/dev/null 2>&1 \
      && (( ${#SESSION_ATLAS_BRIDGE_WRAPPER_PIDS} == 1 )) \
      && [[ -n "$SESSION_ATLAS_BRIDGE_RUNTIME" && -x "$SESSION_ATLAS_BRIDGE_RUNTIME" ]] \
      && { [[ -z "$runtime" ]] || [[ "$SESSION_ATLAS_BRIDGE_RUNTIME" == "$runtime" ]]; }; then
      rm -f "$snapshot"
      print "Restarted the owned iTerm bridge through it2run with Python runtime: $SESSION_ATLAS_BRIDGE_RUNTIME"
      return 0
    fi
    rm -f "$snapshot"
    sleep 0.1
  done

  print -u2 "The latest bridge was launched but one exact wrapper/child pair could not be verified. No unrelated process was changed."
  return 1
}

session_atlas_launch_agent_plist_is_owned() {
  emulate -L zsh

  local plist_path=$1
  local project_root="${2:A}"
  local expected_server="$project_root/dist/node/server/index.js"
  local actual_label
  local argument_count
  local program_argument
  local server_argument

  if [[ -L "$plist_path" ]]; then
    print -u2 "LaunchAgent plist is a symbolic link: $plist_path"
    return 1
  fi

  if [[ ! -f "$plist_path" ]]; then
    print -u2 "LaunchAgent plist is not a regular file: $plist_path"
    return 1
  fi

  if ! actual_label=$(plutil -extract Label raw -expect string -o - -- "$plist_path" 2>/dev/null); then
    print -u2 "LaunchAgent plist has no readable Label: $plist_path"
    return 1
  fi

  if [[ "$actual_label" != "$SESSION_ATLAS_LAUNCH_AGENT_LABEL" ]]; then
    print -u2 "LaunchAgent Label is '$actual_label', expected '$SESSION_ATLAS_LAUNCH_AGENT_LABEL'."
    return 1
  fi

  if ! argument_count=$(plutil -extract ProgramArguments raw -expect array -o - -- "$plist_path" 2>/dev/null); then
    print -u2 "LaunchAgent plist has no readable ProgramArguments array: $plist_path"
    return 1
  fi

  if [[ "$argument_count" != "2" ]]; then
    print -u2 "LaunchAgent ProgramArguments must contain exactly the Node executable and Session Atlas server."
    return 1
  fi

  if ! program_argument=$(plutil -extract ProgramArguments.0 raw -expect string -o - -- "$plist_path" 2>/dev/null) || [[ "${program_argument:t}" != "node" ]]; then
    print -u2 "LaunchAgent ProgramArguments do not start with a Node executable."
    return 1
  fi

  if ! server_argument=$(plutil -extract ProgramArguments.1 raw -expect string -o - -- "$plist_path" 2>/dev/null) || [[ "$server_argument" != "$expected_server" ]]; then
    print -u2 "LaunchAgent ProgramArguments do not point to the expected server: $expected_server"
    return 1
  fi
}
