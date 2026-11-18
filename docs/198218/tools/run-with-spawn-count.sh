#!/usr/bin/env bash
# Count content-version worker processes spawned by a command.
#
# Usage: run-with-spawn-count.sh <outdir> -- <command...>
#
# Writes trace.log, stdout.log, stderr.log into <outdir> and prints a JSON summary.
# strace is used instead of patching product code, so the measurement cannot change
# what the product does.
set -uo pipefail

out="${1:?usage: run-with-spawn-count.sh <outdir> -- <command...>}"
shift
[ "${1:-}" = "--" ] && shift

mkdir -p "$out"
start="$(date +%s.%N)"
strace -f -qq -e trace=execve -o "$out/trace.log" -- "$@" >"$out/stdout.log" 2>"$out/stderr.log"
rc=$?
end="$(date +%s.%N)"

children="$(grep -c 'content-version' "$out/trace.log" 2>/dev/null || true)"
revision_children="$(grep -c 'sqlite-source-revision' "$out/trace.log" 2>/dev/null || true)"

printf '{\n'
printf '  "command": "%s",\n' "$*"
printf '  "exit_code": %d,\n' "$rc"
printf '  "seconds": %s,\n' "$(awk -v s="$start" -v e="$end" 'BEGIN{printf "%.2f", e-s}')"
printf '  "content_version_children": %s,\n' "${children:-0}"
printf '  "sqlite_source_revision_children": %s,\n' "${revision_children:-0}"
printf '  "stdout": "%s",\n' "$out/stdout.log"
printf '  "stderr": "%s",\n' "$out/stderr.log"
printf '  "trace": "%s"\n' "$out/trace.log"
printf '}\n'

exit "$rc"
