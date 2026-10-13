#!/bin/sh
set -eu

root="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/nuriteo-rel002.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT HUP INT TERM
mkdir -p "$work/artifacts"
printf '%s\n' 'rehearsal artifact' >"$work/artifacts/payload.txt"
(cd / && shasum -a 256 "$work/artifacts/payload.txt") >"$work/artifacts/SHA256SUMS"
openssl genpkey -quiet -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$work/private.pem"
openssl pkey -in "$work/private.pem" -pubout -out "$work/public.pem" >/dev/null
"$root/release/ga/sign-checksums.sh" "$work/private.pem" "$work/artifacts"
"$root/release/ga/verify-supply-chain.sh" "$work/public.pem" "$work/artifacts" >/dev/null
cp "$work/artifacts/SHA256SUMS" "$work/tampered"
printf '%s\n' '#tampered' >>"$work/tampered"
if openssl dgst -sha256 -verify "$work/public.pem" -signature "$work/artifacts/SHA256SUMS.sig" "$work/tampered" >/dev/null 2>&1; then
  echo "tampered checksum manifest was accepted" >&2
  exit 1
fi
printf '%s\n' '{"status":"pass","task":"REL-002","offlineSignature":true,"tamperRejected":true}'
