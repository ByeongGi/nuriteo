import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { Button } from "../components/ui/button.tsx";

const meta = {
  args: {
    children: "Create workspace",
    disabled: false,
    size: "md",
    variant: "primary"
  },
  argTypes: {
    size: {
      control: "inline-radio",
      options: ["sm", "md", "lg", "icon"]
    },
    variant: {
      control: "inline-radio",
      options: ["primary", "secondary", "ghost", "danger"]
    }
  },
  component: Button,
  title: "Components/Button"
} satisfies Meta<typeof Button>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Variants: Story = {
  parameters: {
    controls: { disable: true }
  },
  render: () => (
    <div className="storybook-row">
      <Button variant="primary">Primary</Button>
      <Button variant="secondary">Secondary</Button>
      <Button variant="ghost">Ghost</Button>
      <Button variant="danger">Danger</Button>
      <Button disabled>Disabled</Button>
    </div>
  )
};

export const Sizes: Story = {
  parameters: {
    controls: { disable: true }
  },
  render: () => (
    <div className="storybook-row storybook-row--baseline">
      <Button size="sm" variant="primary">Small</Button>
      <Button size="md" variant="primary">Medium</Button>
      <Button size="lg" variant="primary">Large</Button>
      <Button aria-label="Add item" size="icon" variant="secondary">+</Button>
    </div>
  )
};
