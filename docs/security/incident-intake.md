# Security incident intake

Self-hosted v1 보안 신고와 내부 탐지는 아래 최소 정보로 접수한다. 토큰, 비밀번호, 원문 백업,
프로젝트 소스와 개인정보는 첨부하지 않는다.

## 필수 입력

- 발견 시각과 영향받은 Nuriteo 버전·이미지 digest
- 재현 단계와 예상/실제 결과
- 영향 범위: 인증, 권한, 데이터 기밀성·무결성·가용성, 공급망
- redacted request ID, audit event ID, component와 오류 코드
- 공개 여부와 이미 알려진 공격 또는 악용 징후

## 초기 분류

Maintainer는 신고를 `critical`, `high`, `medium`, `low` 중 하나로 분류하고 incident owner를 지정한다.
Critical/High 가능성이 있으면 공개 issue에 세부 내용을 옮기지 않고, 영향 digest와 완화책을 먼저
확정한다. 자격 증명 노출이 의심되면 즉시 회전하고 audit export와 관련 backup reference를 보존한다.

## Release 차단 입력

미해결 Critical/High 취약점, 포함된 비밀값, provenance 불일치, 우회 가능한 workload hardening,
만료되었거나 범위가 없는 waiver는 release blocker다. 수정 후 동일 digest가 아니라 새 digest를 만들고
dependency 검사, OCI image scan, workload 계약과 incident 입력 완전성을 다시 검증한다.

상세 공개·응답 시간·지원 창구 정책은 [취약점·Incident·지원 대응](./vulnerability-and-incident-response.md)을
따른다.
