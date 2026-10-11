FROM docker.io/library/postgres@sha256:3645570cccdfa447589da9f57dd740faa29b30938e861289a5574b6ca6b03826

COPY --chmod=0755 deploy/compose/postgres-tls-entrypoint.sh /usr/local/bin/nuriteo-postgres-entrypoint

ENTRYPOINT ["/usr/local/bin/nuriteo-postgres-entrypoint"]
CMD ["postgres"]
