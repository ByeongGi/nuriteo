#!/usr/bin/env bash
set -euo pipefail

script_dir="${BASH_SOURCE[0]%/*}"
runtime="$(<"$script_dir/runtime-path")"
container="$(<"$script_dir/container-name")"
args=("$@")
for ((index = 0; index < ${#args[@]}; index++)); do
  case "${args[$index]}" in
    --host) args[$((index + 1))]=localhost ;;
    --port) args[$((index + 1))]=5432 ;;
  esac
done
exec "$runtime" exec --env "PGPASSWORD=${PGPASSWORD:-}" --env PGSSLMODE=disable \
  "$container" pg_dump "${args[@]}"
