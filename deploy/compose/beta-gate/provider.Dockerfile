FROM docker.io/library/rust:1.97.1-slim-bookworm@sha256:2775a09d208ff0d7c1f50490c45b62db929e87ba1dcbc3f2132ac71a704bcdd3

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git openssl python3 \
    && rm -rf /var/lib/apt/lists/*
