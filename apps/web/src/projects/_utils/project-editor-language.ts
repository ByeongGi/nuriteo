const WEB_LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  astro: "html",
  cjs: "javascript",
  css: "css",
  cts: "typescript",
  ctsx: "typescript",
  gql: "graphql",
  graphql: "graphql",
  html: "html",
  ini: "ini",
  js: "javascript",
  json: "json",
  jsonc: "json",
  jsx: "javascript",
  less: "less",
  md: "markdown",
  mdx: "mdx",
  mjs: "javascript",
  mts: "typescript",
  scss: "scss",
  svg: "xml",
  svelte: "html",
  ts: "typescript",
  tsx: "typescript",
  vue: "html",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml"
};

const FRAMEWORK_LABEL_BY_EXTENSION: Readonly<Record<string, string>> = {
  astro: "Astro",
  svelte: "Svelte",
  vue: "Vue"
};

const LANGUAGE_LABEL: Readonly<Record<string, string>> = {
  css: "CSS",
  graphql: "GraphQL",
  html: "HTML",
  ini: "INI",
  javascript: "JavaScript",
  json: "JSON",
  less: "Less",
  markdown: "Markdown",
  mdx: "MDX",
  plaintext: "텍스트",
  scss: "SCSS",
  typescript: "TypeScript",
  xml: "XML",
  yaml: "YAML"
};

const FILENAME_LANGUAGE: Readonly<Record<string, string>> = {
  ".editorconfig": "ini",
  ".gitattributes": "ini",
  ".gitconfig": "ini"
};

export function editorLanguageForPath(path: string): string {
  const fileName = path.split("/").at(-1)?.toLocaleLowerCase() ?? "";
  if (fileName === ".env" || fileName.startsWith(".env.")) return "ini";
  const namedLanguage = FILENAME_LANGUAGE[fileName];
  if (namedLanguage !== undefined) return namedLanguage;
  const extension = fileName.split(".").at(-1);
  if (extension === undefined || extension === fileName) return "plaintext";
  return WEB_LANGUAGE_BY_EXTENSION[extension] ?? "plaintext";
}

export function editorLanguageLabel(path: string | undefined): string {
  if (path === undefined) return "텍스트";
  const fileName = path.split("/").at(-1)?.toLocaleLowerCase() ?? "";
  const extension = fileName.split(".").at(-1);
  if (extension !== undefined && extension !== fileName) {
    const frameworkLabel = FRAMEWORK_LABEL_BY_EXTENSION[extension];
    if (frameworkLabel !== undefined) return frameworkLabel;
  }
  if (fileName === ".env" || fileName.startsWith(".env.")) return "환경 변수";
  return LANGUAGE_LABEL[editorLanguageForPath(path)] ?? "텍스트";
}
