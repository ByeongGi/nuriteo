FROM docker.io/library/rust:1.97.1-slim-bookworm@sha256:2775a09d208ff0d7c1f50490c45b62db929e87ba1dcbc3f2132ac71a704bcdd3 AS build

RUN apt-get update \
    && apt-get install --yes --no-install-recommends build-essential cmake perl pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /source
ENV CARGO_BUILD_JOBS=1
COPY Cargo.toml Cargo.toml
COPY crates crates
COPY compat compat
COPY deploy/compose/beta-gate/stages/git-registry/harness deploy/compose/beta-gate/stages/git-registry/harness
RUN cargo build --release --locked \
    --manifest-path deploy/compose/beta-gate/stages/git-registry/harness/Cargo.toml

FROM docker.io/library/rust:1.97.1-slim-bookworm@sha256:2775a09d208ff0d7c1f50490c45b62db929e87ba1dcbc3f2132ac71a704bcdd3
COPY --from=build /source/deploy/compose/beta-gate/stages/git-registry/harness/target/release/nuriteo-gate-git-registry /usr/local/bin/nuriteo-gate-git-registry
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/nuriteo-gate-git-registry"]
