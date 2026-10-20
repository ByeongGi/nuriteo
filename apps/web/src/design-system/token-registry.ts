type TokenName = `--n-${string}`;

type TokenKind =
  | "color"
  | "layout"
  | "motion"
  | "radius"
  | "shadow"
  | "spacing"
  | "typography"
  | "z-index";

type TokenTier = "Reference" | "Semantic";

type FoundationToken = {
  kind: TokenKind;
  name: TokenName;
  role: string;
  tailwind?: string;
  tier: TokenTier;
};

type TokenGroup = {
  description: string;
  id: string;
  title: string;
  tokens: FoundationToken[];
};

type TokenOptions = {
  tailwind?: string;
  tier?: TokenTier;
};

function token(
  kind: TokenKind,
  name: TokenName,
  role: string,
  options: TokenOptions = {}
): FoundationToken {
  return {
    kind,
    name,
    role,
    ...(options.tailwind === undefined ? {} : { tailwind: options.tailwind }),
    tier: options.tier ?? "Reference"
  };
}

function scaleTokens(
  kind: TokenKind,
  names: TokenName[],
  role: string
): FoundationToken[] {
  return names.map((name) => token(kind, name, role));
}

const hanjiTokens = scaleTokens(
  "color",
  [
    "--n-ref-color-hanji-50",
    "--n-ref-color-hanji-100",
    "--n-ref-color-hanji-200",
    "--n-ref-color-hanji-300",
    "--n-ref-color-hanji-400",
    "--n-ref-color-hanji-500",
    "--n-ref-color-hanji-600",
    "--n-ref-color-hanji-700",
    "--n-ref-color-hanji-800",
    "--n-ref-color-hanji-850",
    "--n-ref-color-hanji-900",
    "--n-ref-color-hanji-950"
  ],
  "Soft blue-white to ink-navy scale for canvas, surfaces, borders, and text."
);

const cheonghwaTokens = scaleTokens(
  "color",
  [
    "--n-ref-color-cheonghwa-50",
    "--n-ref-color-cheonghwa-100",
    "--n-ref-color-cheonghwa-200",
    "--n-ref-color-cheonghwa-300",
    "--n-ref-color-cheonghwa-400",
    "--n-ref-color-cheonghwa-500",
    "--n-ref-color-cheonghwa-600",
    "--n-ref-color-cheonghwa-700",
    "--n-ref-color-cheonghwa-800",
    "--n-ref-color-cheonghwa-900",
    "--n-ref-color-cheonghwa-950"
  ],
  "Blue-and-white porcelain-inspired Cheonghwa scale for action, selection, and focus roles."
);

const statusReferenceTokens = [
  ...scaleTokens("color", [
    "--n-ref-color-indigo-50",
    "--n-ref-color-indigo-100",
    "--n-ref-color-indigo-400",
    "--n-ref-color-indigo-600",
    "--n-ref-color-indigo-700"
  ], "Indigo informational reference color."),
  ...scaleTokens("color", [
    "--n-ref-color-pine-50",
    "--n-ref-color-pine-100",
    "--n-ref-color-pine-400",
    "--n-ref-color-pine-600",
    "--n-ref-color-pine-700"
  ], "Pine success reference color."),
  ...scaleTokens("color", [
    "--n-ref-color-ochre-50",
    "--n-ref-color-ochre-100",
    "--n-ref-color-ochre-400",
    "--n-ref-color-ochre-600",
    "--n-ref-color-ochre-700"
  ], "Ochre warning reference color."),
  ...scaleTokens("color", [
    "--n-ref-color-cinnabar-50",
    "--n-ref-color-cinnabar-100",
    "--n-ref-color-cinnabar-400",
    "--n-ref-color-cinnabar-600",
    "--n-ref-color-cinnabar-700"
  ], "Cinnabar danger reference color.")
];

