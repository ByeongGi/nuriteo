#!/bin/sh
set -eu

key="${1:?private key path is required}"
directory="${2:-release/ga/artifacts}"
openssl dgst -sha256 -sign "$key" -out "$directory/SHA256SUMS.sig" "$directory/SHA256SUMS"
if [ -f "$directory/RELEASE-SHA256SUMS" ]; then
  openssl dgst -sha256 -sign "$key" -out "$directory/RELEASE-SHA256SUMS.sig" "$directory/RELEASE-SHA256SUMS"
fi
