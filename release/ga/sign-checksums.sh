#!/bin/sh
set -eu

key="${1:?private key path is required}"
directory="${2:-release/ga/artifacts}"
openssl dgst -sha256 -sign "$key" -out "$directory/SHA256SUMS.sig" "$directory/SHA256SUMS"
