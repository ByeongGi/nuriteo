#!/bin/sh
set -eu

cluster_name=${NURITEO_KIND_CLUSTER:-nuriteo-air003}
namespace=${NURITEO_KIND_NAMESPACE:-nuriteo-airgap}
context="kind-${cluster_name}"
fixture_image=${NURITEO_EGRESS_FIXTURE_IMAGE:-docker.io/library/busybox:1.37.0}
created_cluster=false
policy_file=$(mktemp "${TMPDIR:-/tmp}/nuriteo-airgap-policy.XXXXXX")
image_archive=$(mktemp "${TMPDIR:-/tmp}/nuriteo-airgap-image.XXXXXX.tar")
chart_dir=$(CDPATH= cd -- "$(dirname "$0")/../../../charts/nuriteo" && pwd)

cleanup() {
  kubectl --context "$context" delete namespace "$namespace" --wait=false >/dev/null 2>&1 || true
  rm -f "$policy_file" "$image_archive"
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
podman save --format docker-archive --output "$image_archive" "$fixture_image"
KIND_EXPERIMENTAL_PROVIDER=${KIND_EXPERIMENTAL_PROVIDER:-podman} \
  kind load image-archive --name "$cluster_name" "$image_archive"

kubectl --context "$context" create namespace "$namespace"
kubectl --context "$context" label namespace "$namespace" \
  pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/enforce-version=latest

for name in allowed-dependency denied-dependency; do
  cat <<YAML | kubectl --context "$context" apply -n "$namespace" -f -
apiVersion: v1
kind: Pod
metadata:
  name: ${name}
  labels: { fixture: "${name}" }
spec:
  automountServiceAccountToken: false
  securityContext:
    runAsNonRoot: true
    runAsUser: 65532
    runAsGroup: 65532
    seccompProfile: { type: RuntimeDefault }
  containers:
    - name: http
      image: ${fixture_image}
      imagePullPolicy: IfNotPresent
      command: ["sh", "-c", "printf '%s\\n' ${name} >/tmp/index.html; exec httpd -f -p 8443 -h /tmp"]
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities: { drop: [ALL] }
      volumeMounts: [{ name: temporary, mountPath: /tmp }]
  volumes: [{ name: temporary, emptyDir: {} }]
YAML
done

cat <<YAML | kubectl --context "$context" apply -n "$namespace" -f -
apiVersion: v1
kind: Pod
metadata:
  name: core-egress-probe
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
    - name: probe
      image: ${fixture_image}
      imagePullPolicy: IfNotPresent
      command: ["sh", "-c", "sleep 3600"]
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities: { drop: [ALL] }
YAML

kubectl --context "$context" wait -n "$namespace" --for=condition=Ready \
  pod/allowed-dependency pod/denied-dependency pod/core-egress-probe --timeout=120s
allowed_ip=$(kubectl --context "$context" get -n "$namespace" pod/allowed-dependency -o jsonpath='{.status.podIP}')
denied_ip=$(kubectl --context "$context" get -n "$namespace" pod/denied-dependency -o jsonpath='{.status.podIP}')

helm template nuriteo "$chart_dir" --namespace "$namespace" \
  --show-only templates/networkpolicy.yaml \
  --set networkPolicy.enabled=true \
  --set-string "networkPolicy.externalEgress.cidrBlocks[0]=${allowed_ip}/32" \
  --set-json 'networkPolicy.externalEgress.tcpPorts=[8443]' >"$policy_file"
kubectl --context "$context" apply -n "$namespace" -f "$policy_file"

kubectl --context "$context" exec -n "$namespace" core-egress-probe -- \
  wget -T 3 -qO- "http://${allowed_ip}:8443/" | grep -Fx allowed-dependency >/dev/null
if kubectl --context "$context" exec -n "$namespace" core-egress-probe -- \
  wget -T 3 -qO- "http://${denied_ip}:8443/" >/dev/null 2>&1; then
  echo 'undeclared in-cluster egress was allowed' >&2
  exit 1
fi
if kubectl --context "$context" exec -n "$namespace" core-egress-probe -- \
  wget -T 3 -qO- 'http://1.1.1.1:80/' >/dev/null 2>&1; then
  echo 'undeclared public egress was allowed' >&2
  exit 1
fi

echo 'air-gap egress contract ok (declared dependency allowed, undeclared cluster and public egress denied)'
