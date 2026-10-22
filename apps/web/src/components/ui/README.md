# UI primitive policy

`components/ui` is the styled Base UI layer. Keep it independent from product domains.

- Prefer one file per Base UI primitive (`checkbox`, `switch`, `radio-group`, and so on).
- Preserve the Base UI interaction and accessibility contract; customize visuals with Tailwind Variants.
- Keep labels, descriptions, validation, density, and visual variants domain-neutral.
- Do not import application APIs, routes, domain models, or domain copy here.
- Keep product compositions beside their route or feature. Similar markup may remain duplicated when its behavior can diverge.
- Add a shared recipe only when it is accessibility-sensitive or already used by multiple independent features.
- Remove the corresponding selector from `globals.css` when a primitive owns its styles.
- Import application modules through the native `#src/*` alias instead of relative paths.

The dependency direction is:

```text
Base UI -> components/ui -> route-local composition -> screen
```

Code in `components/ui` must never depend on a route-local composition.

## Base UI coverage

The installed Base UI catalog is the source of truth. Visible primitives are covered either by a
thin compound wrapper or by a deliberate higher-level field recipe:

- Navigation: `accordion`, `collapsible`, `menu`, `context-menu`, `menubar`, `navigation-menu`, `tabs`, `toolbar`.
- Overlays and feedback: `alert-dialog` through `confirmation-dialog`, `dialog`, `drawer`, `popover`, `preview-card`, `toast`, `tooltip`.
- Inputs: `autocomplete`, `button`, `checkbox`, `checkbox-group`, `combobox`, `field`, `fieldset`, `form`, `input`, `number-field`, `otp-field`, `radio-group`, `select` through `SelectField`, `slider`, `switch`, `toggle`, `toggle-group`.
- Display and layout: `avatar`, `meter`, `progress`, `scroll-area`, `separator`.

Base UI infrastructure exports (`csp-provider`, `direction-provider`, `merge-props`, `use-render`,
and media-query utilities) are not styled components. Import them directly from Base UI when a
platform-level need appears; do not add pass-through files to this directory.
