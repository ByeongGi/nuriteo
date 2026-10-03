#!/bin/sh
set -eu

bucket="${NURITEO_BUNDLED_S3_BUCKET:?missing bundled bucket}"
case "$bucket" in
  ""|*[!a-z0-9.-]*|.*|*..*|*.)
    echo "storage-init failed (configuration)" >&2
    exit 1
    ;;
esac

access="$(cat /run/secrets/rustfs_access_key)"
secret="$(cat /run/secrets/rustfs_secret_key)"
auth="${access}:${secret}"
endpoint="https://rustfs:9000/${bucket}"
response="$(mktemp /tmp/nuriteo-storage-init.XXXXXX)"
trap 'rm -f "$response"' EXIT HUP INT TERM

status="$(curl --silent --output "$response" --write-out '%{http_code}' \
  --cacert /etc/rustfs/tls/ca.crt \
  --aws-sigv4 aws:amz:us-east-1:s3 --user "$auth" \
  --request PUT "$endpoint")" || {
  echo "storage-init failed (unavailable)" >&2
  exit 1
}
case "$status" in
  200) ;;
  409)
    grep -q '<Code>BucketAlreadyOwnedByYou</Code>' "$response" || {
      echo "storage-init failed (bucket-conflict)" >&2
      exit 1
    }
    ;;
  *)
    echo "storage-init failed (bucket-create)" >&2
    exit 1
    ;;
esac

status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --cacert /etc/rustfs/tls/ca.crt \
  --aws-sigv4 aws:amz:us-east-1:s3 --user "$auth" \
  --head "$endpoint")" || {
  echo "storage-init failed (unavailable)" >&2
  exit 1
}
if [ "$status" != 200 ]; then
  echo "storage-init failed (bucket-readiness)" >&2
  exit 1
fi

echo "storage-init ready"
