#!/bin/sh
set -eu

public_key="${1:?public key path is required}"
directory="${2:-release/ga/artifacts}"
openssl dgst -sha256 -verify "$public_key" -signature "$directory/SHA256SUMS.sig" "$directory/SHA256SUMS"
shasum -a 256 -c "$directory/SHA256SUMS"
