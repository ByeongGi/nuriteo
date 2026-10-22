import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { HomeEntry } from "#src/app/_components/home-entry.tsx";

const meta = {
  parameters: { layout: "fullscreen" },
  title: "UX Redesign/00 Product Home"
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { render: () => <HomeEntry /> };
