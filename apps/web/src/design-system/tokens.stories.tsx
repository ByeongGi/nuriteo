import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import type { CSSProperties } from "react";
import { useDeferredValue, useState } from "react";

import type { FoundationToken, TokenGroup } from "./token-registry.ts";
import { tokenGroups } from "./token-registry.ts";

type TokenCatalogProps = {
  groups: TokenGroup[];
  title: string;
};

function readTokenValue(name: FoundationToken["name"]) {
  if (typeof window === "undefined") {
    return "—";
  }

  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "—";
}

function TypographyPreview({ name }: Readonly<{ name: FoundationToken["name"] }>) {
  const style: CSSProperties = {};

  if (name.includes("family")) style.fontFamily = `var(${name})`;
  if (name.includes("size")) style.fontSize = `var(${name})`;
  if (name.includes("weight")) style.fontWeight = `var(${name})`;
  if (name.includes("line-height")) style.lineHeight = `var(${name})`;

  return <span className="token-preview__type" style={style}>Ag</span>;
}

function TokenPreview({ token }: Readonly<{ token: FoundationToken }>) {
  const tokenValue = `var(${token.name})`;

  if (token.kind === "color") {
    return <span className="token-preview__color" style={{ background: tokenValue }} />;
  }

  if (token.kind === "typography") {
    return <TypographyPreview name={token.name} />;
  }

  if (token.kind === "spacing" || token.kind === "layout") {
    const style = { "--token-size": tokenValue } as CSSProperties;
    return <span className="token-preview__length" style={style} />;
  }

  if (token.kind === "radius") {
    return <span className="token-preview__radius" style={{ borderRadius: tokenValue }} />;
  }

  if (token.kind === "shadow") {
    return <span className="token-preview__shadow" style={{ boxShadow: tokenValue }} />;
  }

  if (token.kind === "motion") {
    const style = {
      transitionDuration: token.name.includes("duration") ? tokenValue : undefined,
      transitionTimingFunction: token.name.includes("easing") ? tokenValue : undefined
    };
    return <span className="token-preview__motion" style={style} />;
  }

  return <span className="token-preview__layers"><i /><i /><i /></span>;
}

function TokenGroupTable({ group }: Readonly<{ group: TokenGroup }>) {
  return (
    <section className="token-catalog__group" id={group.id}>
      <header>
        <div>
          <p>{group.tokens.length} tokens</p>
          <h2>{group.title}</h2>
        </div>
        <p>{group.description}</p>
      </header>
      <div
        aria-label={`${group.title} token table`}
        className="token-table-wrapper"
        role="region"
        tabIndex={0}
      >
        <table className="token-table">
          <thead>
            <tr>
              <th scope="col">Tier</th>
              <th scope="col">CSS token</th>
              <th scope="col">Tailwind API</th>
              <th scope="col">Preview</th>
              <th scope="col">Computed value</th>
              <th scope="col">Role</th>
            </tr>
          </thead>
          <tbody>
            {group.tokens.map((token) => (
              <tr key={token.name}>
                <td><span className={`token-tier token-tier--${token.tier.toLowerCase()}`}>{token.tier}</span></td>
                <th scope="row"><code>{token.name}</code></th>
                <td>{token.tailwind ? <code className="token-tailwind">{token.tailwind}</code> : <span className="token-internal">Internal only</span>}</td>
                <td><TokenPreview token={token} /></td>
                <td><output>{readTokenValue(token.name)}</output></td>
                <td>{token.role}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TokenCatalog({ groups, title }: Readonly<TokenCatalogProps>) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const normalizedQuery = deferredQuery.trim().toLowerCase();
  const visibleGroups = normalizedQuery.length === 0
    ? groups
    : groups
        .map((group) => ({
          ...group,
          tokens: group.tokens.filter((token) => {
            const searchableValue = [token.name, token.role, token.tailwind, token.tier, readTokenValue(token.name)]
              .join(" ")
              .toLowerCase();

            return searchableValue.includes(normalizedQuery);
          })
        }))
        .filter((group) => group.tokens.length > 0);
  const tokenCount = groups.reduce((count, group) => count + group.tokens.length, 0);
  const visibleTokenCount = visibleGroups.reduce((count, group) => count + group.tokens.length, 0);

  return (
    <main className="token-catalog">
      <header className="token-catalog__hero">
        <p>NURITEO · TAILWIND CSS 4 FOUNDATIONS</p>
        <h1>{title}</h1>
        <p>
          Hanji + Cheonghwa foundations, semantic roles, and the supported Tailwind API are rendered
          from production CSS. Switch themes to inspect live values.
        </p>
        <div>
          <strong>{tokenCount}</strong>
          <span>tokens in this view</span>
        </div>
      </header>

      <nav aria-label="Token categories" className="token-catalog__nav">
        {groups.map((group) => <a href={`#${group.id}`} key={group.id}>{group.title}</a>)}
      </nav>

      <div className="token-catalog__search">
        <label htmlFor="token-search">Search tokens</label>
        <input
          autoComplete="off"
          id="token-search"
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Search CSS tokens, Tailwind classes, values, or roles…"
          type="search"
          value={query}
        />
        <output aria-live="polite">
          Showing {visibleTokenCount} of {tokenCount}
        </output>
      </div>

      {visibleGroups.map((group) => <TokenGroupTable group={group} key={group.id} />)}

      {visibleGroups.length === 0 ? (
        <div className="token-catalog__empty">
          <h2>No matching tokens</h2>
          <p>Try a CSS variable name, a computed value, or an interface role.</p>
        </div>
      ) : null}
    </main>
  );
}

const meta = {
  component: TokenCatalog,
  parameters: {
    layout: "fullscreen"
  },
  title: "Foundations/Design tokens"
} satisfies Meta<typeof TokenCatalog>;

export default meta;

type Story = StoryObj<typeof meta>;

export const AllTokens: Story = {
  args: {
    groups: tokenGroups,
    title: "Design tokens"
  },
  name: "All tokens"
};

export const Color: Story = {
  args: {
    groups: tokenGroups.filter((group) => group.id.includes("color")),
    title: "Color tokens"
  }
};

export const Palette: Story = {
  args: {
    groups: tokenGroups.filter((group) => ["hanji", "cheonghwa", "status-reference"].includes(group.id)),
    title: "Hanji + Cheonghwa"
  }
};

export const Typography: Story = {
  args: {
    groups: tokenGroups.filter((group) => group.id === "typography"),
    title: "Typography tokens"
  }
};

export const SpacingAndShape: Story = {
  args: {
    groups: tokenGroups.filter((group) => ["spacing", "shape-elevation"].includes(group.id)),
    title: "Spacing & shape tokens"
  },
  name: "Spacing & shape"
};

export const MotionAndLayout: Story = {
  args: {
    groups: tokenGroups.filter((group) => ["motion", "layout-stacking"].includes(group.id)),
    title: "Motion & layout tokens"
  },
  name: "Motion & layout"
};
