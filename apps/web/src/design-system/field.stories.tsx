import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { SelectField, TextareaField, TextField } from "#src/components/ui/field.tsx";
import { NumberField } from "#src/components/ui/number-field.tsx";

const meta = {
  component: TextField,
  title: "Components/Field"
} satisfies Meta<typeof TextField>;

export default meta;

type Story = StoryObj<typeof meta>;

export const TextInput: Story = {
  args: {
    description: "값의 용도와 입력 조건을 짧게 안내합니다.",
    label: "표시 이름",
    name: "displayName",
    placeholder: "예: 사내 GitLab"
  }
};

export const FormComposition: Story = {
  args: {
    label: "표시 이름",
    name: "displayName"
  },
  parameters: {
    controls: { disable: true }
  },
  render: () => (
    <form className="storybook-field-grid">
      <TextField label="표시 이름" name="displayName" placeholder="예: 사내 GitLab" required />
      <SelectField
        label="제공자 종류"
        name="provider"
        defaultValue="gitlab"
        options={[
          { value: "github", label: "GitHub" },
          { value: "gitlab", label: "GitLab" },
          { value: "generic", label: "일반 HTTPS" }
        ]}
      />
      <NumberField label="보존 기간(일)" description="증감 버튼과 키보드 방향키를 사용할 수 있습니다." name="retentionDays" min={1} max={365} defaultValue={30} />
      <TextField className="storybook-field-grid__wide" label="API 기본 URL" description="HTTPS 주소를 입력하세요." name="apiBaseUrl" type="url" placeholder="https://git.example.com/api" />
      <TextareaField className="storybook-field-grid__wide" label="설명" description="긴 입력은 세로 크기를 조절할 수 있습니다." name="description" rows={5} />
    </form>
  )
};

export const Density: Story = {
  args: {
    label: "기본 밀도",
    name: "density"
  },
  parameters: {
    controls: { disable: true }
  },
  render: () => (
    <div className="storybook-field-grid">
      <TextField label="기본 밀도" name="defaultDensity" placeholder="기본 입력" />
      <TextField density="compact" label="컴팩트 밀도" name="compactDensity" placeholder="검색·필터용 입력" />
    </div>
  )
};
