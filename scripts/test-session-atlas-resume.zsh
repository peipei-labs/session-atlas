#!/bin/zsh
set -eu

script_dir=${0:A:h}
resume_helper="$script_dir/session-atlas-resume.zsh"
test_root=$(mktemp -d "${TMPDIR:-/tmp}/session-atlas-resume.XXXXXX")
test_bin="$test_root/bin"
test_project="$test_root/project"
test_count="$test_root/count"
test_args="$test_root/args"
test_port="$test_root/port"
test_curl_args="$test_root/curl-args"
test_curl_count="$test_root/curl-count"
test_shell_args="$test_root/shell-args"
test_session_id="01234567-89ab-cdef-8123-456789abcdef"
test_terminal_session_id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

cleanup() {
  command rm -f \
    "$test_bin/codex" \
    "$test_bin/curl" \
    "$test_bin/shell" \
    "$test_count" \
    "$test_args" \
    "$test_port" \
    "$test_curl_args" \
    "$test_curl_count" \
    "$test_shell_args"
  rmdir "$test_bin" "$test_project" "$test_root" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM

mkdir "$test_bin" "$test_project"
print -r -- '#!/bin/zsh
set -u
typeset -i call_count=0
[[ -f "$SESSION_ATLAS_TEST_COUNT" ]] && call_count=$(<"$SESSION_ATLAS_TEST_COUNT")
(( call_count += 1 ))
print -r -- "$call_count" > "$SESSION_ATLAS_TEST_COUNT"
print -r -- "$*" >> "$SESSION_ATLAS_TEST_ARGS"
print -r -- "$SESSION_ATLAS_PORT" > "$SESSION_ATLAS_TEST_PORT"
if [[ "$1" != resume || "$2" != -c || "$3" != hooks=* || "$4" != -C || "$5" != "$SESSION_ATLAS_TEST_PROJECT" || "$6" != "$SESSION_ATLAS_TEST_SESSION_ID" || $# != 6 ]]; then
  exit 98
fi
case "$SESSION_ATLAS_TEST_MODE" in
  success) exit 0 ;;
  retry) (( call_count < 3 )) && exit 1; exit 0 ;;
  interrupt) exit 130 ;;
  *) exit 99 ;;
esac' > "$test_bin/codex"
print -r -- '#!/bin/zsh
set -u
print -r -- "$*" >> "$SESSION_ATLAS_TEST_CURL_ARGS"
typeset -i call_count=0
[[ -f "$SESSION_ATLAS_TEST_CURL_COUNT" ]] && call_count=$(<"$SESSION_ATLAS_TEST_CURL_COUNT")
(( call_count += 1 ))
print -r -- "$call_count" > "$SESSION_ATLAS_TEST_CURL_COUNT"
if [[ "$SESSION_ATLAS_TEST_CURL_MODE" == "failure" ]]; then
  exit 7
elif [[ "$SESSION_ATLAS_TEST_CURL_MODE" == "malformed" ]]; then
  print -r -- "not-json"
  exit 0
elif [[ "$SESSION_ATLAS_TEST_CURL_MODE" == "retry" && call_count -lt 3 ]]; then
  exit 7
fi
if [[ "$SESSION_ATLAS_TEST_ACTIVE" == "1" ]]; then
  print -r -- "{\"activeElsewhere\":true,\"duplicateProfileCleared\":true}"
else
  print -r -- "{\"activeElsewhere\":false,\"duplicateProfileCleared\":false}"
fi' > "$test_bin/curl"
print -r -- '#!/bin/zsh
set -u
print -r -- "$*" >> "$SESSION_ATLAS_TEST_SHELL_ARGS"
exit 0' > "$test_bin/shell"
chmod +x "$test_bin/codex" "$test_bin/curl" "$test_bin/shell"

run_helper() {
  PATH="$test_bin:$PATH" \
    SHELL="$test_bin/shell" \
    ITERM_SESSION_ID="w0t0p0:$test_terminal_session_id" \
    SESSION_ATLAS_TEST_COUNT="$test_count" \
    SESSION_ATLAS_TEST_ARGS="$test_args" \
    SESSION_ATLAS_TEST_PORT="$test_port" \
    SESSION_ATLAS_TEST_PROJECT="$test_project" \
    SESSION_ATLAS_TEST_SESSION_ID="$test_session_id" \
    SESSION_ATLAS_TEST_CURL_ARGS="$test_curl_args" \
    SESSION_ATLAS_TEST_CURL_COUNT="$test_curl_count" \
    SESSION_ATLAS_TEST_SHELL_ARGS="$test_shell_args" \
    SESSION_ATLAS_TEST_ACTIVE="${2:-0}" \
    SESSION_ATLAS_TEST_CURL_MODE="${3:-success}" \
    SESSION_ATLAS_PREFLIGHT_RETRY_SECONDS=0 \
    SESSION_ATLAS_RESUME_RETRY_SECONDS=0 \
    SESSION_ATLAS_TEST_MODE="$1" \
    "$resume_helper" \
      --cwd "$test_project" \
      --session-id "$test_session_id" \
      --controller-port 5432
}

run_helper success
[[ "$(<"$test_count")" == "1" ]]
[[ "$(<"$test_args")" == "resume -c $(<"$script_dir/session-atlas-lifecycle.toml") -C $test_project $test_session_id" ]]
[[ "$(<"$test_port")" == "5432" ]]
grep -q -- "http://127.0.0.1:5432/api/recoveries/preflight" "$test_curl_args"

command rm -f "$test_count" "$test_args" "$test_curl_args" "$test_curl_count"
run_helper success 0 retry
[[ "$(<"$test_curl_count")" == "3" ]]
[[ "$(<"$test_count")" == "1" ]]

command rm -f "$test_count" "$test_args" "$test_curl_count"
run_helper retry
[[ "$(<"$test_count")" == "3" ]]

command rm -f "$test_count" "$test_args" "$test_curl_count"
if run_helper interrupt; then
  print -u2 "Expected an interrupted Codex process to remain interrupted."
  exit 1
else
  recovery_test_status=$?
fi
[[ "$recovery_test_status" == "130" ]]
[[ "$(<"$test_count")" == "1" ]]

command rm -f "$test_count" "$test_args" "$test_curl_args" "$test_curl_count" "$test_shell_args"
run_helper success 1
[[ ! -e "$test_count" ]]
[[ "$(<"$test_shell_args")" == "-l" ]]
grep -q -- "/api/recoveries/preflight" "$test_curl_args"
grep -q -- "$test_terminal_session_id" "$test_curl_args"
for preflight_mode in failure malformed; do
  command rm -f "$test_count" "$test_args" "$test_curl_args" "$test_curl_count" "$test_shell_args"
  run_helper success 0 "$preflight_mode"
  [[ ! -e "$test_count" ]]
  [[ "$(<"$test_shell_args")" == "-l" ]]
  [[ "$(<"$test_curl_count")" == "5" ]]
done

command rm -f "$test_count" "$test_args" "$test_curl_args" "$test_curl_count" "$test_shell_args"
if PATH="$test_bin:$PATH" "$resume_helper" --cwd "$test_project" --session-id invalid; then
  print -u2 "Expected an invalid Codex session ID to be rejected."
  exit 1
else
  recovery_test_status=$?
fi
[[ "$recovery_test_status" == "64" ]]
[[ ! -e "$test_count" ]]

print "Session Atlas resume helper checks passed."
