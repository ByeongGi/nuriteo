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

