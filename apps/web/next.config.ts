import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    cpus: 1,
    parallelServerBuildTraces: false,
    parallelServerCompiles: false,
    webpackBuildWorker: false
  },
  generateBuildId: async () => process.env.NURITEO_BUILD_REVISION ?? "development",
  async headers() {
    const isolationHeaders = [
      { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
      { key: "Cross-Origin-Opener-Policy", value: "same-origin" }
    ];
    return [
      { source: "/:path*", headers: isolationHeaders },
      {
        source: "/runtime/manifest.json",
        headers: [{ key: "Cache-Control", value: "no-store" }]
      },
      {
        source: "/runtime/:revision([0-9a-f]{64})/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }]
      },
      {
        source: "/runtime/:revision([0-9a-f]{64})/preview-sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache" },
          { key: "Service-Worker-Allowed", value: "/" }
        ]
      }
    ];
  },
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true
};

export default nextConfig;
