# NURITEO

NURITEO는 GitHub 프로젝트나 템플릿을 브라우저에서 열고 설치, 편집, 실행과 Preview까지 이어갈 수 있는 오픈소스 browser-native 개발 환경이다.

현재 저장소는 브라우저 Runtime과 IDE 기능을 Self-hosted 서비스로 확장하는 단계다. Managed Cloud는 현재 범위에 포함하지 않는다.

## 개발 시작

요구 사항:

- Node.js 24.17 이상, 25 미만
- pnpm 11.15 이상, 12 미만
- Rust toolchain 1.97

```bash
pnpm install
pnpm dev
```

`pnpm dev`는 PostgreSQL과 RustFS는 컨테이너로 유지하고, Core는 Rust 소스 변경 시 자동 재빌드·재시작하며, Web은 Next.js HMR로 저장 즉시 갱신한다. 기본 접속 주소는 `http://127.0.0.1:3000`이다. 종료 후에도 데이터 컨테이너는 남아 다음 실행이 빠르며 `pnpm dev:stack:down`으로 정지할 수 있다.

Backend와 Web을 독립적으로 재시작하려면 터미널을 나누어 실행한다. 첫 번째 터미널의 Backend는 PostgreSQL과 RustFS를 준비하고 Core를 실행하며, 두 번째 터미널의 Web만 자유롭게 종료하거나 다시 켤 수 있다.

```bash
# 터미널 1: DB + 오브젝트 스토리지 + Core
pnpm dev:backend

# 터미널 2: Next.js Web
pnpm dev:web
```

`pnpm dev:fe`는 `pnpm dev:web`과 같은 FE 전용 명령이다.

프로덕션 이미지와 동일한 경계로 PostgreSQL, RustFS, Core, Web을 함께 검증하려면:

```bash
pnpm dev:stack
```

최초 실행 시 `.local/nuriteo-compose`에 개발 전용 인증정보와 TLS가 생성된다.
접속 정보는 `pnpm dev:stack:credentials`, 상태는 `pnpm dev:stack:status`로 확인한다.
`pnpm dev:stack:down`은 데이터를 보존하며, `pnpm dev:stack:reset`만 데이터와 인증정보를 삭제한다.

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
- [사용자 제품 경험](./docs/productization/user-product-experience-plan.md)
- [Self-hosted 정책](./docs/policies/README.md)
- [지원 매트릭스](./docs/release/support-matrix.md)
- [알려진 제한](./docs/release/known-limitations.md)

## 라이선스

NURITEO는 [Apache License 2.0](./LICENSE)으로 배포한다.
