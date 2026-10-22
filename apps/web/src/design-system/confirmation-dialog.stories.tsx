import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { ConfirmationDialog } from "#src/components/ui/confirmation-dialog.tsx";

const meta = {
  title: "Components/Confirmation dialog",
  component: ConfirmationDialog,
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    onCancel: () => undefined,
    onConfirm: () => undefined
  }
} satisfies Meta<typeof ConfirmationDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Destructive: Story = {
  args: {
    confirmLabel: "Provider 삭제",
    description: "저장된 credential과 연결 구성이 영구적으로 삭제됩니다.",
    title: "Git Provider를 삭제할까요?",
    tone: "danger"
  }
};

export const PrimaryConfirmation: Story = {
  args: {
    confirmLabel: "변경 사항 적용",
    description: "새 설정은 다음 실행부터 적용됩니다.",
    title: "설정을 적용할까요?",
    tone: "primary"
  }
};
