#!/bin/sh
set -eu

root="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
report="${1:-$root/release/ga/reproducible-images.json}"
output="${2:-$root/release/ga/artifacts}"
version="1.0.0"
mkdir -p "$output"
helm lint "$root/charts/nuriteo"
helm package "$root/charts/nuriteo" --version "$version" --app-version "$version" --destination "$output" >/dev/null
chart="$output/nuriteo-$version.tgz"
chart_sha="$(shasum -a 256 "$chart" | awk '{print $1}')"
jq --arg version "$version" --arg chart "$(basename "$chart")" --arg chartSha "$chart_sha" \
  '{schemaVersion:1,taskId:"REL-003",version:$version,chart:{path:$chart,sha256:$chartSha},sourceCommit,
    images:(.images|sort_by(.platform,.role))}' "$report" >"$output/nuriteo-$version.chart-images.json"
printf '%s\n' "${chart_sha}  ${chart}" >"$output/CHART-SHA256SUMS"
if [ -f "$output/SHA256SUMS" ]; then
  binding="$output/nuriteo-$version.chart-images.json"
  { cat "$output/SHA256SUMS"; (cd "$output" && shasum -a 256 "$(basename "$chart")" "$(basename "$binding")"); } | sort -k2 >"$output/SHA256SUMS.next"
  mv "$output/SHA256SUMS.next" "$output/SHA256SUMS"
fi
printf '%s\n' "{\"status\":\"pass\",\"task\":\"REL-003\",\"chartSha256\":\"$chart_sha\"}"
