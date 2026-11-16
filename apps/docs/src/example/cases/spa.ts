import type { ContainerCase } from "./types.ts";

const indexHtml = `<!doctype html>
<html lang="ko">
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>
`;

const mainJs = `const root = document.querySelector("#app");
root.textContent = "spa-ready";
`;

const packageJson = `{
  "name": "spa",
  "private": true
}
`;

export const containerCase = {
  kind: "spa",
  entry: "src/main.js",
  previewScript: null,
  files: [
    { path: "package.json", contents: packageJson },
    { path: "index.html", contents: indexHtml },
    { path: "src/main.js", contents: mainJs }
  ]
} satisfies ContainerCase;
