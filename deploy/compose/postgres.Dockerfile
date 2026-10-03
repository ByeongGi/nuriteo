FROM docker.io/library/postgres@sha256:f3bd19c606e442c3d7bdfa8002e03fe260a1023351e0ea4598032022b68dd6e3

COPY --chmod=0755 deploy/compose/postgres-tls-entrypoint.sh /usr/local/bin/nuriteo-postgres-entrypoint

ENTRYPOINT ["/usr/local/bin/nuriteo-postgres-entrypoint"]
CMD ["postgres"]
