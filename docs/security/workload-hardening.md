# Container와 Kubernetes hardening profile

Self-hosted v1의 production profile은 Pod Security Standards의 Restricted 경계에 맞춰 모든 application
workload를 UID/GID 65532, non-root, read-only root filesystem, `RuntimeDefault` seccomp, privilege escalation
금지와 `ALL` capability drop으로 실행한다. ServiceAccount token은 workload 종류나 관리자 값과 관계없이
마운트하지 않는다.

Compose도 application container에 non-root, read-only, bounded tmpfs, capability drop과
`no-new-privileges`를 적용한다. Server와 Web runtime image는 shell이 없는 distroless base를 사용하고,
Operations image만 PostgreSQL backup 도구를 위해 별도로 유지한다.

Kubernetes network restriction은 dependency CIDR을 알 수 없는 상태에서 안전한 값을 추측하지 않는다.
Production에서는 `networkPolicy.enabled=true`와 PostgreSQL, S3, OIDC, SMTP, Git, Registry의 명시적 CIDR을
필수로 하며 default-deny, DNS와 필요한 TCP port만 연다. CIDR이 비어 있으면 chart render가 실패하고 public
network fallback은 없다.
