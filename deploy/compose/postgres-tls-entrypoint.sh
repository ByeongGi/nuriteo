#!/bin/sh
set -eu

certificate_source=/run/secrets/postgres_server_cert
private_key_source=/run/secrets/postgres_server_key
runtime_directory=/var/lib/postgresql/tls

if [ ! -s "$certificate_source" ] || [ ! -s "$private_key_source" ]; then
  echo "nuriteo-postgres: TLS identity files are required" >&2
  exit 1
fi

install -d -m 0700 -o postgres -g postgres "$runtime_directory"
install -m 0600 -o postgres -g postgres "$certificate_source" "$runtime_directory/server.crt"
install -m 0600 -o postgres -g postgres "$private_key_source" "$runtime_directory/server.key"

exec /usr/local/bin/docker-entrypoint.sh "$@"
