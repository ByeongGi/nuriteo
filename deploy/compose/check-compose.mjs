import assert from "node:assert/strict";
import fs from "node:fs";

const composePath = "deploy/compose/compose.yaml";
const compose = fs.readFileSync(composePath, "utf8");
const postgresDockerfile = fs.readFileSync("deploy/compose/postgres.Dockerfile", "utf8");
const postgresEntrypoint = fs.readFileSync(
  "deploy/compose/postgres-tls-entrypoint.sh",
  "utf8"
);
const postgresDockerignore = fs.readFileSync(
  "deploy/compose/postgres.Dockerfile.dockerignore",
  "utf8"
);

validate(compose, postgresDockerfile, postgresEntrypoint);
verifyDriftDetection();

console.log(
  "compose topology contract ok (Web-only publish, internal data plane, file secrets, persistent volumes)"
);

function validate(source, dockerfile = postgresDockerfile, entrypoint = postgresEntrypoint) {
  const postgres = serviceBlock(source, "postgres");
  const rustfs = serviceBlock(source, "rustfs");
  const core = serviceBlock(source, "core");
  const web = serviceBlock(source, "web");

  assert.match(postgres, /image: \$\{NURITEO_POSTGRES_IMAGE:-localhost\/nuriteo-postgres:cmp-001\}/u);
  assert.match(postgres, /dockerfile: deploy\/compose\/postgres\.Dockerfile/u);
  assert.match(
    dockerfile,
    /^FROM docker\.io\/library\/postgres@sha256:f3bd19c606e442c3d7bdfa8002e03fe260a1023351e0ea4598032022b68dd6e3$/mu
  );
  assert.match(dockerfile, /ENTRYPOINT \["\/usr\/local\/bin\/nuriteo-postgres-entrypoint"\]/u);
  assert.equal(
    postgresDockerignore,
    "**\n!deploy/\n!deploy/compose/\n!deploy/compose/postgres-tls-entrypoint.sh\n"
  );
  for (const argument of [
    "ssl=on",
    "ssl_cert_file=/var/lib/postgresql/tls/server.crt",
    "ssl_key_file=/var/lib/postgresql/tls/server.key"
  ]) {
    assert(postgres.includes(`      - ${argument}`), `missing PostgreSQL TLS argument: ${argument}`);
  }
  assert.match(entrypoint, /install -d -m 0700 -o postgres -g postgres/u);
  assert.match(entrypoint, /install -m 0600 -o postgres -g postgres/u);
  assert.match(entrypoint, /exec \/usr\/local\/bin\/docker-entrypoint\.sh "\$@"/u);
  assert.match(
    rustfs,
    /image: docker\.io\/rustfs\/rustfs@sha256:42edb61d588775f9431ff436216d14392d2234d4eb2ed68321569fbf7245b36b/u
  );
  assert.match(core, /dockerfile: deploy\/docker\/server\.Dockerfile/u);
  assert.match(web, /dockerfile: deploy\/docker\/web\.Dockerfile/u);

  assert.doesNotMatch(postgres, /^    ports:/mu);
  assert.doesNotMatch(rustfs, /^    ports:/mu);
  assert.doesNotMatch(core, /^    ports:/mu);
  assert.match(web, /^    ports:\n      - .*:3000$/mu);
  assert.match(web, /NURITEO_INTERNAL_API_URL: http:\/\/core:8080/u);

  assert.match(postgres, /postgres_data:\/var\/lib\/postgresql\/data/u);
  assert.match(rustfs, /rustfs_data:\/data/u);
  assert.match(postgres, /^      - data$/mu);
  assert.match(rustfs, /^      - data$/mu);
  assert.match(core, /^      - application\n      - data$/mu);
  assert.match(web, /^      - application$/mu);
  assert.match(source, /^  data:\n    internal: true$/mu);

  for (const [name, block] of [
    ["core", core],
    ["web", web]
  ]) {
    assert.match(block, /^    read_only: true$/mu, `${name} must use a read-only root filesystem`);
    assert.match(block, /^    user: "65532:65532"$/mu, `${name} must pin its numeric identity`);
    assert.match(block, /^    cap_drop:\n      - ALL$/mu, `${name} must drop all capabilities`);
    assert.match(
      block,
      /^    security_opt:\n      - no-new-privileges:true$/mu,
      `${name} must disable privilege escalation`
    );
  }

  for (const contract of [
    "POSTGRES_PASSWORD_FILE: /run/secrets/postgres_password",
    "RUSTFS_ACCESS_KEY_FILE: /run/secrets/rustfs_access_key",
    "RUSTFS_SECRET_KEY_FILE: /run/secrets/rustfs_secret_key",
    "NURITEO_DATABASE_URL_FILE: /run/secrets/database_url",
    "NURITEO_DATABASE_CA_FILE: /run/secrets/database_ca",
    "NURITEO_S3_ACCESS_KEY_ID_FILE: /run/secrets/rustfs_access_key",
    "NURITEO_S3_SECRET_ACCESS_KEY_FILE: /run/secrets/rustfs_secret_key"
  ]) {
    assert(source.includes(contract), `missing file-secret contract: ${contract}`);
  }
  for (const secret of ["postgres_server_cert", "postgres_server_key"]) {
    assert(postgres.includes(`      - ${secret}`), `missing PostgreSQL TLS secret: ${secret}`);
    assert.match(source, new RegExp(`^  ${secret}:\\n    file: \\u0024\\{NURITEO_`, "mu"));
  }
  assert.doesNotMatch(
    source,
    /^\s+(?:POSTGRES_PASSWORD|RUSTFS_ACCESS_KEY|RUSTFS_SECRET_KEY|NURITEO_DATABASE_URL|NURITEO_S3_ACCESS_KEY_ID|NURITEO_S3_SECRET_ACCESS_KEY):/mu,
    "credential values must not be stored in Compose environment entries"
  );

  assert.match(source, /^  postgres_data:$/mu);
  assert.match(source, /^  rustfs_data:$/mu);
  assert.doesNotMatch(source, /^\s+depends_on:/mu, "CMP-002 owns startup ordering");
  assert.doesNotMatch(source, /^\s+healthcheck:/mu, "CMP-002 owns health probe wiring");
  assert.match(source, /live: http:\/\/127\.0\.0\.1:8080\/health\/live/u);
  assert.match(source, /ready: http:\/\/127\.0\.0\.1:8080\/health\/ready/u);
  assert.match(
    source,
    /command: \["\/usr\/local\/bin\/nuriteo-server", "healthcheck"\]/u
  );
}

