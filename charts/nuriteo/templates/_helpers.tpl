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

{{- define "nuriteo.selectorLabels" -}}
app.kubernetes.io/name: {{ include "nuriteo.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "nuriteo.serviceAccountName" -}}
{{- default "default" .Values.serviceAccount.name -}}
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

{{- define "nuriteo.validateOperationsImage" -}}
{{- if eq .Values.images.operations.digest "sha256:0000000000000000000000000000000000000000000000000000000000000000" -}}
{{- fail "backup and restore operations require a release-published images.operations.digest" -}}
{{- end -}}
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
{{- dict "postgresql" .Values.postgresql.existingSecret "objectStorage" .Values.objectStorage.existingSecret "application" .Values.applicationSecrets.existingSecret "observability" .Values.observability.otlp.existingSecret "bootstrap" .Values.bootstrapAdmin.existingSecret "revision" .Values.rollout.externalSecretsRevision | toJson | sha256sum -}}
{{- end -}}

{{- define "nuriteo.operationSecretRefsChecksum" -}}
{{- dict "backupStorage" .Values.backupStorage.existingSecret "restore" .Values.restore.target "revision" .Values.rollout.externalSecretsRevision | toJson | sha256sum -}}
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
{{- if and .Values.observability.otlp.existingSecret.name .Values.observability.otlp.existingSecret.caKey }}
- name: observability-secrets
  secret:
    secretName: {{ .Values.observability.otlp.existingSecret.name }}
    defaultMode: 0400
    items:
      - key: {{ .Values.observability.otlp.existingSecret.caKey }}
        path: ca.crt
{{- end }}
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

{{- define "nuriteo.coreSecretVolumeMounts" -}}
- name: database-secrets
  mountPath: /run/secrets/nuriteo/database
  readOnly: true
- name: object-storage-secrets
  mountPath: /run/secrets/nuriteo/object-storage
  readOnly: true
- name: application-secrets
  mountPath: /run/secrets/nuriteo/application
  readOnly: true
{{- if and .Values.observability.otlp.existingSecret.name .Values.observability.otlp.existingSecret.caKey }}
- name: observability-secrets
  mountPath: /run/secrets/nuriteo/observability
  readOnly: true
{{- end }}
{{- end -}}

{{- define "nuriteo.webSecretVolumeMounts" -}}
- name: application-secrets
  mountPath: /run/secrets/nuriteo/application
  readOnly: true
{{- end -}}

{{- define "nuriteo.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: 65532
runAsGroup: 65532
fsGroup: 65532
fsGroupChangePolicy: OnRootMismatch
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{- define "nuriteo.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop:
    - ALL
{{- end -}}

{{- define "nuriteo.imagePullSecrets" -}}
{{- range .Values.global.imagePullSecrets }}
- name: {{ . }}
{{- end }}
{{- end -}}

{{- define "nuriteo.dnsEgress" -}}
- to:
    - namespaceSelector:
        matchLabels:
          {{- toYaml .Values.networkPolicy.dns.namespaceLabels | nindent 10 }}
      podSelector:
        matchLabels:
          {{- toYaml .Values.networkPolicy.dns.podLabels | nindent 10 }}
  ports:
    - { protocol: UDP, port: 53 }
    - { protocol: TCP, port: 53 }
{{- end -}}

{{/*
Return the canonical application hostname and reject origin overlap with the
Preview wildcard. A Preview label is intentionally only one DNS label deep.
*/}}
{{- define "nuriteo.applicationHost" -}}
{{- $authority := trimSuffix "/" (trimPrefix "https://" .Values.externalUrl) -}}
{{- $authorityParts := splitList ":" $authority -}}
{{- $host := first $authorityParts -}}
{{- if eq (len $authorityParts) 2 -}}
{{- $port := atoi (last $authorityParts) -}}
{{- if or (lt $port 1) (gt $port 65535) -}}
{{- fail "externalUrl port must be between 1 and 65535" -}}
{{- end -}}
{{- end -}}
{{- $previewSuffix := printf ".%s" .Values.preview.baseDomain -}}
{{- if or (eq $host .Values.preview.baseDomain) (hasSuffix $previewSuffix $host) -}}
{{- fail "externalUrl host must not equal or be covered by preview.baseDomain" -}}
{{- end -}}
{{- $host -}}
{{- end -}}

{{- define "nuriteo.validateIngress" -}}
{{- $applicationHost := include "nuriteo.applicationHost" . -}}
{{- if and .Values.preview.wildcardReady (not (and .Values.ingress.readiness.wildcardDns .Values.ingress.readiness.wildcardTls .Values.ingress.readiness.originalHost .Values.ingress.readiness.webSocket .Values.ingress.readiness.crossOrigin .Values.ingress.readiness.hmr)) -}}
{{- fail "preview.wildcardReady=true requires DNS, TLS, original Host, WebSocket, cross-origin, and HMR readiness acknowledgements" -}}
{{- end -}}
{{- if eq $applicationHost (printf "*.%s" .Values.preview.baseDomain) -}}
{{- fail "application and Preview ingress hosts must be distinct" -}}
{{- end -}}
{{- end -}}

{{/* Shared backup CLI environment. Credentials remain projected files. */}}
{{- define "nuriteo.backupEnv" -}}
- name: NURITEO_EXTERNAL_URL
  valueFrom: { configMapKeyRef: { name: {{ include "nuriteo.runtimeConfigName" . }}, key: NURITEO_EXTERNAL_URL } }
- name: NURITEO_S3_ENDPOINT
  valueFrom: { configMapKeyRef: { name: {{ include "nuriteo.runtimeConfigName" . }}, key: NURITEO_S3_ENDPOINT } }
- name: NURITEO_S3_REGION
  valueFrom: { configMapKeyRef: { name: {{ include "nuriteo.runtimeConfigName" . }}, key: NURITEO_S3_REGION } }
- name: NURITEO_S3_BUCKET
  valueFrom: { configMapKeyRef: { name: {{ include "nuriteo.runtimeConfigName" . }}, key: NURITEO_S3_BUCKET } }
- name: NURITEO_S3_ADDRESSING_STYLE
  valueFrom: { configMapKeyRef: { name: {{ include "nuriteo.runtimeConfigName" . }}, key: NURITEO_S3_ADDRESSING_STYLE } }
- name: NURITEO_S3_CREDENTIAL_PROVIDER
  valueFrom: { configMapKeyRef: { name: {{ include "nuriteo.runtimeConfigName" . }}, key: NURITEO_S3_CREDENTIAL_PROVIDER } }
- name: NURITEO_DATABASE_URL_FILE
  value: /run/secrets/nuriteo/database/database-url
{{- if .Values.postgresql.existingSecret.caKey }}
- name: NURITEO_DATABASE_CA_FILE
  value: /run/secrets/nuriteo/database/ca.crt
{{- end }}
{{- if .Values.objectStorage.existingSecret.accessKeyIdKey }}
- name: NURITEO_S3_ACCESS_KEY_ID_FILE
  value: /run/secrets/nuriteo/object-storage/access-key-id
{{- end }}
{{- if .Values.objectStorage.existingSecret.secretAccessKeyKey }}
- name: NURITEO_S3_SECRET_ACCESS_KEY_FILE
  value: /run/secrets/nuriteo/object-storage/secret-access-key
{{- end }}
{{- if .Values.objectStorage.existingSecret.sessionTokenKey }}
- name: NURITEO_S3_SESSION_TOKEN_FILE
  value: /run/secrets/nuriteo/object-storage/session-token
{{- end }}
{{- if .Values.objectStorage.existingSecret.caKey }}
- name: NURITEO_S3_CA_FILE
  value: /run/secrets/nuriteo/object-storage/ca.crt
{{- end }}
- name: NURITEO_BACKUP_S3_ENDPOINT
  value: {{ .Values.backupStorage.endpoint | quote }}
- name: NURITEO_BACKUP_S3_REGION
  value: {{ .Values.backupStorage.region | quote }}
- name: NURITEO_BACKUP_S3_BUCKET
  value: {{ .Values.backupStorage.bucket | quote }}
- name: NURITEO_BACKUP_S3_PREFIX
  value: {{ .Values.backupStorage.prefix | quote }}
- name: NURITEO_BACKUP_S3_ADDRESSING_STYLE
  value: {{ .Values.backupStorage.addressingStyle | quote }}
- name: NURITEO_BACKUP_S3_SSE
  value: {{ .Values.backupStorage.sse | quote }}
{{- if eq .Values.backupStorage.sse "kms" }}
- name: NURITEO_BACKUP_S3_KMS_KEY_ID
  value: {{ .Values.backupStorage.kmsKeyId | quote }}
{{- end }}
- name: NURITEO_BACKUP_S3_ACCESS_KEY_ID_FILE
  value: /run/secrets/nuriteo/backup-storage/access-key-id
- name: NURITEO_BACKUP_S3_SECRET_ACCESS_KEY_FILE
  value: /run/secrets/nuriteo/backup-storage/secret-access-key
{{- if .Values.backupStorage.existingSecret.sessionTokenKey }}
- name: NURITEO_BACKUP_S3_SESSION_TOKEN_FILE
  value: /run/secrets/nuriteo/backup-storage/session-token
{{- end }}
{{- if .Values.backupStorage.existingSecret.caKey }}
- name: NURITEO_BACKUP_S3_CA_FILE
  value: /run/secrets/nuriteo/backup-storage/ca.crt
{{- end }}
- name: NURITEO_BACKUP_SCRATCH_DIR
  value: /tmp/nuriteo-backup
{{- end -}}

{{- define "nuriteo.backupSecretVolume" -}}
- name: backup-storage-secrets
  secret:
    secretName: {{ .Values.backupStorage.existingSecret.name }}
    defaultMode: 0400
    items:
      - key: {{ .Values.backupStorage.existingSecret.accessKeyIdKey }}
        path: access-key-id
      - key: {{ .Values.backupStorage.existingSecret.secretAccessKeyKey }}
        path: secret-access-key
      {{- if .Values.backupStorage.existingSecret.sessionTokenKey }}
      - key: {{ .Values.backupStorage.existingSecret.sessionTokenKey }}
        path: session-token
      {{- end }}
      {{- if .Values.backupStorage.existingSecret.caKey }}
      - key: {{ .Values.backupStorage.existingSecret.caKey }}
        path: ca.crt
      {{- end }}
{{- end -}}

{{/* Backup operations need the source database and primary object store, never application keys. */}}
{{- define "nuriteo.backupSourceSecretVolumes" -}}
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
{{- end -}}

{{- define "nuriteo.backupSourceSecretVolumeMounts" -}}
- name: database-secrets
  mountPath: /run/secrets/nuriteo/database
  readOnly: true
- name: object-storage-secrets
  mountPath: /run/secrets/nuriteo/object-storage
  readOnly: true
{{- end -}}

{{- define "nuriteo.backupSecretVolumeMount" -}}
- name: backup-storage-secrets
  mountPath: /run/secrets/nuriteo/backup-storage
  readOnly: true
{{- end -}}

{{- define "nuriteo.restoreEnv" -}}
- name: NURITEO_RESTORE_DATABASE_URL_FILE
  value: /run/secrets/nuriteo/restore-database/database-url
{{- if .Values.restore.target.postgresql.existingSecret.caKey }}
- name: NURITEO_RESTORE_DATABASE_CA_FILE
  value: /run/secrets/nuriteo/restore-database/ca.crt
{{- end }}
- name: NURITEO_RESTORE_S3_ENDPOINT
  value: {{ .Values.restore.target.objectStorage.endpoint | quote }}
- name: NURITEO_RESTORE_S3_REGION
  value: {{ .Values.restore.target.objectStorage.region | quote }}
- name: NURITEO_RESTORE_S3_BUCKET
  value: {{ .Values.restore.target.objectStorage.bucket | quote }}
- name: NURITEO_RESTORE_S3_ADDRESSING_STYLE
  value: {{ .Values.restore.target.objectStorage.addressingStyle | quote }}
- name: NURITEO_RESTORE_S3_CREDENTIAL_PROVIDER
  value: {{ .Values.restore.target.objectStorage.credentialProvider | quote }}
{{- if .Values.restore.target.objectStorage.existingSecret.accessKeyIdKey }}
- name: NURITEO_RESTORE_S3_ACCESS_KEY_ID_FILE
  value: /run/secrets/nuriteo/restore-storage/access-key-id
{{- end }}
{{- if .Values.restore.target.objectStorage.existingSecret.secretAccessKeyKey }}
- name: NURITEO_RESTORE_S3_SECRET_ACCESS_KEY_FILE
  value: /run/secrets/nuriteo/restore-storage/secret-access-key
{{- end }}
{{- if .Values.restore.target.objectStorage.existingSecret.sessionTokenKey }}
- name: NURITEO_RESTORE_S3_SESSION_TOKEN_FILE
  value: /run/secrets/nuriteo/restore-storage/session-token
{{- end }}
{{- if .Values.restore.target.objectStorage.existingSecret.caKey }}
- name: NURITEO_RESTORE_S3_CA_FILE
  value: /run/secrets/nuriteo/restore-storage/ca.crt
{{- end }}
{{- end -}}

{{- define "nuriteo.restoreSecretVolumes" -}}
- name: restore-database-secrets
  secret:
    secretName: {{ .Values.restore.target.postgresql.existingSecret.name }}
    defaultMode: 0400
    items:
      - key: {{ .Values.restore.target.postgresql.existingSecret.databaseUrlKey }}
        path: database-url
      {{- if .Values.restore.target.postgresql.existingSecret.caKey }}
      - key: {{ .Values.restore.target.postgresql.existingSecret.caKey }}
        path: ca.crt
      {{- end }}
- name: restore-storage-secrets
  secret:
    secretName: {{ .Values.restore.target.objectStorage.existingSecret.name }}
    defaultMode: 0400
    {{- if or .Values.restore.target.objectStorage.existingSecret.accessKeyIdKey .Values.restore.target.objectStorage.existingSecret.secretAccessKeyKey .Values.restore.target.objectStorage.existingSecret.sessionTokenKey .Values.restore.target.objectStorage.existingSecret.caKey }}
    items:
      {{- if .Values.restore.target.objectStorage.existingSecret.accessKeyIdKey }}
      - key: {{ .Values.restore.target.objectStorage.existingSecret.accessKeyIdKey }}
        path: access-key-id
      {{- end }}
      {{- if .Values.restore.target.objectStorage.existingSecret.secretAccessKeyKey }}
      - key: {{ .Values.restore.target.objectStorage.existingSecret.secretAccessKeyKey }}
        path: secret-access-key
      {{- end }}
      {{- if .Values.restore.target.objectStorage.existingSecret.sessionTokenKey }}
      - key: {{ .Values.restore.target.objectStorage.existingSecret.sessionTokenKey }}
        path: session-token
      {{- end }}
      {{- if .Values.restore.target.objectStorage.existingSecret.caKey }}
      - key: {{ .Values.restore.target.objectStorage.existingSecret.caKey }}
        path: ca.crt
      {{- end }}
    {{- end }}
{{- end -}}

{{- define "nuriteo.restoreSecretVolumeMounts" -}}
- name: restore-database-secrets
  mountPath: /run/secrets/nuriteo/restore-database
  readOnly: true
- name: restore-storage-secrets
  mountPath: /run/secrets/nuriteo/restore-storage
  readOnly: true
{{- end -}}

{{- define "nuriteo.toolboxArgs" -}}
{{- if eq .Values.toolbox.operation "verify" -}}
["backup", "verify", {{ .Values.toolbox.backupId | quote }}]
{{- else -}}
["backup", {{ .Values.toolbox.operation | quote }}]
{{- end -}}
{{- end -}}

{{/* Restore must target infrastructure distinct from the production data plane. */}}
{{- define "nuriteo.validateRestore" -}}
{{- if .Values.restore.enabled -}}
{{- if eq .Values.restore.target.postgresql.existingSecret.name .Values.postgresql.existingSecret.name -}}
{{- fail "restore target PostgreSQL Secret must differ from the production PostgreSQL Secret" -}}
{{- end -}}
{{- if and (eq .Values.restore.target.objectStorage.endpoint .Values.objectStorage.endpoint) (eq .Values.restore.target.objectStorage.bucket .Values.objectStorage.bucket) -}}
{{- fail "restore target Object Storage endpoint and bucket must differ from production" -}}
{{- end -}}
{{- end -}}
{{- end -}}
