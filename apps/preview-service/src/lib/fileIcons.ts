export type FileIconKind = "code" | "data" | "style" | "markup" | "document" | "file";

export function fileIconKind(path: string): FileIconKind {
  const extension = path.toLowerCase().split(".").at(-1) || "";
  if (["js", "jsx", "ts", "tsx", "mjs", "cjs", "vue", "svelte"].includes(extension)) return "code";
  if (["json", "yaml", "yml", "toml"].includes(extension)) return "data";
  if (["css", "scss", "sass", "less"].includes(extension)) return "style";
  if (["html", "htm", "svg", "xml"].includes(extension)) return "markup";
  if (["md", "mdx", "txt"].includes(extension)) return "document";
  return "file";
}
