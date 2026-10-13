#!/bin/sh
set -eu

image='docker.io/rustfs/rustfs@sha256:42edb61d588775f9431ff436216d14392d2234d4eb2ed68321569fbf7245b36b'
container='nuriteo-s3-002-rustfs'
endpoint='http://127.0.0.1:19000/health'

cleanup() {
  podman rm --force "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

podman run --detach --name "$container" \
  --publish 127.0.0.1:19000:9000 \
  --env RUSTFS_ACCESS_KEY=integration-access \
  --env RUSTFS_SECRET_KEY=integration-secret-0123456789 \
  "$image" >/dev/null

attempt=0
until curl --fail --silent --show-error "$endpoint" >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo 'RustFS readiness timed out' >&2
    exit 1
  fi
  sleep 1
done

cargo test -p nuriteo-server --test s3_rustfs --all-features -- \
  --ignored --exact rustfs_object_operations_contract
