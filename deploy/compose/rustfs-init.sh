#!/bin/sh
set -eu

bucket="${NURITEO_BUNDLED_S3_BUCKET:?missing bundled bucket}"
legacy_origin="${NURITEO_LEGACY_BROWSER_CORS_ORIGIN:?missing legacy browser CORS origin}"
case "$bucket" in
  ""|*[!a-z0-9.-]*|.*|*..*|*.)
    echo "storage-init failed (configuration)" >&2
    exit 1
    ;;
esac
legacy_origin="${legacy_origin%/}"
case "$legacy_origin" in
  http://localhost:*|http://127.0.0.1:*|https://*) ;;
  *)
    echo "storage-init failed (legacy-cors-origin)" >&2
    exit 1
    ;;
esac
case "$legacy_origin" in
  *"*"*|*"?"*|*"#"*|*"<"*|*">"*|*"&"*|*"'"*|*'"'*)
    echo "storage-init failed (legacy-cors-origin)" >&2
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

legacy_cors_is_exact() {
  # RustFS emits a canonical single-line document. Preserve the spaces in the
  # exact XML declaration and namespace attribute while removing line endings.
  compact="$(tr -d '\n\r\t' < "$response")"
  case "$compact" in
    '<?xml version="1.0" encoding="UTF-8"?>'*)
      compact="${compact#*>}"
      ;;
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'*)
      compact="${compact#*>}"
      ;;
  esac
  case "$compact" in
    '<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'*) ;;
    '<CORSConfiguration>'*) ;;
    *) return 1 ;;
  esac
  test "$(printf '%s' "$compact" | grep -o '<' | wc -l | tr -d ' ')" = 22 || return 1
  test "$(printf '%s' "$compact" | grep -Fo '<CORSRule>' | wc -l | tr -d ' ')" = 1 || return 1
  test "$(printf '%s' "$compact" | grep -Fo '<ID>nuriteo-browser-upload-v1</ID>' | wc -l | tr -d ' ')" = 1 || return 1
  test "$(printf '%s' "$compact" | grep -Fo "<AllowedOrigin>${legacy_origin}</AllowedOrigin>" | wc -l | tr -d ' ')" = 1 || return 1
  test "$(printf '%s' "$compact" | grep -Fo '<AllowedMethod>PUT</AllowedMethod>' | wc -l | tr -d ' ')" = 1 || return 1
  for header in content-type x-amz-checksum-sha256 x-amz-sdk-checksum-algorithm; do
    test "$(printf '%s' "$compact" | grep -Fo "<AllowedHeader>${header}</AllowedHeader>" | wc -l | tr -d ' ')" = 1 || return 1
  done
  for header in etag x-amz-checksum-sha256; do
    test "$(printf '%s' "$compact" | grep -Fo "<ExposeHeader>${header}</ExposeHeader>" | wc -l | tr -d ' ')" = 1 || return 1
  done
  test "$(printf '%s' "$compact" | grep -Fo '<MaxAgeSeconds>300</MaxAgeSeconds>' | wc -l | tr -d ' ')" = 1 || return 1
}

read_cors() {
  curl --silent --output "$response" --write-out '%{http_code}' \
    --cacert /etc/rustfs/tls/ca.crt \
    --aws-sigv4 aws:amz:us-east-1:s3 --user "$auth" \
    "$endpoint?cors"
}

status="$(read_cors)" || {
  echo "storage-init failed (legacy-cors-read)" >&2
  exit 1
}
case "$status" in
  404)
    grep -q '<Code>NoSuchCORSConfiguration</Code>' "$response" || {
      echo "storage-init failed (legacy-cors-read)" >&2
      exit 1
    }
    ;;
  200)
    legacy_cors_is_exact || {
      echo "storage-init failed (legacy-cors-drift)" >&2
      exit 1
    }
    status="$(curl --silent --output "$response" --write-out '%{http_code}' \
      --cacert /etc/rustfs/tls/ca.crt \
      --aws-sigv4 aws:amz:us-east-1:s3 --user "$auth" \
      --request DELETE "$endpoint?cors")" || {
      echo "storage-init failed (legacy-cors-remove)" >&2
      exit 1
    }
    test "$status" = 204 || {
      echo "storage-init failed (legacy-cors-remove)" >&2
      exit 1
    }
    status="$(read_cors)" || {
      echo "storage-init failed (legacy-cors-verify)" >&2
      exit 1
    }
    test "$status" = 404 && grep -q '<Code>NoSuchCORSConfiguration</Code>' "$response" || {
      echo "storage-init failed (legacy-cors-verify)" >&2
      exit 1
    }
    ;;
  *)
    echo "storage-init failed (legacy-cors-read)" >&2
    exit 1
    ;;
esac

echo "storage-init ready"
