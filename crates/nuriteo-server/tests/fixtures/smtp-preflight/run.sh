#!/bin/sh
set -eu

fixture_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$fixture_dir/../../../.." && pwd)
tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/nuriteo-smtp-preflight.XXXXXX")
server_pid=""

cleanup() {
  if [ -n "$server_pid" ]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp_dir"
}
trap cleanup EXIT INT TERM

port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj '/CN=NURITEO SMTP fixture CA' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -keyout "$tmp_dir/ca.key" -out "$tmp_dir/ca.pem" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -subj '/CN=localhost' \
  -keyout "$tmp_dir/server.key" -out "$tmp_dir/server.csr" >/dev/null 2>&1
printf '%s\n' 'subjectAltName=DNS:localhost' 'extendedKeyUsage=serverAuth' > "$tmp_dir/server.ext"
openssl x509 -req -days 1 -sha256 -in "$tmp_dir/server.csr" \
  -CA "$tmp_dir/ca.pem" -CAkey "$tmp_dir/ca.key" -CAcreateserial \
  -extfile "$tmp_dir/server.ext" -out "$tmp_dir/server.pem" >/dev/null 2>&1
printf '%s\n' 'fixture-user' > "$tmp_dir/username"
printf '%s\n' 'fixture-password-sensitive' > "$tmp_dir/password"

python3 "$fixture_dir/server.py" "$port" "$tmp_dir/server.pem" "$tmp_dir/server.key" \
  >"$tmp_dir/server.log" 2>&1 &
server_pid=$!
attempt=0
while ! grep -q '^READY$' "$tmp_dir/server.log"; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 100 ]; then
    cat "$tmp_dir/server.log" >&2
    exit 1
  fi
  sleep 0.05
done

cd "$repo_dir"
NURITEO_SMTP_HOST=localhost \
NURITEO_SMTP_PORT="$port" \
NURITEO_SMTP_SECURITY=implicit-tls \
NURITEO_SMTP_USERNAME_FILE="$tmp_dir/username" \
NURITEO_SMTP_PASSWORD_FILE="$tmp_dir/password" \
NURITEO_SMTP_CA_FILE="$tmp_dir/ca.pem" \
NURITEO_SMTP_PREFLIGHT_TIMEOUT_MS=5000 \
cargo test -p nuriteo-server --test smtp_preflight -- --ignored --exact smtp_preflight_verifies_tls_hostname_custom_ca_and_credentials

wait "$server_pid"
server_pid=""

port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
python3 "$fixture_dir/server.py" "$port" "$tmp_dir/server.pem" "$tmp_dir/server.key" reject-auth \
  >"$tmp_dir/server-reject.log" 2>&1 &
server_pid=$!
attempt=0
while ! grep -q '^READY$' "$tmp_dir/server-reject.log"; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 100 ]; then
    cat "$tmp_dir/server-reject.log" >&2
    exit 1
  fi
  sleep 0.05
done
NURITEO_SMTP_HOST=localhost \
NURITEO_SMTP_PORT="$port" \
NURITEO_SMTP_SECURITY=implicit-tls \
NURITEO_SMTP_USERNAME_FILE="$tmp_dir/username" \
NURITEO_SMTP_PASSWORD_FILE="$tmp_dir/password" \
NURITEO_SMTP_CA_FILE="$tmp_dir/ca.pem" \
NURITEO_SMTP_PREFLIGHT_TIMEOUT_MS=5000 \
cargo test -p nuriteo-server --test smtp_preflight -- --ignored --exact smtp_preflight_redacts_authentication_rejection_response
wait "$server_pid"
server_pid=""
if grep -q 'fixture-password-sensitive' "$tmp_dir/server.log"; then
  echo 'SMTP credential leaked to fixture log' >&2
  exit 1
fi

port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
python3 "$fixture_dir/server.py" "$port" "$tmp_dir/server.pem" "$tmp_dir/server.key" allow-handshake-failure \
  >"$tmp_dir/server-negative.log" 2>&1 &
server_pid=$!
attempt=0
while ! grep -q '^READY$' "$tmp_dir/server-negative.log"; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 100 ]; then
    cat "$tmp_dir/server-negative.log" >&2
    exit 1
  fi
  sleep 0.05
done
NURITEO_SMTP_HOST=127.0.0.1 \
NURITEO_SMTP_PORT="$port" \
NURITEO_SMTP_SECURITY=implicit-tls \
NURITEO_SMTP_USERNAME_FILE="$tmp_dir/username" \
NURITEO_SMTP_PASSWORD_FILE="$tmp_dir/password" \
NURITEO_SMTP_CA_FILE="$tmp_dir/ca.pem" \
NURITEO_SMTP_PREFLIGHT_TIMEOUT_MS=5000 \
cargo test -p nuriteo-server --test smtp_preflight -- --ignored --exact smtp_preflight_rejects_hostname_mismatch_without_leaking
wait "$server_pid"
server_pid=""
