import prettier from "prettier/standalone";
import estree from "prettier/plugins/estree";
import babel from "prettier/plugins/babel";
import typescript from "prettier/plugins/typescript";
import postcss from "prettier/plugins/postcss";
import html from "prettier/plugins/html";
import markdown from "prettier/plugins/markdown";

export async function formatDocument(path: string, source: string): Promise<string> {
  const lower = path.toLowerCase();
  let parser: string | null = null;
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) parser = "typescript";
  else if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) parser = "babel";
  else if (lower.endsWith(".json")) parser = "json";
  else if (lower.endsWith(".css")) parser = "css";
  else if (lower.endsWith(".html") || lower.endsWith(".htm")) parser = "html";
  else if (lower.endsWith(".md") || lower.endsWith(".markdown")) parser = "markdown";
  if (!parser) return source;

  return prettier.format(source, {
    parser,
    plugins: [estree, babel, typescript, postcss, html, markdown],
    printWidth: 100,
    tabWidth: 2,
    semi: true,
    singleQuote: false
  });
}
