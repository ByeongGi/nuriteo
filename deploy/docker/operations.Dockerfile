FROM docker.io/library/rust:1.97.1-slim-bookworm@sha256:2775a09d208ff0d7c1f50490c45b62db929e87ba1dcbc3f2132ac71a704bcdd3 AS builder

ARG NURITEO_SOURCE_DATE_EPOCH=0
ENV SOURCE_DATE_EPOCH=${NURITEO_SOURCE_DATE_EPOCH}
ENV CARGO_INCREMENTAL=0

RUN apt-get update \
    && apt-get install --yes --no-install-recommends build-essential cmake perl pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
ENV CARGO_BUILD_JOBS=1

COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY compat ./compat

RUN cargo build --locked --release --package nuriteo-server --bin nuriteo-server

FROM docker.io/library/postgres@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3 AS postgres-client

# Copy only the backup/restore clients and their resolved runtime libraries.
# The PostgreSQL server, package manager, shell and privilege helper never
# enter the final image.
RUN set -eu; \
    root=/runtime-root; \
    mkdir -p "$root/usr/bin"; \
    cp /usr/lib/postgresql/17/bin/pg_dump "$root/usr/bin/pg_dump"; \
    cp /usr/lib/postgresql/17/bin/pg_restore "$root/usr/bin/pg_restore"; \
    { \
      ldd /usr/lib/postgresql/17/bin/pg_dump; \
      ldd /usr/lib/postgresql/17/bin/pg_restore; \
    } | awk '$2 == "=>" && $3 ~ /^\// { print $3 } $1 ~ /^\// { print $1 }' \
      | sort -u \
      | while IFS= read -r library; do \
          resolved="$(readlink -f "$library")"; \
          destination="$root$(dirname "$resolved")"; \
          mkdir -p "$destination"; \
          cp -L "$library" "$destination/$(basename "$library")"; \
        done

# The operations image is deliberately separate from the online server image.
# It supplies the pinned pg_dump/pg_restore toolchain required by short-lived
# backup and restore Jobs without inheriting a PostgreSQL server runtime.
FROM gcr.io/distroless/cc-debian13:nonroot@sha256:e792ab3d241a468a4fd7519ddbbebe66b49b5f365771716ea688ad40b6c6f1c2 AS runtime

ARG BUILD_VERSION=dev
ARG BUILD_REVISION=unknown
ARG BUILD_CREATED=1970-01-01T00:00:00Z

LABEL org.opencontainers.image.title="NURITEO Operations" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.revision="${BUILD_REVISION}" \
      org.opencontainers.image.created="${BUILD_CREATED}" \
      org.opencontainers.image.licenses="Apache-2.0"

COPY --from=builder /build/target/release/nuriteo-server /usr/local/bin/nuriteo-server
COPY --from=postgres-client /runtime-root /

USER 65532:65532
ENTRYPOINT ["/usr/local/bin/nuriteo-server"]
