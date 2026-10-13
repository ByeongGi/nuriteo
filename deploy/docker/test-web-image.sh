#!/bin/sh
set -eu

image="${NURITEO_WEB_IMAGE:-localhost/nuriteo-web:img-002}"
container="nuriteo-img-002-$$"
port="${NURITEO_WEB_SMOKE_PORT:-19302}"
internal_url="http://nuriteo-core.internal:8080/private-runtime-only"
archive="$(mktemp -t nuriteo-img-002.XXXXXX.tar)"
listing="$(mktemp -t nuriteo-img-002.XXXXXX.txt)"
response="$(mktemp -t nuriteo-img-002.XXXXXX.html)"

cleanup() {
  podman rm --force "$container" >/dev/null 2>&1 || true
  rm -f "$archive" "$listing" "$response"
}
trap cleanup EXIT HUP INT TERM

if [ "${NURITEO_WEB_SKIP_BUILD:-0}" != 1 ]; then
  podman build \
    --file deploy/docker/web.Dockerfile \
    --ignorefile deploy/docker/web.Dockerfile.dockerignore \
    --tag "$image" \
    .
fi

user="$(podman image inspect "$image" --format '{{.Config.User}}')"
entrypoint="$(podman image inspect "$image" --format '{{json .Config.Entrypoint}}')"
test "$user" = "65532:65532"
test "$entrypoint" = '["/nodejs/bin/node","apps/web/server.js"]'

podman create --name "$container" "$image" >/dev/null
podman export --output "$archive" "$container"
podman rm "$container" >/dev/null

tar -tf "$archive" >"$listing"
grep -Eq '^app/apps/web/server\.js$' "$listing"
grep -Eq '^app/apps/web/\.next/static/.+\.css$' "$listing"
if grep -Eq '(^|/)(pnpm-lock\.yaml|\.pnpm-store|\.next/cache|Dockerfile|\.env([.]|$)|[^/]+[.](pem|key))($|/)' "$listing"; then
  echo "runtime image contains a forbidden build, cache, or secret-shaped artifact" >&2
  exit 1
fi
if grep -Eq '^app/apps/web/src/|[.](ts|tsx)$' "$listing"; then
  echo "runtime image contains Web source files" >&2
  exit 1
fi

podman run --detach \
  --name "$container" \
  --publish "127.0.0.1:${port}:3000" \
  --read-only \
  --cap-drop all \
  --security-opt no-new-privileges \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --env "NURITEO_INTERNAL_API_URL=$internal_url" \
  "$image" >/dev/null

attempt=0
until curl --fail --silent "http://127.0.0.1:${port}/" --output "$response"; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    podman inspect "$container" --format 'state={{.State.Status}} exit={{.State.ExitCode}}' >&2
    exit 1
  fi
  sleep 1
done

grep -q 'data-theme-mode="system"' "$response"
if grep -q "$internal_url" "$response"; then
  echo "runtime-only internal URL leaked into browser HTML" >&2
  exit 1
fi

css_path="$(grep -Eo '/_next/static/css/[^" ]+\.css' "$response" | sed -n '1p')"
test -n "$css_path"
test "$(curl --silent --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:${port}${css_path}")" = "200"
test "$(curl --silent --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:${port}/definitely-not-a-route")" = "404"
curl --fail --silent --show-error \
  --header 'Cookie: nuriteo-theme=dark' \
  "http://127.0.0.1:${port}/" \
  --output "$response"
grep -q 'data-theme-mode="dark"' "$response"
if grep -q "$internal_url" "$response"; then
  echo "runtime-only internal URL leaked into themed SSR HTML" >&2
  exit 1
fi

echo "web image smoke ok (non-root/read-only, root 200, CSS 200, 404, SSR theme, runtime URL private)"