const semanticColorTokens: FoundationToken[] = [
  token("color", "--n-color-bg-page", "Application canvas.", { tailwind: "bg-background", tier: "Semantic" }),
  token("color", "--n-color-bg-sidebar", "Navigation and application chrome.", { tailwind: "bg-sidebar", tier: "Semantic" }),
  token("color", "--n-color-bg-subtle", "Low-emphasis grouped content.", { tailwind: "bg-subtle", tier: "Semantic" }),
  token("color", "--n-color-bg-surface", "Default card, panel, and control surface.", { tailwind: "bg-surface", tier: "Semantic" }),
  token("color", "--n-color-bg-raised", "Surface raised above standard content.", { tailwind: "bg-raised", tier: "Semantic" }),
  token("color", "--n-color-bg-overlay", "Menus, popovers, and dialogs.", { tailwind: "bg-overlay", tier: "Semantic" }),
  token("color", "--n-color-bg-hover", "Pointer-hover feedback.", { tailwind: "bg-hover", tier: "Semantic" }),
  token("color", "--n-color-bg-active", "Pressed control feedback.", { tailwind: "bg-active", tier: "Semantic" }),
  token("color", "--n-color-bg-selected", "Persistent selected state.", { tailwind: "bg-selected", tier: "Semantic" }),
  token("color", "--n-color-bg-disabled", "Unavailable control surface.", { tailwind: "bg-disabled", tier: "Semantic" }),
  token("color", "--n-color-fg-default", "Primary text and icon color.", { tailwind: "text-foreground", tier: "Semantic" }),
  token("color", "--n-color-fg-muted", "Supporting copy and secondary labels.", { tailwind: "text-muted-foreground", tier: "Semantic" }),
  token("color", "--n-color-fg-subtle", "Metadata, placeholders, and tertiary labels.", { tailwind: "text-subtle-foreground", tier: "Semantic" }),
  token("color", "--n-color-fg-disabled", "Unavailable text and icons.", { tailwind: "text-disabled-foreground", tier: "Semantic" }),
  token("color", "--n-color-fg-accent", "Brand emphasis used as foreground content.", { tailwind: "text-accent-foreground", tier: "Semantic" }),
  token("color", "--n-color-fg-on-primary", "Content on a primary action.", { tailwind: "text-on-primary", tier: "Semantic" }),
  token("color", "--n-color-fg-on-danger", "Content on a destructive action.", { tailwind: "text-on-danger", tier: "Semantic" }),
  token("color", "--n-color-fg-link", "Inline navigation and text links.", { tailwind: "text-link", tier: "Semantic" }),
  token("color", "--n-color-border-muted", "Quiet separator.", { tailwind: "border-muted-border", tier: "Semantic" }),
  token("color", "--n-color-border-default", "Standard component boundary.", { tailwind: "border-border", tier: "Semantic" }),
  token("color", "--n-color-border-strong", "Interactive or emphasized boundary with at least 3:1 contrast.", { tailwind: "border-strong-border", tier: "Semantic" }),
  token("color", "--n-color-border-focus", "Keyboard focus indicator.", { tailwind: "ring-focus", tier: "Semantic" }),
  token("color", "--n-color-action-primary", "Primary action fill.", { tailwind: "bg-primary", tier: "Semantic" }),
  token("color", "--n-color-action-primary-hover", "Primary action hover fill.", { tailwind: "bg-primary-strong", tier: "Semantic" }),
  token("color", "--n-color-action-primary-active", "Primary action pressed fill.", { tailwind: "bg-primary-active", tier: "Semantic" }),
  token("color", "--n-color-status-success", "Successful completion and healthy state.", { tailwind: "text-success", tier: "Semantic" }),
  token("color", "--n-color-status-success-subtle", "Quiet success background.", { tailwind: "bg-success-subtle", tier: "Semantic" }),
  token("color", "--n-color-status-warning", "Caution and recoverable risk.", { tailwind: "text-warning", tier: "Semantic" }),
  token("color", "--n-color-status-warning-subtle", "Quiet warning background.", { tailwind: "bg-warning-subtle", tier: "Semantic" }),
  token("color", "--n-color-status-danger", "Destructive actions and critical failures.", { tailwind: "text-danger", tier: "Semantic" }),
  token("color", "--n-color-status-danger-subtle", "Quiet danger background.", { tailwind: "bg-danger-subtle", tier: "Semantic" }),
  token("color", "--n-color-status-info", "Informational state and guidance.", { tailwind: "text-info", tier: "Semantic" }),
  token("color", "--n-color-status-info-subtle", "Quiet informational background.", { tailwind: "bg-info-subtle", tier: "Semantic" })
];

