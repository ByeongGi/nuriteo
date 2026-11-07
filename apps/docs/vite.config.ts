import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin } from "vite";

const isolation = {
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin"
};
const pagesBase = "/nuriteo/";

function pagesFontUrls(): Plugin {
  return {
    name: "docs-pages-font-urls",
    generateBundle(_options, bundle) {
      for (const item of Object.values(bundle)) {
        if (item.type !== "asset" || typeof item.source !== "string" || !item.fileName.endsWith(".css")) continue;
        item.source = item.source.replaceAll("url(/fonts/", `url(${pagesBase}fonts/`);
        item.source = item.source.replaceAll('url("/fonts/', `url("${pagesBase}fonts/`);
      }
    }
  };
}

export default defineConfig(({ command }) => ({
  base: command === "build" ? pagesBase : "/",
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  plugins: [tailwindcss(), react(), pagesFontUrls()],
  server: { headers: isolation, port: 5174 },
  preview: { headers: isolation, port: 5174 }
}));
