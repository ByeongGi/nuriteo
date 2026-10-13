#!/usr/bin/env bash
set -euo pipefail

script_dir="${BASH_SOURCE[0]%/*}"
runtime="$(<"$script_dir/runtime-path")"
container="$(<"$script_dir/container-name")"
archive="${!#}"
remote="/tmp/nuriteo-bkp-004-$$.dump"
cleanup() {
  "$runtime" exec "$container" rm -f "$remote" >/dev/null 2>&1 || true
}
trap cleanup EXIT
"$runtime" cp "$archive" "$container:$remote"
args=("$@")
args[$((${#args[@]} - 1))]="$remote"
for ((index = 0; index < ${#args[@]}; index++)); do
  case "${args[$index]}" in
    --host) args[$((index + 1))]=localhost ;;
    --port) args[$((index + 1))]=5432 ;;
  esac
done
"$runtime" exec --env "PGPASSWORD=${PGPASSWORD:-}" --env PGSSLMODE=disable \
  "$container" pg_restore "${args[@]}"
