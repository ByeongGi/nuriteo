FROM docker.io/library/node:22.23.0-bookworm-slim@sha256:d9f850096136edbc402debdd8729579a288aac64574ada0ff4db26b6ae58b0b2 AS dependencies

ARG NURITEO_SOURCE_DATE_EPOCH=0
ARG BUILD_REVISION=unknown

WORKDIR /workspace

ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
ENV NEXT_TELEMETRY_DISABLED=1
ENV SOURCE_DATE_EPOCH=${NURITEO_SOURCE_DATE_EPOCH}
ENV NURITEO_BUILD_REVISION=${BUILD_REVISION}

RUN corepack enable && corepack prepare pnpm@11.15.1 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/api-client/package.json packages/api-client/package.json
COPY packages/browser-host/package.json packages/browser-host/package.json
COPY packages/node-runtime/package.json packages/node-runtime/package.json
COPY packages/preview/package.json packages/preview/package.json
COPY packages/workspace-runtime/package.json packages/workspace-runtime/package.json
COPY packages/protocol/package.json packages/protocol/package.json

RUN pnpm install --frozen-lockfile --filter @nuriteo/web...

FROM dependencies AS builder

COPY apps/web apps/web
COPY packages/api-client packages/api-client
COPY packages/browser-host packages/browser-host
COPY packages/node-runtime packages/node-runtime
COPY packages/preview packages/preview
COPY packages/workspace-runtime packages/workspace-runtime
COPY packages/protocol packages/protocol
COPY workers workers
COPY vendor/cli/npm/10.9.2/package/node_modules/qrcode-terminal/vendor/QRCode vendor/cli/npm/10.9.2/package/node_modules/qrcode-terminal/vendor/QRCode
COPY packages/workspace-runtime/assets/preview-sw.js packages/workspace-runtime/assets/preview-sw.js
COPY packages/workspace-runtime/assets/runtime packages/workspace-runtime/assets/runtime
COPY packages/workspace-runtime/assets/vendor/next-cli-15.5.26.mjs packages/workspace-runtime/assets/vendor/next-cli-15.5.26.mjs
COPY packages/workspace-runtime/assets/vendor/vite-8.2.0 packages/workspace-runtime/assets/vendor/vite-8.2.0

RUN pnpm --filter @nuriteo/web build \
    && find apps/web/.next -exec touch -h -d "@${SOURCE_DATE_EPOCH}" {} +

FROM gcr.io/distroless/nodejs22-debian13:nonroot@sha256:ec2313763dd43931543bd03830466e0c409ce73a487e8d46f10db72d3b816c1c AS runtime

ARG BUILD_VERSION=dev
ARG BUILD_REVISION=unknown
ARG BUILD_CREATED=1970-01-01T00:00:00Z

LABEL org.opencontainers.image.title="NURITEO Web" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.revision="${BUILD_REVISION}" \
      org.opencontainers.image.created="${BUILD_CREATED}" \
      org.opencontainers.image.licenses="Apache-2.0"

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
