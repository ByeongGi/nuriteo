import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";

import { CheckboxField } from "#src/components/ui/checkbox.tsx";
import { RadioCardGroup } from "#src/components/ui/radio-group.tsx";
import { SwitchField } from "#src/components/ui/switch.tsx";

const meta = {
  component: CheckboxField,
  title: "Components/Checkbox, Switch and Radio Group"
} satisfies Meta<typeof CheckboxField>;

export default meta;

type Story = StoryObj<typeof meta>;

export const AllChoices: Story = {
  args: { label: "선택 항목" },
  parameters: { controls: { disable: true } },
  render: () => <ChoiceFieldPreview />
};

function ChoiceFieldPreview() {
  const [mode, setMode] = useState<"optional" | "required">("optional");
  const [enabled, setEnabled] = useState(true);
  return (
    <div className="grid max-w-xl gap-6">
      <CheckboxField label="보안 변경을 확인했습니다" description="동의나 위험 확인처럼 명시적인 선택에 사용합니다." />
      <SwitchField appearance="card" label="자동 백업" description="지속되는 켜기·끄기 설정에 사용합니다." checked={enabled} onCheckedChange={setEnabled} />
      <RadioCardGroup
        label="MFA 정책"
        name="mfaMode"
        value={mode}
        onValueChange={setMode}
        options={[
          { value: "optional", label: "선택", description: "사용자가 MFA 사용 여부를 선택합니다." },
          { value: "required", label: "필수", description: "모든 로컬 사용자에게 MFA를 요구합니다." }
        ]}
      />
    </div>
  );
}