const spacingSteps = [
  ["--n-ref-space-0", "0"],
  ["--n-ref-space-px", "px"],
  ["--n-ref-space-0-5", "0.5"],
  ["--n-ref-space-1", "1"],
  ["--n-ref-space-1-5", "1.5"],
  ["--n-ref-space-2", "2"],
  ["--n-ref-space-2-5", "2.5"],
  ["--n-ref-space-3", "3"],
  ["--n-ref-space-4", "4"],
  ["--n-ref-space-5", "5"],
  ["--n-ref-space-6", "6"],
  ["--n-ref-space-8", "8"],
  ["--n-ref-space-10", "10"],
  ["--n-ref-space-12", "12"],
  ["--n-ref-space-16", "16"],
  ["--n-ref-space-20", "20"],
  ["--n-ref-space-24", "24"]
] as const;

const tokenGroups: TokenGroup[] = [
  {
    description: "A soft blue-white to ink-navy ramp behind every product surface.",
    id: "hanji",
    title: "Hanji & Ink",
    tokens: hanjiTokens
  },
  {
    description: "A clear blue-and-white porcelain accent for actions, focus, and selection.",
    id: "cheonghwa",
    title: "Cheonghwa",
    tokens: cheonghwaTokens
  },
  {
    description: "Meaning-bearing colors stay separate from the brand accent.",
    id: "status-reference",
    title: "Status palettes",
    tokens: statusReferenceTokens
  },
  {
    description: "Theme-aware roles exposed as the supported Tailwind color API.",
    id: "semantic-colors",
    title: "Semantic colors",
    tokens: semanticColorTokens
  },
  {
    description: "A compact product type scale mapped to Tailwind text utilities.",
    id: "typography",
    title: "Typography",
    tokens: [
      token("typography", "--n-font-family-sans", "Pretendard Variable product typeface.", { tailwind: "font-sans" }),
      token("typography", "--n-font-family-mono", "Code and technical values.", { tailwind: "font-mono" }),
      token("typography", "--n-font-size-2xs", "Dense metadata and badges."),
      token("typography", "--n-font-size-xs", "Caption and secondary interface text.", { tailwind: "text-xs" }),
      token("typography", "--n-font-size-sm", "Default compact interface text.", { tailwind: "text-sm" }),
      token("typography", "--n-font-size-md", "Reading text and large controls.", { tailwind: "text-base" }),
      token("typography", "--n-font-size-lg", "Small section heading.", { tailwind: "text-lg" }),
      token("typography", "--n-font-size-xl", "Page heading.", { tailwind: "text-xl" }),
      token("typography", "--n-font-size-2xl", "Feature heading.", { tailwind: "text-2xl" }),
      token("typography", "--n-font-size-3xl", "Display heading."),
      ...scaleTokens("typography", [
        "--n-line-height-none",
        "--n-line-height-tight",
        "--n-line-height-snug",
        "--n-line-height-default",
        "--n-line-height-relaxed"
      ], "Line-height option."),
      token("typography", "--n-font-weight-normal", "Body text weight.", { tailwind: "font-normal" }),
      token("typography", "--n-font-weight-medium", "Control and label weight.", { tailwind: "font-medium" }),
      token("typography", "--n-font-weight-semibold", "Heading emphasis.", { tailwind: "font-semibold" }),
      token("typography", "--n-font-weight-bold", "Rare high emphasis.", { tailwind: "font-bold" }),
      token("typography", "--n-letter-spacing-tight", "Large heading tracking.", { tailwind: "tracking-tight" }),
      token("typography", "--n-letter-spacing-normal", "Default tracking.", { tailwind: "tracking-normal" }),
      token("typography", "--n-letter-spacing-wide", "Labels and overlines.", { tailwind: "tracking-wide" })
    ]
  },
  {
    description: "The approved subset of Tailwind's spacing language.",
    id: "spacing",
    title: "Spacing",
    tokens: spacingSteps.map(([name, step]) =>
      token("spacing", name, "Reference spacing step.", {
        tailwind: step === "px" ? "gap-px · p-px" : `gap-${step} · p-${step}`
      })
    )
  },
  {
    description: "Containment and elevation utilities for product surfaces.",
    id: "shape-elevation",
    title: "Shape & elevation",
    tokens: [
      token("radius", "--n-radius-xs", "Tiny indicators and nested controls.", { tailwind: "rounded-xs" }),
      token("radius", "--n-radius-sm", "Compact controls.", { tailwind: "rounded-sm" }),
      token("radius", "--n-radius-md", "Default controls.", { tailwind: "rounded-md" }),
      token("radius", "--n-radius-lg", "Cards and menus.", { tailwind: "rounded-lg" }),
      token("radius", "--n-radius-xl", "Large panels.", { tailwind: "rounded-xl" }),
      token("radius", "--n-radius-2xl", "Feature surfaces.", { tailwind: "rounded-2xl" }),
      token("radius", "--n-radius-full", "Pills and circular controls.", { tailwind: "rounded-full" }),
      token("shadow", "--n-shadow-xs", "Control lift.", { tailwind: "shadow-xs" }),
      token("shadow", "--n-shadow-sm", "Card lift.", { tailwind: "shadow-sm" }),
      token("shadow", "--n-shadow-md", "Menu and floating toolbar.", { tailwind: "shadow-md" }),
      token("shadow", "--n-shadow-lg", "Large floating panel.", { tailwind: "shadow-lg" }),
      token("shadow", "--n-shadow-overlay", "Dialog and highest overlay.", { tailwind: "shadow-overlay" })
    ]
  },
  {
    description: "Fast, productive motion with explicit entrance and exit curves.",
    id: "motion",
    title: "Motion",
    tokens: [
      token("motion", "--n-duration-instant", "Immediate micro feedback.", { tailwind: "duration-instant" }),
      token("motion", "--n-duration-fast", "Hover and pressed feedback.", { tailwind: "duration-fast" }),
      token("motion", "--n-duration-normal", "Local spatial transition.", { tailwind: "duration-normal" }),
      token("motion", "--n-duration-slow", "Overlay entrance.", { tailwind: "duration-slow" }),
      token("motion", "--n-easing-standard", "Default productive motion.", { tailwind: "ease-standard" }),
      token("motion", "--n-easing-enter", "Decelerating entrance.", { tailwind: "ease-enter" }),
      token("motion", "--n-easing-exit", "Accelerating exit.", { tailwind: "ease-exit" })
    ]
  },
  {
    description: "Application shell dimensions and deliberate stacking levels.",
    id: "layout-stacking",
    title: "Layout & stacking",
    tokens: [
      token("layout", "--n-layout-header-height", "Persistent application header height."),
      token("layout", "--n-layout-sidebar-width", "Default expanded sidebar width."),
      token("layout", "--n-layout-content-max", "Maximum application content width."),
      token("layout", "--n-layout-content-gutter", "Responsive content inset."),
      token("z-index", "--n-z-base", "Base content stacking level.", { tailwind: "z-0" }),
      token("z-index", "--n-z-sticky", "Sticky chrome stacking level.", { tailwind: "z-20" }),
      token("z-index", "--n-z-dropdown", "Dropdown stacking level.", { tailwind: "z-40" }),
      token("z-index", "--n-z-popover", "Popover stacking level.", { tailwind: "z-50" }),
      token("z-index", "--n-z-dialog", "Dialog stacking level."),
      token("z-index", "--n-z-toast", "Toast stacking level.")
    ]
  }
];

export type { FoundationToken, TokenGroup, TokenKind, TokenTier };
export { tokenGroups };
