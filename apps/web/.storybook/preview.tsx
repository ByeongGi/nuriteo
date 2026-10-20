import type { Decorator, Preview } from "@storybook/nextjs-vite";

import "../src/styles/globals.css";
import "../src/design-system/storybook.css";

const withTheme: Decorator = (Story, context) => {
  document.documentElement.dataset.themeMode = context.globals.theme;

  return (
    <div className="storybook-canvas">
      <Story />
    </div>
  );
};

const preview: Preview = {
  decorators: [withTheme],
  globalTypes: {
    theme: {
      description: "Design system color mode",
      toolbar: {
        icon: "paintbrush",
        items: [
          { title: "Light", value: "light" },
          { title: "Dark", value: "dark" }
        ]
      }
    }
  },
  initialGlobals: {
    theme: "light"
  },
  parameters: {
    a11y: {
      test: "todo"
    },
    controls: {
      expanded: true,
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i
      }
    },
    docs: {
      codePanel: true
    },
    layout: "centered",
    options: {
      storySort: {
        order: ["Foundations", "Components"]
      }
    }
  },
  tags: ["autodocs"]
};

export default preview;
