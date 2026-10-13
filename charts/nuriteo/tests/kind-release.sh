#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
chart="$root/charts/nuriteo"
fixture="$root/deploy/compose/fixtures/upgrade-rehearsal"
cluster="${NURITEO_KIND_CLUSTER:-nuriteo-rc003}"
namespace="${NURITEO_KIND_NAMESPACE:-nuriteo-rc003}"
context="kind-$cluster"
provider="${KIND_EXPERIMENTAL_PROVIDER:-podman}"
container_runtime="${NURITEO_CONTAINER_RUNTIME:-$provider}"
node_image="${NURITEO_KIND_NODE_IMAGE:-}"
work="$(mktemp -d "${TMPDIR:-/tmp}/nuriteo-rc003.XXXXXX")"
created=false
images=(
  localhost/nuriteo-helm-source-server:rc003
  localhost/nuriteo-helm-source-web:rc003
  localhost/nuriteo-helm-failed-server:rc003
  localhost/nuriteo-helm-target-server:rc003
  localhost/nuriteo-helm-target-web:rc003
)

cleanup() {
  kubectl --context "$context" delete namespace "$namespace" --wait=false >/dev/null 2>&1 || true
  if [ "$created" = true ] && [ "${NURITEO_KEEP_KIND_CLUSTER:-false}" != true ]; then
    KIND_EXPERIMENTAL_PROVIDER="$provider" kind delete cluster --name "$cluster" >/dev/null 2>&1 || true
  fi
  "$container_runtime" image rm --force "${images[@]}" >/dev/null 2>&1 || true
  rm -rf -- "$work"
}
trap cleanup EXIT HUP INT TERM

for command in "$container_runtime" helm kind kubectl awk; do
  command -v "$command" >/dev/null
done

if ! KIND_EXPERIMENTAL_PROVIDER="$provider" kind get clusters | grep -Fx "$cluster" >/dev/null 2>&1; then
  create_args=(create cluster --name "$cluster" --wait 120s)
  if [ -n "$node_image" ]; then
    create_args+=(--image "$node_image")
  fi
  KIND_EXPERIMENTAL_PROVIDER="$provider" kind "${create_args[@]}"
  created=true
fi

build_load() {
  local name="$1" release="$2" role="$3" fail="${4:-false}" image archive digest
  image="localhost/${name}:rc003"
  archive="$work/${name}.tar"
  "$container_runtime" build --quiet --no-cache --file "$fixture/Containerfile" \
    --build-arg "FIXTURE_RELEASE=$release" --build-arg "FIXTURE_ROLE=$role" \
    --build-arg "FIXTURE_PREFLIGHT_FAIL=$fail" \
    --label "io.nuriteo.fixture.release=$release" --label "io.nuriteo.fixture.role=$role" \
    --tag "$image" "$fixture" >/dev/null
  if [ "$container_runtime" = podman ]; then
    "$container_runtime" save --format oci-archive --output "$archive" "$image"
  else
    "$container_runtime" save --output "$archive" "$image"
  fi
  KIND_EXPERIMENTAL_PROVIDER="$provider" \
    kind load image-archive --name "$cluster" "$archive" >/dev/null
  digest="$("$container_runtime" exec "${cluster}-control-plane" ctr -n k8s.io images ls \
    | awk -v image="$image" '$1 == image { print $3 }')"
  test -n "$digest"
  "$container_runtime" exec "${cluster}-control-plane" ctr -n k8s.io images tag \
    "$image" "${image%:*}@$digest" >/dev/null
  printf '%s\n' "$digest"
}

source_server_digest="$(build_load nuriteo-helm-source-server source server)"
source_web_digest="$(build_load nuriteo-helm-source-web source web)"
failed_server_digest="$(build_load nuriteo-helm-failed-server target server true)"
target_server_digest="$(build_load nuriteo-helm-target-server target server)"
target_web_digest="$(build_load nuriteo-helm-target-web target web)"

kubectl --context "$context" create namespace "$namespace"
kubectl --context "$context" create secret generic nuriteo-postgresql -n "$namespace" \
  --from-literal=database-url='postgres://fixture.invalid/nuriteo' --from-literal=ca.crt='fixture-ca'
