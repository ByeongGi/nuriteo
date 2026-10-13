# NURITEO

NURITEO는 GitHub 프로젝트나 템플릿을 브라우저에서 열고 설치, 편집, 실행과 Preview까지 이어갈 수 있는 오픈소스 browser-native 개발 환경이다.

현재 저장소는 브라우저 Runtime과 IDE 기능을 Self-hosted 서비스로 확장하는 단계다. Managed Cloud는 현재 범위에 포함하지 않는다.

이 공개 저장소에는 실행 가능한 제품 소스, 테스트, 패키징과 사용자·운영 문서만 포함한다.
내부 기획, 설계 검토, 작업 세션과 출시 승인 기록은 별도 비공개 저장소에서 관리한다.

## 개발 시작

요구 사항:

- Node.js 22.23 이상, 23 미만
- pnpm 11.15 이상, 12 미만
- Rust toolchain 1.97

```bash
pnpm install
pnpm dev:web
```

주요 검증 명령:

```bash
pnpm check:workspace
pnpm check:types
pnpm test:web
pnpm test:workspace-runtime
cargo test --workspace
```

## 문서

- [문서 인덱스](./docs/README.md)
- [지원 매트릭스](./docs/release/support-matrix.md)
- [알려진 제한](./docs/release/known-limitations.md)
- [운영 가이드](./docs/release/operations.md)
- [보안 정책](./SECURITY.md)

## 라이선스

NURITEO는 [Apache License 2.0](./LICENSE)으로 배포한다.
