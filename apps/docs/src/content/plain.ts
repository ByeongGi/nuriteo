import type { Block, Copy } from "./types.ts";

export function copyPlain(copy: Copy): string {
  return [copy.nav, copy.eyebrow, copy.title, copy.lead, ...copy.blocks.map(blockPlain)].join("\n");
}

export function blockPlain(block: Block): string {
  switch (block.type) {
    case "p":
    case "h2":
    case "code":
      return block.text;
    case "ul":
      return block.items.join("\n");
    case "example":
      return [block.title, block.text, block.code, block.result].join("\n");
    case "playground":
    case "cases":
      return "";
    case "links":
      return block.items.map((item) => [item.label, item.detail, item.to].filter(Boolean).join(" ")).join("\n");
    case "callout":
      return [block.title, block.text].filter(Boolean).join("\n");
    case "steps":
      return block.items.map((item) => `${item.title}\n${item.text}`).join("\n");
    case "api":
      return block.items.map((item) => `${item.name}\n${item.signature}\n${item.text}`).join("\n");
    case "table":
      return [block.columns.join(" "), ...block.rows.map((row) => row.join(" "))].join("\n");
    default: {
      const exhaustive: never = block;
      return exhaustive;
    }
  }
}
