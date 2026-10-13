import assert from "node:assert/strict";
import fs from "node:fs";

const dockerfilePath = "deploy/docker/web.Dockerfile";
const ignorePath = `${dockerfilePath}.dockerignore`;
const dockerfile = fs.readFileSync(dockerfilePath, "utf8");

validateDockerfile(dockerfile);
validateBuildContext();
verifyDriftDetection();

console.log(
  "web image contract ok (pinned standalone build, non-root distroless runtime, allowlisted context)"
);

function validateDockerfile(source) {
  const instructions = source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const fromInstructions = instructions.filter((line) => line.startsWith("FROM "));

  assert.deepEqual(fromInstructions, [
    "FROM docker.io/library/node:22.23.0-bookworm-slim@sha256:d9f850096136edbc402debdd8729579a288aac64574ada0ff4db26b6ae58b0b2 AS dependencies",
    "FROM dependencies AS builder",
    "FROM gcr.io/distroless/nodejs22-debian13:nonroot@sha256:ec2313763dd43931543bd03830466e0c409ce73a487e8d46f10db72d3b816c1c AS runtime"
  ]);
  assert(
    instructions.includes("RUN pnpm install --frozen-lockfile --filter @nuriteo/web..."),
    "web dependencies must use the frozen root lockfile"
  );
  assert(
    instructions.includes("RUN pnpm --filter @nuriteo/web build"),
    "builder must run the Web production build"
  );
  assert(
    instructions.includes("COPY packages/api-client/package.json packages/api-client/package.json") &&
      instructions.includes("COPY packages/api-client packages/api-client"),
    "the Web image must include its workspace API client dependency"
  );
  assert(
    instructions.includes(
      "COPY vendor/cli/npm/10.9.2/package/node_modules/qrcode-terminal/vendor/QRCode vendor/cli/npm/10.9.2/package/node_modules/qrcode-terminal/vendor/QRCode"
    ),
    "the Web image must include the local-only MFA QR encoder"
  );

  const runtimeStart = instructions.indexOf(fromInstructions[2]);
  const runtimeInstructions = instructions.slice(runtimeStart + 1);
  const requiredRuntimeInstructions = [
    "ARG BUILD_VERSION=dev",
    "ARG BUILD_REVISION=unknown",
    "ARG BUILD_CREATED=1970-01-01T00:00:00Z",
    'LABEL org.opencontainers.image.title="NURITEO Web" \\',
    'org.opencontainers.image.version="${BUILD_VERSION}" \\',
    'org.opencontainers.image.revision="${BUILD_REVISION}" \\',
    'org.opencontainers.image.created="${BUILD_CREATED}" \\',
    'org.opencontainers.image.licenses="Apache-2.0"',
    "WORKDIR /app",
    "ENV NODE_ENV=production",
    "ENV HOSTNAME=0.0.0.0",
    "ENV PORT=3000",
    "ENV NEXT_TELEMETRY_DISABLED=1",
    "COPY --from=builder --chown=65532:65532 /workspace/apps/web/.next/standalone ./",
    "COPY --from=builder --chown=65532:65532 /workspace/apps/web/.next/static ./apps/web/.next/static",
    "COPY --from=builder --chown=65532:65532 /workspace/apps/web/public ./apps/web/public",
    "USER 65532:65532",
    "EXPOSE 3000",
    'ENTRYPOINT ["/nodejs/bin/node", "apps/web/server.js"]'
  ];
  assert.deepEqual(runtimeInstructions, requiredRuntimeInstructions);

  assert(!instructions.some((line) => line.startsWith("ADD ")), "ADD is not allowed");
  assert(
    !instructions.some((line) => /^COPY\s+\.\s/u.test(line)),
    "the repository root must not be copied wholesale"
  );
  assert.doesNotMatch(
    source,
    /(?:ARG|ENV)\s+(?:NEXT_PUBLIC_|NURITEO_INTERNAL_API_URL)/u,
    "internal runtime configuration must not become a build argument or public bundle value"
  );
}

