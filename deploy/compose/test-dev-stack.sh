#!/usr/bin/env bash
set -Eeuo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/nuriteo-dev-stack.XXXXXX")"
stack="$repository_root/deploy/compose/dev-stack.sh"
export NURITEO_DEV_STATE_DIR="$fixture_root/state"
export NURITEO_DEV_WEB_PORT=19307

cleanup() {
  rm -rf -- "$fixture_root"
}
trap cleanup EXIT HUP INT TERM

"$stack" init >/dev/null
[ -f "$NURITEO_DEV_STATE_DIR/.nuriteo-dev-state" ]
[ "$(stat -f '%Lp' "$NURITEO_DEV_STATE_DIR" 2>/dev/null || stat -c '%a' "$NURITEO_DEV_STATE_DIR")" = 700 ]

for path in \
  postgres-password \
  database-url \
  database-url-host \
  rustfs-access-key \
  rustfs-secret-key \
  bootstrap-admin-password \
  preview-signing-key \
  save-idempotency-secret \
  master-key \
  postgres-tls/ca.crt \
  postgres-tls/server.crt \
  postgres-tls/server.key \
  rustfs-tls/ca.crt \
  rustfs-tls/rustfs_cert.pem \
  rustfs-tls/rustfs_key.pem; do
  [ -s "$NURITEO_DEV_STATE_DIR/$path" ] || { echo "missing local stack material: $path" >&2; exit 1; }
done

openssl x509 -in "$NURITEO_DEV_STATE_DIR/postgres-tls/server.crt" -noout -ext subjectAltName | grep -Fq 'DNS:postgres'
openssl x509 -in "$NURITEO_DEV_STATE_DIR/postgres-tls/server.crt" -noout -ext subjectAltName | grep -Fq 'IP Address:127.0.0.1'
openssl x509 -in "$NURITEO_DEV_STATE_DIR/rustfs-tls/rustfs_cert.pem" -noout -ext subjectAltName | grep -Fq 'DNS:rustfs'
openssl x509 -in "$NURITEO_DEV_STATE_DIR/rustfs-tls/rustfs_cert.pem" -noout -ext subjectAltName | grep -Fq 'IP Address:127.0.0.1'
grep -Eq '^postgres://nuriteo:[0-9a-f]+@postgres:5432/nuriteo$' "$NURITEO_DEV_STATE_DIR/database-url"
grep -Eq '^postgres://nuriteo:[0-9a-f]+@127\.0\.0\.1:15432/nuriteo$' "$NURITEO_DEV_STATE_DIR/database-url-host"

before="$(shasum -a 256 "$NURITEO_DEV_STATE_DIR/bootstrap-admin-password" "$NURITEO_DEV_STATE_DIR/postgres-tls/ca.crt")"
"$stack" init >/dev/null
after="$(shasum -a 256 "$NURITEO_DEV_STATE_DIR/bootstrap-admin-password" "$NURITEO_DEV_STATE_DIR/postgres-tls/ca.crt")"
[ "$before" = "$after" ] || { echo "init rotated persistent local credentials" >&2; exit 1; }

credentials="$($stack credentials)"
grep -Fq 'URL:      http://127.0.0.1:19307' <<<"$credentials"
grep -Fq 'Email:    admin@example.test' <<<"$credentials"
grep -Fq "Password: $(cat "$NURITEO_DEV_STATE_DIR/bootstrap-admin-password")" <<<"$credentials"

if "$stack" reset >"$fixture_root/reset.out" 2>&1; then
  echo "reset without --yes unexpectedly succeeded" >&2
  exit 1
fi
grep -Fq 'rerun with --yes' "$fixture_root/reset.out"
[ -f "$NURITEO_DEV_STATE_DIR/.nuriteo-dev-state" ]

echo "persistent local development stack bootstrap test ok"
