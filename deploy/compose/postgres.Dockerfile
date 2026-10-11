FROM docker.io/library/postgres@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3

COPY --chmod=0755 deploy/compose/postgres-tls-entrypoint.sh /usr/local/bin/nuriteo-postgres-entrypoint

ENTRYPOINT ["/usr/local/bin/nuriteo-postgres-entrypoint"]
CMD ["postgres"]
