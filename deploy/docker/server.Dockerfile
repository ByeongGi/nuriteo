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

FROM gcr.io/distroless/cc-debian13:nonroot@sha256:e792ab3d241a468a4fd7519ddbbebe66b49b5f365771716ea688ad40b6c6f1c2 AS runtime

ARG BUILD_VERSION=dev
ARG BUILD_REVISION=unknown
ARG BUILD_CREATED=1970-01-01T00:00:00Z

LABEL org.opencontainers.image.title="NURITEO Server" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.revision="${BUILD_REVISION}" \
      org.opencontainers.image.created="${BUILD_CREATED}" \
      org.opencontainers.image.licenses="Apache-2.0"

COPY --from=builder /build/target/release/nuriteo-server /usr/local/bin/nuriteo-server

USER 65532:65532
ENTRYPOINT ["/usr/local/bin/nuriteo-server"]
