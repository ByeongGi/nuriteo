# Support Bundle

NURITEO의 Support Bundle은 Instance 관리자가 장애 정보를 직접 검토하고 내려받는 최대 64 KiB JSON
파일이다. 자동 업로드하지 않으며 서버에 파일로 보존하지 않는다. 관리자 화면의 **Operations → Support
bundle**에서 포함·제외 범위를 먼저 확인한 뒤 생성한다.

## 포함 항목

- NURITEO release version, 운영체제와 architecture
- PostgreSQL schema version, setting registry version/count와 값이 아닌 fingerprint
- database/object storage readiness category
- cleanup queue와 사용자·Organization·Project·Bundle의 집계 수치
- OIDC, Git, package registry의 종류별 active/disabled 개수
- 최대 64개의 process-local allowlisted diagnostic event

Diagnostic event에는 순번, 시각, 고정 event name/level, operation ID, 고정 error code와 HTTP status만
들어간다. ring buffer는 최대 128개이며 오래된 항목부터 제거된다. 재시작 후 유지되는 장기 로그가 아니므로
장애 재현 직후 생성하는 것이 좋다.

## 항상 제외되는 항목

- Project source, Bundle byte와 Object Storage payload
- terminal 출력과 Runtime console 원문
- 환경변수 값, Cookie, token과 authorization header
- OIDC claim, private key, CA PEM과 integration 인증 정보
- request/response body와 PostgreSQL application row

설정 fingerprint는 schema/setting registry/count만으로 만들어져 값의 존재 여부나 credential을 역추론하는
용도로 사용할 수 없다. Bundle을 외부에 전달하기 전에도 설치 조직의 자체 정보보호 절차에 따라 내용을
검토한다.

## 장애 재현 절차

1. 사용자에게 화면의 request reference 또는 operation ID와 UTC 발생 시각을 받는다.
2. 관리자는 Operations에서 dependency와 queue 상태를 확인한다.
3. 문제를 한 번 재현한 직후 Support Bundle을 내려받는다.
4. Bundle의 `diagnostics`에서 operation ID와 error code를 찾는다.
5. 장기 로그·trace가 필요하면 같은 operation ID로 운영자 소유 observability backend를 조회한다.

Bundle 생성 자체가 실패하면 사용자 데이터나 credential을 추가로 수집하지 말고, Core readiness와 브라우저에
표시된 request reference를 사용해 [운영 가이드](../release/operations.md)의 dependency 점검부터 진행한다.
