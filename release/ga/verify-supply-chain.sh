#!/bin/sh
set -eu

public_key="${1:?public key path is required}"
directory="${2:-release/ga/artifacts}"
openssl dgst -sha256 -verify "$public_key" -signature "$directory/SHA256SUMS.sig" "$directory/SHA256SUMS"
(cd "$directory" && shasum -a 256 -c SHA256SUMS)
if [ -f "$directory/RELEASE-SHA256SUMS" ]; then
  openssl dgst -sha256 -verify "$public_key" -signature "$directory/RELEASE-SHA256SUMS.sig" "$directory/RELEASE-SHA256SUMS"
  (cd "$directory" && shasum -a 256 -c RELEASE-SHA256SUMS)
fi
