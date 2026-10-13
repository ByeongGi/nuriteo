# Self-hosted v1 위협 모델

기준일: 2026-10-11  
상태: GA hardening 승인

## 범위와 자산

보호 자산은 사용자 계정과 Session, Project source와 version, Organization 권한, Integration credential,
PostgreSQL metadata, S3 object, backup encryption material, Audit Event 및 release artifact다. Browser Runtime과
Preview에서 실행되는 Project code는 신뢰하지 않으며, 외부 OIDC·Git·Registry·SMTP·S3 endpoint와 image
registry도 신뢰 경계 밖에 둔다.

## 주요 신뢰 경계

1. Browser와 Web BFF/Rust API
2. Application origin과 wildcard Preview origin
3. Project code와 Browser Runtime host capability
4. Rust Server와 등록된 외부 Integration
5. Server와 PostgreSQL/S3-compatible storage
6. 일반 사용자와 재인증된 Instance Administrator operation
7. Source repository와 설치되는 release artifact

세부 threat, 심각도, 통제와 실제 코드 증거는
[`security/self-hosted-v1-threat-model.json`](../../security/self-hosted-v1-threat-model.json)에 기록한다.

## Release 판정

현재 설계 검토에서 미해결 Critical/High threat는 0개다. 공급망, telemetry 비노출, container/Kubernetes
hardening은 설계만으로 닫지 않고 각각 `SEC-002`, `OBS-002/003`, `SEC-003/004`의 실행 결과를 요구한다.
이 release-gated threat 중 하나라도 실패하면 `GATE-007`을 중단한다.

## 명시적 비보장

- Browser Direct는 기업 egress firewall이 아니다.
- Runtime에 Project/Organization secret을 주입하지 않는다.
- 범용 HTTP proxy, TLS 검증 해제와 Registry/Provider fallback을 제공하지 않는다.
- Managed Cloud, billing, multi-region active-active와 운영 대행 SLA는 v1 범위가 아니다.
