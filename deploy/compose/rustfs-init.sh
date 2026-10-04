#!/bin/sh
set -eu

bucket="${NURITEO_BUNDLED_S3_BUCKET:?missing bundled bucket}"
external_url="${NURITEO_EXTERNAL_URL:?missing external URL}"
case "$bucket" in
  ""|*[!a-z0-9.-]*|.*|*..*|*.)
    echo "storage-init failed (configuration)" >&2
    exit 1
    ;;
esac
case "$external_url" in
  http://localhost:*|http://127.0.0.1:*|https://*) ;;
  *)
    echo "storage-init failed (external-url)" >&2
    exit 1
    ;;
esac
origin="${external_url%/}"
case "$origin" in
  *"*"*|*"?"*|*"#"*|*"<"*|*">"*|*"&"*|*"'"*|*'"'*)
    echo "storage-init failed (external-url)" >&2
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

cors_file="$(mktemp /tmp/nuriteo-storage-cors.XXXXXX)"
trap 'rm -f "$response" "$cors_file"' EXIT HUP INT TERM
{
  printf '%s' '<CORSConfiguration><CORSRule><ID>nuriteo-browser-upload-v1</ID><AllowedOrigin>'
  printf '%s' "$origin"
  printf '%s' '</AllowedOrigin><AllowedMethod>PUT</AllowedMethod><AllowedHeader>content-type</AllowedHeader><AllowedHeader>x-amz-checksum-sha256</AllowedHeader><AllowedHeader>x-amz-sdk-checksum-algorithm</AllowedHeader><ExposeHeader>etag</ExposeHeader><ExposeHeader>x-amz-checksum-sha256</ExposeHeader><MaxAgeSeconds>300</MaxAgeSeconds></CORSRule></CORSConfiguration>'
} > "$cors_file"
status="$(curl --silent --output "$response" --write-out '%{http_code}' \
  --cacert /etc/rustfs/tls/ca.crt \
  --aws-sigv4 aws:amz:us-east-1:s3 --user "$auth" \
  --header 'Content-Type: application/xml' \
  --request PUT --data-binary "@$cors_file" "$endpoint?cors")" || {
  echo "storage-init failed (cors-unavailable)" >&2
  exit 1
}
if [ "$status" != 200 ]; then
  echo "storage-init failed (cors-configure)" >&2
  exit 1
fi

echo "storage-init ready"
