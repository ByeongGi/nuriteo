import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";

import { SegmentedControl } from "#src/components/ui/segmented-control.tsx";

const meta = {
  component: SegmentedControl,
  title: "Components/Segmented Control",
  parameters: { controls: { disable: true } }
} satisfies Meta<typeof SegmentedControl>;

export default meta;

type Story = StoryObj<typeof meta>;

export const SingleSelection: Story = {
  args: {
    "aria-label": "프로젝트 상태",
    onValueChange: () => undefined,
    options: [],
    value: "all"
  },
  render: () => <SegmentedControlPreview />
};

function SegmentedControlPreview() {
  const [value, setValue] = useState<"all" | "active" | "archived">("all");
  return (
    <SegmentedControl
      aria-label="프로젝트 상태"
      value={value}
      onValueChange={setValue}
      options={[
        { value: "all", label: "전체 24" },
        { value: "active", label: "활성 19" },
        { value: "archived", label: "보관 5" }
      ]}
    />
  );
}
