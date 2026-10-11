FROM docker.io/library/rust:1.97.1-slim-bookworm@sha256:2775a09d208ff0d7c1f50490c45b62db929e87ba1dcbc3f2132ac71a704bcdd3 AS builder

RUN apt-get update \
    && apt-get install --yes --no-install-recommends build-essential cmake perl pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
ENV CARGO_BUILD_JOBS=1

COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY compat ./compat

RUN cargo build --locked --release --package nuriteo-server --bin nuriteo-server

# The operations image is deliberately separate from the distroless online
# server image. It supplies the pinned pg_dump/pg_restore toolchain required by
# short-lived backup and restore Jobs without expanding the online image.
FROM docker.io/library/postgres@sha256:3645570cccdfa447589da9f57dd740faa29b30938e861289a5574b6ca6b03826 AS runtime

COPY --from=builder /build/target/release/nuriteo-server /usr/local/bin/nuriteo-server

USER 65532:65532
ENTRYPOINT ["/usr/local/bin/nuriteo-server"]