function serviceBlock(source, name) {
  const services = source.slice(source.indexOf("\nservices:\n") + "\nservices:\n".length);
  const match = new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9_-]*:\\n|^networks:|^volumes:|^secrets:)`, "mu").exec(
    services
  );
  assert(match, `missing service: ${name}`);
  return `  ${name}:\n${match[1]}`;
}

function verifyDriftDetection() {
  const mutations = [
    compose.replace("    environment:\n      POSTGRES_DB", "    ports:\n      - 5432:5432\n    environment:\n      POSTGRES_DB"),
    compose.replace(
      "      RUSTFS_ACCESS_KEY_FILE: /run/secrets/rustfs_access_key",
      "      RUSTFS_ACCESS_KEY: unsafe-default"
    ),
    compose.replace(
      "      NURITEO_DATABASE_CA_FILE: /run/secrets/database_ca",
      "      NURITEO_DATABASE_TLS_MODE: disable"
    ),
    postgresDockerfile.replace("docker.io/library/postgres@sha256:", "docker.io/library/postgres:"),
    compose.replace("rustfs_data:/data", "postgres_data:/data"),
    compose.replace("  data:\n    internal: true", "  data:")
  ];
  for (const [index, mutation] of mutations.entries()) {
    const isDockerfileMutation = index === 3;
    assert.throws(
      () => validate(isDockerfileMutation ? compose : mutation, isDockerfileMutation ? mutation : postgresDockerfile),
      `compose drift mutation ${index + 1} was not rejected`
    );
  }
}
