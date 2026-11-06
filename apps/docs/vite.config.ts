import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const isolation = {
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin"
};

export default defineConfig({
  plugins: [react()],
  server: { headers: isolation, port: 5174 },
  preview: { headers: isolation, port: 5174 }
});
