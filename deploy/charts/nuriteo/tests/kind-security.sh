#!/bin/sh
set -eu

cluster_name=${NURITEO_KIND_CLUSTER:-nuriteo-k8s006}
namespace=${NURITEO_KIND_NAMESPACE:-nuriteo-security}
context="kind-${cluster_name}"
created_cluster=false
fixture_file=$(mktemp "${TMPDIR:-/tmp}/nuriteo-kind-security.XXXXXX")
error_file=$(mktemp "${TMPDIR:-/tmp}/nuriteo-kind-security-error.XXXXXX")
chart_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

cleanup() {
  kubectl --context "$context" delete namespace "$namespace" --wait=false >/dev/null 2>&1 || true
  rm -f "$fixture_file" "$error_file"
  if [ "$created_cluster" = true ] && [ "${NURITEO_KEEP_KIND_CLUSTER:-false}" != true ]; then
    KIND_EXPERIMENTAL_PROVIDER=${KIND_EXPERIMENTAL_PROVIDER:-podman} \
      kind delete cluster --name "$cluster_name" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT HUP INT TERM

if ! kind get clusters | grep -Fx "$cluster_name" >/dev/null 2>&1; then
  KIND_EXPERIMENTAL_PROVIDER=${KIND_EXPERIMENTAL_PROVIDER:-podman} \
    kind create cluster --name "$cluster_name" --wait 120s
  created_cluster=true
fi

kubectl --context "$context" create namespace "$namespace"
kubectl --context "$context" label namespace "$namespace" \
  pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/enforce-version=latest

helm template nuriteo "$chart_dir" --namespace "$namespace" \
  --show-only templates/networkpolicy.yaml \
  --show-only templates/poddisruptionbudget.yaml \
  --set networkPolicy.enabled=true \
  --set-string 'networkPolicy.externalEgress.cidrBlocks[0]=10.42.0.0/16' >"$fixture_file"
kubectl --context "$context" apply -n "$namespace" -f "$fixture_file"

cat <<'YAML' | kubectl --context "$context" apply -n "$namespace" -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nuriteo-nuriteo-core
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: nuriteo
      app.kubernetes.io/instance: nuriteo
      app.kubernetes.io/component: core
  template:
    metadata:
      labels:
        app.kubernetes.io/name: nuriteo
        app.kubernetes.io/instance: nuriteo
        app.kubernetes.io/component: core
    spec:
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        runAsUser: 65532
        runAsGroup: 65532
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: fixture
          image: registry.k8s.io/pause:3.10.1
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: [ALL] }
YAML
kubectl --context "$context" wait -n "$namespace" \
  --for=condition=available deployment/nuriteo-nuriteo-core --timeout=120s

test "$(kubectl --context "$context" get -n "$namespace" networkpolicy --no-headers | wc -l | tr -d ' ')" -eq 4
test "$(kubectl --context "$context" get -n "$namespace" poddisruptionbudget --no-headers | wc -l | tr -d ' ')" -eq 2
test "$(kubectl --context "$context" get -n "$namespace" poddisruptionbudget nuriteo-nuriteo-core -o jsonpath='{.status.disruptionsAllowed}')" -eq 0

if cat <<'YAML' | kubectl --context "$context" create -n "$namespace" -f - >"$error_file" 2>&1; then
apiVersion: v1
kind: Pod
metadata: { name: forbidden-privileged }
spec:
  containers:
    - name: fixture
      image: registry.k8s.io/pause:3.10.1
      securityContext: { privileged: true }
YAML
  echo 'restricted Pod Security Admission accepted a privileged Pod' >&2
  exit 1
fi
grep -E 'violates PodSecurity|restricted' "$error_file" >/dev/null

pod=$(kubectl --context "$context" get -n "$namespace" pod \
  -l app.kubernetes.io/component=core -o jsonpath='{.items[0].metadata.name}')
if printf '%s' '{"apiVersion":"policy/v1","kind":"Eviction","metadata":{"name":"'"$pod"'","namespace":"'"$namespace"'"}}' \
  | kubectl --context "$context" create --raw "/api/v1/namespaces/${namespace}/pods/${pod}/eviction" -f - \
    >"$error_file" 2>&1; then
  echo 'PodDisruptionBudget allowed the only Core replica to be evicted' >&2
  exit 1
fi
grep -E 'Too Many Requests|disruption budget|Cannot evict pod' "$error_file" >/dev/null

echo 'kind security contract ok (restricted PSA, four NetworkPolicies, PDB eviction denied)'