function validateBuildContext() {
  const ignoreRules = fs
    .readFileSync(ignorePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const expectedIgnoreRules = [
    "**",
    "!package.json",
    "!pnpm-lock.yaml",
    "!pnpm-workspace.yaml",
    "!tsconfig.base.json",
    "!apps/",
    "!apps/web/",
    "!apps/web/package.json",
    "!apps/web/next.config.ts",
    "!apps/web/next-env.d.ts",
    "!apps/web/postcss.config.mjs",
    "!apps/web/tsconfig.json",
    "!apps/web/public/",
    "!apps/web/public/**",
    "!apps/web/src/",
    "!apps/web/src/**",
    "!apps/web/tooling/",
    "!apps/web/tooling/**",
    "!packages/workspace-runtime/assets/",
    "!packages/workspace-runtime/assets/preview-sw.js",
    "!packages/workspace-runtime/assets/runtime/",
    "!packages/workspace-runtime/assets/runtime/**",
    "!packages/workspace-runtime/assets/vendor/",
    "!packages/workspace-runtime/assets/vendor/next-cli-15.5.26.mjs",
    "!packages/workspace-runtime/assets/vendor/vite-8.2.0/",
    "!packages/workspace-runtime/assets/vendor/vite-8.2.0/**",
    "!packages/",
    "!packages/api-client/",
    "!packages/api-client/package.json",
    "!packages/api-client/tsconfig.json",
    "!packages/api-client/src/",
    "!packages/api-client/src/**",
    "!packages/browser-host/",
    "!packages/browser-host/**",
    "!packages/node-runtime/",
    "!packages/node-runtime/**",
    "!packages/preview/",
    "!packages/preview/**",
    "!packages/workspace-runtime/",
    "!packages/workspace-runtime/**",
    "!packages/protocol/",
    "!packages/protocol/**",
    "!workers/",
    "!workers/**",
    "!vendor/",
    "!vendor/cli/",
    "!vendor/cli/npm/",
    "!vendor/cli/npm/10.9.2/",
    "!vendor/cli/npm/10.9.2/package/",
    "!vendor/cli/npm/10.9.2/package/node_modules/",
    "!vendor/cli/npm/10.9.2/package/node_modules/qrcode-terminal/",
    "!vendor/cli/npm/10.9.2/package/node_modules/qrcode-terminal/vendor/",
    "!vendor/cli/npm/10.9.2/package/node_modules/qrcode-terminal/vendor/QRCode/",
    "!vendor/cli/npm/10.9.2/package/node_modules/qrcode-terminal/vendor/QRCode/**"
  ];
  assert.deepEqual(ignoreRules, expectedIgnoreRules);

  for (const requiredPath of [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.base.json",
    "apps/web/package.json",
    "apps/web/next.config.ts",
    "apps/web/src",
    "vendor/cli/npm/10.9.2/package/node_modules/qrcode-terminal/vendor/QRCode/index.js",
    "packages/api-client/package.json",
    "packages/api-client/src"
  ]) {
    assert(fs.existsSync(requiredPath), `missing build input: ${requiredPath}`);
  }
  assert(
    !fs.existsSync("apps/web/public") || dockerfile.includes("/workspace/apps/web/public"),
    "a Web public directory must be copied explicitly into the standalone application"
  );
}

function verifyDriftDetection() {
  const mutations = [
    dockerfile.replace("@sha256:d9f850096136edbc402debdd8729579a288aac64574ada0ff4db26b6ae58b0b2", ""),
    dockerfile.replace("/workspace/apps/web/.next/static", "/workspace/apps/web/.next/cache"),
    dockerfile.replace("USER 65532:65532", "USER root"),
    dockerfile.replace(
      'ENTRYPOINT ["/nodejs/bin/node", "apps/web/server.js"]',
      'ENTRYPOINT ["npm", "start"]'
    )
  ];

  for (const [index, mutation] of mutations.entries()) {
    assert.throws(() => validateDockerfile(mutation), `drift mutation ${index + 1} was not rejected`);
  }
}