kubectl --context "$context" create secret generic nuriteo-object-storage -n "$namespace" \
  --from-literal=access-key-id='fixture-access' --from-literal=secret-access-key='fixture-secret' \
  --from-literal=ca.crt='fixture-ca'
kubectl --context "$context" create secret generic nuriteo-application -n "$namespace" \
  --from-literal=master-key='fixture-master' --from-literal=save-idempotency-key='fixture-save' \
  --from-literal=preview-signing-key='fixture-preview'

common=(
  --namespace "$namespace"
  --set-string global.imageRegistry=localhost
  --set images.server.pullPolicy=Never
  --set images.web.pullPolicy=Never
  --wait --timeout 180s
)

helm install nuriteo "$chart" "${common[@]}" \
  --set-string images.server.repository=nuriteo-helm-source-server \
  --set-string "images.server.digest=$source_server_digest" \
  --set-string images.web.repository=nuriteo-helm-source-web \
  --set-string "images.web.digest=$source_web_digest"

kubectl --context "$context" rollout status -n "$namespace" deployment/nuriteo-nuriteo-core --timeout=120s
kubectl --context "$context" rollout status -n "$namespace" deployment/nuriteo-nuriteo-web --timeout=120s
source_core_image="$(kubectl --context "$context" get -n "$namespace" deployment/nuriteo-nuriteo-core -o jsonpath='{.spec.template.spec.containers[0].image}')"
source_web_image="$(kubectl --context "$context" get -n "$namespace" deployment/nuriteo-nuriteo-web -o jsonpath='{.spec.template.spec.containers[0].image}')"

if helm upgrade nuriteo "$chart" "${common[@]}" \
  --set-string images.server.repository=nuriteo-helm-failed-server \
  --set-string "images.server.digest=$failed_server_digest" \
  --set-string images.web.repository=nuriteo-helm-target-web \
  --set-string "images.web.digest=$target_web_digest" >"$work/failed-upgrade.log" 2>&1; then
  echo "preflight failure injection unexpectedly succeeded" >&2
  exit 1
fi
kubectl --context "$context" wait -n "$namespace" --for=condition=failed job/nuriteo-nuriteo-preflight --timeout=120s
test "$(kubectl --context "$context" get -n "$namespace" deployment/nuriteo-nuriteo-core -o jsonpath='{.spec.template.spec.containers[0].image}')" = "$source_core_image"
test "$(kubectl --context "$context" get -n "$namespace" deployment/nuriteo-nuriteo-web -o jsonpath='{.spec.template.spec.containers[0].image}')" = "$source_web_image"

helm upgrade nuriteo "$chart" "${common[@]}" \
  --set-string images.server.repository=nuriteo-helm-target-server \
  --set-string "images.server.digest=$target_server_digest" \
  --set-string images.web.repository=nuriteo-helm-target-web \
  --set-string "images.web.digest=$target_web_digest"
kubectl --context "$context" rollout status -n "$namespace" deployment/nuriteo-nuriteo-core --timeout=120s
kubectl --context "$context" rollout status -n "$namespace" deployment/nuriteo-nuriteo-web --timeout=120s

helm rollback nuriteo 1 --namespace "$namespace" --wait --timeout 180s
test "$(kubectl --context "$context" get -n "$namespace" deployment/nuriteo-nuriteo-core -o jsonpath='{.spec.template.spec.containers[0].image}')" = "$source_core_image"
test "$(kubectl --context "$context" get -n "$namespace" deployment/nuriteo-nuriteo-web -o jsonpath='{.spec.template.spec.containers[0].image}')" = "$source_web_image"

helm uninstall nuriteo --namespace "$namespace" --wait
for secret in nuriteo-postgresql nuriteo-object-storage nuriteo-application; do
  kubectl --context "$context" get secret "$secret" -n "$namespace" >/dev/null
done
test -z "$(kubectl --context "$context" get deployment,service,configmap -n "$namespace" -l app.kubernetes.io/instance=nuriteo -o name)"

printf '%s\n' '{"status":"pass","cleanInstall":true,"partialFailureFenced":true,"upgrade":true,"rollback":true,"externalSecretsPreserved":true}'
