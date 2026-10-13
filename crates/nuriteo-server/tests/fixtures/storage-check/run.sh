#!/bin/sh
set -eu

image='docker.io/rustfs/rustfs@sha256:42edb61d588775f9431ff436216d14392d2234d4eb2ed68321569fbf7245b36b'
container='nuriteo-s3-004-rustfs'
fixture_root=$(mktemp -d)
cert_dir="$fixture_root/certs"
mkdir -p "$cert_dir"

cleanup() {
  podman rm --force "$container" >/dev/null 2>&1 || true
  rm -rf -- "$fixture_root"
}
trap cleanup EXIT INT TERM

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$fixture_root/ca.key" -out "$fixture_root/ca.crt" -days 2 \
  -subj '/CN=nuriteo-s3-004-test-ca' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes \
  -keyout "$cert_dir/rustfs_key.pem" -out "$fixture_root/server.csr" \
  -subj '/CN=localhost' >/dev/null 2>&1
printf '%s\n' \
  'subjectAltName=DNS:localhost,IP:127.0.0.1' \
  'basicConstraints=critical,CA:FALSE' \
  'keyUsage=critical,digitalSignature,keyEncipherment' \
  'extendedKeyUsage=serverAuth' >"$fixture_root/server.ext"
openssl x509 -req -in "$fixture_root/server.csr" \
  -CA "$fixture_root/ca.crt" -CAkey "$fixture_root/ca.key" -CAcreateserial \
  -out "$cert_dir/rustfs_cert.pem" -days 2 -extfile "$fixture_root/server.ext" \
  >/dev/null 2>&1

podman run --rm --volume "$cert_dir:/certs:ro" --entrypoint rustfs "$image" \
  tls inspect --path /certs

podman run --detach --name "$container" \
  --publish 127.0.0.1:19004:9000 \
  --volume "$cert_dir:/certs:ro" \
  --env RUSTFS_TLS_PATH=/certs \
  --env RUSTFS_ACCESS_KEY=storage-check-access \
  --env RUSTFS_SECRET_KEY=storage-check-secret-0123456789 \
  "$image" >/dev/null

attempt=0
until curl --fail --silent --show-error --cacert "$fixture_root/ca.crt" \
  https://127.0.0.1:19004/health >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    podman inspect "$container" --format 'state={{.State.Status}} exit={{.State.ExitCode}}' >&2 || true
    echo 'HTTPS RustFS readiness timed out' >&2
    exit 1
  fi
  sleep 1
done

NURITEO_TEST_S3_ENDPOINT='https://127.0.0.1:19004' \
NURITEO_TEST_S3_CA_FILE="$fixture_root/ca.crt" \
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$fixture_root/target}" \
cargo test -p nuriteo-server --test storage_check_cli --all-features -- \
  --ignored --exact storage_check_subprocess_is_safe_and_leaves_no_probe_objects
