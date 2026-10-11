#!/usr/bin/env bash
set -euo pipefail

age_binary="${NURITEO_TEST_AGE_BINARY:?set NURITEO_TEST_AGE_BINARY to the reference Go age CLI}"
if [[ ! -x "$age_binary" ]]; then
  echo "reference age CLI is not executable" >&2
  exit 2
fi

fixture_dir="$(mktemp -d "${TMPDIR:-/tmp}/nuriteo-recovery-kit.XXXXXX")"
cleanup() {
  rm -rf -- "$fixture_dir"
}
trap cleanup EXIT INT TERM

passphrase='correct horse battery staple'
printf '%s' "$passphrase" >"$fixture_dir/passphrase"
master_key="$(openssl rand -base64 32 | tr -d '\n')"

NURITEO_MASTER_KEY="$master_key" \
NURITEO_MASTER_KEY_VERSION=1 \
cargo run --quiet -p nuriteo-server -- recovery-kit export \
  --output "$fixture_dir/rust.age" \
  --passphrase-file "$fixture_dir/passphrase" >"$fixture_dir/rust-metadata.json"

NURITEO_TEST_AGE_BINARY="$age_binary" \
NURITEO_TEST_AGE_INPUT="$fixture_dir/rust.age" \
NURITEO_TEST_AGE_OUTPUT="$fixture_dir/plaintext.json" \
NURITEO_TEST_AGE_PASSPHRASE="$passphrase" \
expect <<'EXPECT'
set timeout 30
log_user 0
spawn -noecho $env(NURITEO_TEST_AGE_BINARY) --decrypt --output $env(NURITEO_TEST_AGE_OUTPUT) $env(NURITEO_TEST_AGE_INPUT)
expect "Enter passphrase:"
send -- "$env(NURITEO_TEST_AGE_PASSPHRASE)\r"
expect eof
set result [wait]
exit [lindex $result 3]
EXPECT

jq -e '
  .format == "nuriteo-recovery-kit" and
  .format_version == 1 and
  .instance_id == "instance" and
  (.master_keys | length) == 1 and
  (.key_fingerprints | length) == 1
' "$fixture_dir/plaintext.json" >/dev/null

NURITEO_TEST_AGE_BINARY="$age_binary" \
NURITEO_TEST_AGE_INPUT="$fixture_dir/plaintext.json" \
NURITEO_TEST_AGE_OUTPUT="$fixture_dir/go.age" \
NURITEO_TEST_AGE_PASSPHRASE="$passphrase" \
expect <<'EXPECT'
set timeout 30
log_user 0
spawn -noecho $env(NURITEO_TEST_AGE_BINARY) --passphrase --output $env(NURITEO_TEST_AGE_OUTPUT) $env(NURITEO_TEST_AGE_INPUT)
expect "Enter passphrase"
send -- "$env(NURITEO_TEST_AGE_PASSPHRASE)\r"
expect "Confirm passphrase:"
send -- "$env(NURITEO_TEST_AGE_PASSPHRASE)\r"
expect eof
set result [wait]
exit [lindex $result 3]
EXPECT

cargo run --quiet -p nuriteo-server -- recovery-kit inspect \
  --input "$fixture_dir/go.age" \
  --passphrase-file "$fixture_dir/passphrase" >"$fixture_dir/go-metadata.json"

jq -e --arg fingerprint "$(jq -r .artifact_sha256 "$fixture_dir/go-metadata.json")" '
  .format_version == 1 and
  .instance_id == "instance" and
  (.master_keys | length) == 1 and
  ($fingerprint | test("^[0-9a-f]{64}$"))
' "$fixture_dir/go-metadata.json" >/dev/null

"$age_binary" --version
echo "recovery-kit interop passed: rust->go and go->rust"
