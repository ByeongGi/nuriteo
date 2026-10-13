#!/bin/sh
set -eu

root="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
source_directory="${1:?source artifact directory is required}"
public_key="${2:?verification public key is required}"
destination="${3:?rehearsal destination is required}"
release="1.0.0"
target="$destination/releases/$release"

if [ -e "$target" ]; then
  echo "immutable release already exists: $target" >&2
  exit 1
fi
mkdir -p "$destination/releases" "$destination/channels"
cp -R "$source_directory" "$target"
"$root/release/ga/verify-supply-chain.sh" "$public_key" "$target" >/dev/null
node "$root/release/ga/verify-chart-binding.mjs" "$target/nuriteo-$release.chart-images.json" >/dev/null
node "$root/release/ga/verify-release-manifest.mjs" "$target" >/dev/null
cp "$target/channels.json" "$destination/channels/stable.json"

manifest_commit="$(jq -r .sourceCommit "$target/nuriteo-$release.release.json")"
git -C "$root" merge-base --is-ancestor "$manifest_commit" HEAD
printf '%s\n' "{\"status\":\"pass\",\"task\":\"REL-005\",\"release\":\"$release\",\"immutable\":true}"
