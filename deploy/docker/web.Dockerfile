FROM docker.io/library/node:22.23.0-bookworm-slim@sha256:d9f850096136edbc402debdd8729579a288aac64574ada0ff4db26b6ae58b0b2 AS dependencies

WORKDIR /workspace

ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
ENV NEXT_TELEMETRY_DISABLED=1

RUN corepack enable && corepack prepare pnpm@11.15.1 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/api-client/package.json packages/api-client/package.json
COPY packages/browser-host/package.json packages/browser-host/package.json
COPY packages/node-runtime/package.json packages/node-runtime/package.json
COPY packages/preview/package.json packages/preview/package.json
COPY packages/preview-service/package.json packages/preview-service/package.json
COPY packages/protocol/package.json packages/protocol/package.json

RUN pnpm install --frozen-lockfile --filter @nuriteo/web...

FROM dependencies AS builder

COPY apps/web apps/web
COPY packages/api-client packages/api-client
COPY packages/browser-host packages/browser-host
COPY packages/node-runtime packages/node-runtime
COPY packages/preview packages/preview
COPY packages/preview-service packages/preview-service
COPY packages/protocol packages/protocol
COPY workers workers
COPY apps/preview-service/public/preview-sw.js apps/preview-service/public/preview-sw.js
COPY apps/preview-service/public/runtime apps/preview-service/public/runtime
COPY apps/preview-service/public/vendor/next-cli-15.5.26.mjs apps/preview-service/public/vendor/next-cli-15.5.26.mjs
COPY apps/preview-service/public/vendor/vite-8.2.0 apps/preview-service/public/vendor/vite-8.2.0

RUN pnpm --filter @nuriteo/web build

FROM gcr.io/distroless/nodejs22-debian12:nonroot@sha256:13593b7570658e8477de39e2f4a1dd25db2f836d68a0ba771251572d23bb4f8e AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=builder --chown=65532:65532 /workspace/apps/web/.next/standalone ./
COPY --from=builder --chown=65532:65532 /workspace/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=65532:65532 /workspace/apps/web/public ./apps/web/public

USER 65532:65532
EXPOSE 3000
ENTRYPOINT ["/nodejs/bin/node", "apps/web/server.js"]
