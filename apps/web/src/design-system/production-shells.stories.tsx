import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { AdminAccessRequired } from "../app/(authenticated)/admin/_components/admin-access-required.tsx";
import { ProductEntryShell } from "../app/_components/product-entry-shell.tsx";
import { Button } from "../components/ui/button.tsx";

const meta = {
  parameters: { layout: "fullscreen" },
  title: "Patterns/Production shells"
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Entry: Story = {
  render: () => (
    <ProductEntryShell
      compact
      description="회사 계정으로 계속하거나 관리자가 제공한 로컬 계정을 사용하세요."
      eyebrow="다시 오신 것을 환영합니다"
      title="NURITEO 로그인"
      titleId="production-entry-title"
    >
      <form className="sign-in-form">
        <label className="field-group" htmlFor="production-entry-email">
          이메일
          <input id="production-entry-email" type="email" placeholder="name@company.com" />
        </label>
        <label className="field-group" htmlFor="production-entry-password">
          비밀번호
          <input id="production-entry-password" type="password" placeholder="비밀번호 입력" />
        </label>
        <Button type="button" variant="primary">로그인</Button>
      </form>
    </ProductEntryShell>
  )
};

export const RestrictedAdministration: Story = {
  render: () => (
    <AdminAccessRequired description="서버 설정을 변경하려면 인스턴스 관리자 권한이 필요합니다." />
  )
};
