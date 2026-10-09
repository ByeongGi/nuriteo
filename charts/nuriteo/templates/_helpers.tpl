{{/* Common chart names and the immutable application image contract. */}}
{{- define "nuriteo.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "nuriteo.fullname" -}}
{{- printf "%s-%s" .Release.Name (include "nuriteo.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "nuriteo.labels" -}}
app.kubernetes.io/name: {{ include "nuriteo.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "nuriteo.image" -}}
{{- $root := index . 0 -}}
{{- $image := index . 1 -}}
{{- if contains "@" $image.repository -}}
{{- fail "image repository must not contain a digest; set images.<component>.digest" -}}
{{- end -}}
{{- if regexMatch ":[^/]+$" $image.repository -}}
{{- fail "image repository must not contain a tag; NURITEO images are digest-only" -}}
{{- end -}}
{{- printf "%s/%s@%s" (trimSuffix "/" $root.Values.global.imageRegistry) (trimPrefix "/" $image.repository) $image.digest -}}
{{- end -}}

{{/* Non-secret runtime configuration shared by all workload templates. */}}
{{- define "nuriteo.runtimeConfigData" -}}
NURITEO_EXTERNAL_URL: {{ .Values.externalUrl | quote }}
NURITEO_PREVIEW_BASE_DOMAIN: {{ .Values.preview.baseDomain | quote }}
NURITEO_PREVIEW_WILDCARD_READY: {{ .Values.preview.wildcardReady | quote }}
NURITEO_S3_ENDPOINT: {{ .Values.objectStorage.endpoint | quote }}
NURITEO_S3_REGION: {{ .Values.objectStorage.region | quote }}
NURITEO_S3_BUCKET: {{ .Values.objectStorage.bucket | quote }}
NURITEO_S3_ADDRESSING_STYLE: {{ .Values.objectStorage.addressingStyle | quote }}
NURITEO_S3_CREDENTIAL_PROVIDER: {{ .Values.objectStorage.credentialProvider | quote }}
{{- end -}}

{{- define "nuriteo.runtimeConfigName" -}}
{{- if .Values.runtimeConfig.create -}}
{{- printf "%s-runtime" (include "nuriteo.fullname" .) -}}
{{- else -}}
{{- .Values.runtimeConfig.existingConfigMap.name -}}
{{- end -}}
{{- end -}}

{{/*
The chart cannot read the contents of operator-owned Secrets or ConfigMaps. The
opaque revisions below are rollout generations, never hashes of secret material.
*/}}
{{- define "nuriteo.runtimeConfigChecksum" -}}
{{- if .Values.runtimeConfig.create -}}
{{- include "nuriteo.runtimeConfigData" . | sha256sum -}}
{{- else -}}
{{- printf "%s:%s" .Values.runtimeConfig.existingConfigMap.name .Values.runtimeConfig.existingConfigMap.revision | sha256sum -}}
{{- end -}}
{{- end -}}

{{- define "nuriteo.secretRefsChecksum" -}}
{{- dict "postgresql" .Values.postgresql.existingSecret "objectStorage" .Values.objectStorage.existingSecret "application" .Values.applicationSecrets.existingSecret "bootstrap" .Values.bootstrapAdmin.existingSecret "revision" .Values.rollout.externalSecretsRevision | toJson | sha256sum -}}
{{- end -}}

{{- define "nuriteo.rolloutAnnotations" -}}
checksum/nuriteo-runtime-config: {{ include "nuriteo.runtimeConfigChecksum" . | quote }}
checksum/nuriteo-secret-refs: {{ include "nuriteo.secretRefsChecksum" . | quote }}
{{- end -}}

{{/* Reusable PodSpec fragments consumed by the K8S-003 Jobs and Deployments. */}}
{{- define "nuriteo.runtimeConfigRef" -}}
- configMapRef:
    name: {{ include "nuriteo.runtimeConfigName" . }}
{{- end -}}

{{- define "nuriteo.coreSecretVolumes" -}}
- name: database-secrets
  secret:
    secretName: {{ .Values.postgresql.existingSecret.name }}
    defaultMode: 0400
    items:
      - key: {{ .Values.postgresql.existingSecret.databaseUrlKey }}
        path: database-url
      {{- if .Values.postgresql.existingSecret.caKey }}
      - key: {{ .Values.postgresql.existingSecret.caKey }}
        path: ca.crt
      {{- end }}
- name: object-storage-secrets
  secret:
    secretName: {{ .Values.objectStorage.existingSecret.name }}
    defaultMode: 0400
    {{- if or .Values.objectStorage.existingSecret.accessKeyIdKey .Values.objectStorage.existingSecret.secretAccessKeyKey .Values.objectStorage.existingSecret.sessionTokenKey .Values.objectStorage.existingSecret.caKey }}
    items:
      {{- if .Values.objectStorage.existingSecret.accessKeyIdKey }}
      - key: {{ .Values.objectStorage.existingSecret.accessKeyIdKey }}
        path: access-key-id
      {{- end }}
      {{- if .Values.objectStorage.existingSecret.secretAccessKeyKey }}
      - key: {{ .Values.objectStorage.existingSecret.secretAccessKeyKey }}
        path: secret-access-key
      {{- end }}
      {{- if .Values.objectStorage.existingSecret.sessionTokenKey }}
      - key: {{ .Values.objectStorage.existingSecret.sessionTokenKey }}
        path: session-token
      {{- end }}
      {{- if .Values.objectStorage.existingSecret.caKey }}
      - key: {{ .Values.objectStorage.existingSecret.caKey }}
        path: ca.crt
      {{- end }}
    {{- end }}
- name: application-secrets
  secret:
    secretName: {{ .Values.applicationSecrets.existingSecret.name }}
    defaultMode: 0400
    items:
      - key: {{ .Values.applicationSecrets.existingSecret.masterKeyKey }}
        path: master-key
      - key: {{ .Values.applicationSecrets.existingSecret.saveIdempotencyKey }}
        path: save-idempotency-key
      - key: {{ .Values.applicationSecrets.existingSecret.previewSigningKey }}
        path: preview-signing-key
{{- end -}}

{{- define "nuriteo.webSecretVolumes" -}}
- name: application-secrets
  secret:
    secretName: {{ .Values.applicationSecrets.existingSecret.name }}
    defaultMode: 0400
    items:
      - key: {{ .Values.applicationSecrets.existingSecret.previewSigningKey }}
        path: preview-signing-key
{{- end -}}
