import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import type { ReactNode } from "react";

import { Button } from "#src/components/ui/button.tsx";
import { Input } from "#src/components/ui/input.tsx";

type LoginPreviewProps = Readonly<{
  children: ReactNode;
}>;

type OidcProvider = Readonly<{
  id: string;
  label: string;
  mark: string;
}>;

type OidcProviderListProps = Readonly<{
  error?: string;
  providers: readonly OidcProvider[];
}>;

type LocalLoginFormProps = Readonly<{
  error?: string;
}>;

const companyProvider = { id: "company", label: "회사 계정으로 계속", mark: "S" } as const;
const enterpriseProviders = [
  { id: "entra", label: "Microsoft Entra ID로 계속", mark: "M" },
  { id: "google", label: "Google Workspace로 계속", mark: "G" }
] as const;

function BrandMark() {
  return (
    <a className="login-v2__brand" href="#login-v2-home" aria-label="NURITEO 홈">
      <span aria-hidden="true">N</span>
      <strong>NURITEO</strong>
    </a>
  );
}

function OidcProviderList({ error, providers }: OidcProviderListProps) {
  return (
    <div className="login-v2__sso-list" aria-label="OIDC 계정 로그인">
      {error ? <p className="login-v2__error" role="alert"><i aria-hidden="true">!</i>{error}</p> : null}
      {providers.map((provider) => (
        <Button className="login-v2__sso" key={provider.id} type="button">
          <span aria-hidden="true">{provider.mark}</span>
          {provider.label}
        </Button>
      ))}
    </div>
  );
}

function AuthenticationDivider() {
  return <div className="login-v2__divider"><span>또는 로컬 계정</span></div>;
}

function LocalLoginForm({ error }: LocalLoginFormProps) {
  return (
    <form className="login-v2__form">
      <label htmlFor="login-v2-email">
        <span>이메일</span>
        <Input
          aria-describedby={error ? "login-v2-error" : undefined}
          autoComplete="username"
          defaultValue={error ? "admin@example.test" : undefined}
          id="login-v2-email"
          inputMode="email"
          placeholder="name@company.com"
          type="email"
        />
      </label>
      <label htmlFor="login-v2-password">
        <span>비밀번호</span>
        <Input
          aria-describedby={error ? "login-v2-error" : "login-v2-password-help"}
          autoComplete="current-password"
          id="login-v2-password"
          placeholder="비밀번호 입력"
          type="password"
        />
      </label>
      {error ? <p className="login-v2__error" id="login-v2-error" role="alert"><i aria-hidden="true">!</i>{error}</p> : null}
      <Button className="login-v2__submit" type="submit">로그인</Button>
    </form>
  );
}

function LoginPreview({ children }: LoginPreviewProps) {
  return (
    <main className="login-v2" id="login-v2-main">
      <div className="login-v2__shell">
        <aside className="login-v2__brand-panel" aria-label="누리터 인스턴스 정보">
          <BrandMark />

          <p className="login-v2__summary">
            설치 없이 브라우저에서 Node.js 프로젝트를 개발하고 실행하세요.
          </p>

          <div className="login-v2__instance">
            <span>개발 서버</span>
            <small>v0.1.0</small>
          </div>
        </aside>

        <section className="login-v2__main" aria-labelledby="login-v2-title">
          <div className="login-v2__heading">
            <h1 id="login-v2-title">로그인</h1>
          </div>

          {children}

          <p className="login-v2__help" id="login-v2-password-help">
            로그인 문제는 관리자에게 문의하세요.
          </p>
        </section>
      </div>
    </main>
  );
}

const meta = {
  parameters: {
    layout: "fullscreen"
  },
  title: "UX Redesign/01 Login"
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const LocalAccount: Story = {
  render: () => <LoginPreview><LocalLoginForm /></LoginPreview>
};

export const CompanySSO: Story = {
  name: "단일 OIDC 제공자",
  render: () => (
    <LoginPreview>
      <OidcProviderList providers={[companyProvider]} />
      <AuthenticationDivider />
      <LocalLoginForm />
    </LoginPreview>
  )
};

export const MultipleOidcProviders: Story = {
  name: "여러 OIDC 제공자",
  render: () => (
    <LoginPreview>
      <OidcProviderList providers={enterpriseProviders} />
      <AuthenticationDivider />
      <LocalLoginForm />
    </LoginPreview>
  )
};

export const OidcAuthenticationError: Story = {
  name: "OIDC 인증 실패",
  render: () => (
    <LoginPreview>
      <OidcProviderList error="회사 계정 로그인을 완료하지 못했습니다. 다시 시도하세요." providers={[companyProvider]} />
      <AuthenticationDivider />
      <LocalLoginForm />
    </LoginPreview>
  )
};

export const OidcOnly: Story = {
  name: "OIDC 전용 로그인",
  render: () => (
    <LoginPreview>
      <OidcProviderList providers={enterpriseProviders} />
    </LoginPreview>
  )
};

export const AuthenticationError: Story = {
  name: "로컬 인증 실패",
  render: () => <LoginPreview><LocalLoginForm error="이메일 또는 비밀번호를 다시 확인하세요." /></LoginPreview>
};
