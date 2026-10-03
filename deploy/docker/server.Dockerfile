FROM docker.io/library/rust:1.97.1-slim-bookworm@sha256:2775a09d208ff0d7c1f50490c45b62db929e87ba1dcbc3f2132ac71a704bcdd3 AS builder

WORKDIR /build

COPY Cargo.toml Cargo.lock ./
COPY crates ./crates

RUN cargo build --locked --release --package nuriteo-server --bin nuriteo-server

FROM gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f AS runtime

COPY --from=builder /build/target/release/nuriteo-server /usr/local/bin/nuriteo-server

USER 65532:65532
ENTRYPOINT ["/usr/local/bin/nuriteo-server"]
