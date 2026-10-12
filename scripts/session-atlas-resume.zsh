#!/bin/zsh
set -u

typeset recovery_cwd=""
typeset recovery_session_id=""
typeset recovery_controller_port=""

while (( $# > 0 )); do
  case "$1" in
    --cwd)
      (( $# >= 2 )) || { print -u2 "Session Atlas resume helper: --cwd needs a value"; exit 64; }
      recovery_cwd=$2
      shift 2
      ;;
    --session-id)
      (( $# >= 2 )) || { print -u2 "Session Atlas resume helper: --session-id needs a value"; exit 64; }
      recovery_session_id=$2
      shift 2
      ;;
    --controller-port)
      (( $# >= 2 )) || { print -u2 "Session Atlas resume helper: --controller-port needs a value"; exit 64; }
      recovery_controller_port=$2
      shift 2
      ;;
    *)
      print -u2 "Session Atlas resume helper: unsupported argument: $1"
      exit 64
      ;;
  esac
done

typeset uuid_pattern='^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'
if [[ "$recovery_cwd" != /* || ! -d "$recovery_cwd" ]]; then
  print -u2 "Session Atlas resume helper: recorded working directory is unavailable"
  exit 72
fi
if [[ ! "$recovery_session_id" =~ "$uuid_pattern" ]]; then
  print -u2 "Session Atlas resume helper: recorded Codex session ID is invalid"
  exit 64
fi

start_safe_shell() {
  typeset recovery_shell_path=${SHELL:-/bin/zsh}
  if [[ ! -x "$recovery_shell_path" ]]; then
    recovery_shell_path=/bin/zsh
  fi
  print "Session Atlas: $1; starting a shell in this pane."
  exec "$recovery_shell_path" -l
}

typeset recovery_iterm_session_id=${ITERM_SESSION_ID:-}
typeset recovery_terminal_session_id=${recovery_iterm_session_id##*:}
if [[ -z "$recovery_controller_port" ]]; then
  recovery_controller_port=${SESSION_ATLAS_PORT:-4317}
fi
if [[ ! "$recovery_controller_port" =~ '^[0-9]{1,5}$' ]] ||
  (( recovery_controller_port < 1 || recovery_controller_port > 65535 )); then
  recovery_controller_port=4317
fi
typeset recovery_preflight_state="unavailable"
typeset recovery_curl_path=""
recovery_curl_path=$(command -v curl 2>/dev/null) || true
if [[ "$recovery_terminal_session_id" =~ "$uuid_pattern" && -n "$recovery_curl_path" ]]; then
  typeset recovery_preflight_response=""
  typeset recovery_preflight_body="{\"conversationId\":\"${recovery_session_id}\",\"terminalSessionId\":\"${recovery_terminal_session_id}\"}"
  typeset -i recovery_preflight_attempt=1
  typeset -i recovery_preflight_max_attempts=5
  typeset recovery_preflight_retry_seconds=${SESSION_ATLAS_PREFLIGHT_RETRY_SECONDS:-1}
  if [[ ! "$recovery_preflight_retry_seconds" =~ '^[0-9]+$' ]] ||
    (( recovery_preflight_retry_seconds > 60 )); then
    print -u2 "Session Atlas resume helper: invalid preflight retry delay"
    exit 64
  fi
  while (( recovery_preflight_attempt <= recovery_preflight_max_attempts )); do
    if recovery_preflight_response=$(
      "$recovery_curl_path" \
        --fail \
        --silent \
        --show-error \
        --noproxy '*' \
        --max-time 2 \
        --header 'Content-Type: application/json' \
        --data-binary "$recovery_preflight_body" \
        "http://127.0.0.1:${recovery_controller_port}/api/recoveries/preflight" \
        2>/dev/null
    ); then
      if [[ "$recovery_preflight_response" == *'"activeElsewhere":true'* ]]; then
        recovery_preflight_state="active"
      elif [[ "$recovery_preflight_response" == *'"activeElsewhere":false'* ]]; then
        recovery_preflight_state="clear"
      fi
    fi
    [[ "$recovery_preflight_state" != "unavailable" ]] && break
    (( recovery_preflight_attempt == recovery_preflight_max_attempts )) && break
    sleep "$recovery_preflight_retry_seconds"
    (( recovery_preflight_attempt += 1 ))
  done
fi
if [[ "$recovery_preflight_state" == "active" ]]; then
  start_safe_shell "this Codex session is already open"
elif [[ "$recovery_preflight_state" != "clear" ]]; then
  start_safe_shell "session ownership could not be verified"
fi

typeset recovery_codex_path=""
recovery_codex_path=$(command -v codex 2>/dev/null) || true
if [[ -z "$recovery_codex_path" ]]; then
  for recovery_codex_candidate in \
    /opt/homebrew/bin/codex \
    /usr/local/bin/codex \
    "$HOME/.local/bin/codex"
  do
    if [[ -x "$recovery_codex_candidate" ]]; then
      recovery_codex_path=$recovery_codex_candidate
      break
    fi
  done
fi
if [[ -z "$recovery_codex_path" ]]; then
  print -u2 "Session Atlas resume helper: codex is unavailable"
  exit 127
fi

cd -- "$recovery_cwd" || exit 72

typeset recovery_lifecycle_config_path="${0:A:h}/session-atlas-lifecycle.toml"
typeset -a recovery_lifecycle_args=()
if [[ -r "$recovery_lifecycle_config_path" ]]; then
  recovery_lifecycle_args=(-c "$(<"$recovery_lifecycle_config_path")")
else
  print "Session Atlas: 自动维护提示未加载；需要更新原卡时可使用 \$session-atlas-handoff。"
fi

typeset -i recovery_attempt=1
typeset -i recovery_max_attempts=3
typeset -i recovery_status=1
typeset -i recovery_retry_seconds=${SESSION_ATLAS_RESUME_RETRY_SECONDS:-2}

if (( recovery_retry_seconds < 0 || recovery_retry_seconds > 60 )); then
  print -u2 "Session Atlas resume helper: invalid retry delay"
  exit 64
fi

while (( recovery_attempt <= recovery_max_attempts )); do
  if (( recovery_attempt > 1 )); then
    print "Session Atlas: retrying Codex recovery (${recovery_attempt}/${recovery_max_attempts})…"
  fi

  SESSION_ATLAS_PORT="$recovery_controller_port" "$recovery_codex_path" resume "${recovery_lifecycle_args[@]}" -C "$recovery_cwd" "$recovery_session_id"
  recovery_status=$?

  # A normal Codex exit includes /quit. It is intentional and must stay closed.
  (( recovery_status == 0 )) && exit 0
  # Preserve explicit terminal interruption instead of immediately reopening Codex.
  (( recovery_status == 130 || recovery_status == 143 )) && exit "$recovery_status"
  (( recovery_attempt == recovery_max_attempts )) && break

  sleep "$recovery_retry_seconds"
  (( recovery_attempt += 1 ))
done

print -u2 "Session Atlas: Codex recovery stopped after ${recovery_max_attempts} failed attempts."
exit "$recovery_status"
