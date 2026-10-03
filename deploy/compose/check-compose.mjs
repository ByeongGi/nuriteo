import assert from "node:assert/strict";
import fs from "node:fs";

const composePath = "deploy/compose/compose.yaml";
const compose = fs.readFileSync(composePath, "utf8");

validate(compose);
verifyDriftDetection();

console.log(
  "compose topology contract ok (Web-only publish, internal data plane, file secrets, persistent volumes)"
);

function validate(source) {
  const postgres = serviceBlock(source, "postgres");
  const rustfs = serviceBlock(source, "rustfs");
  const core = serviceBlock(source, "core");
  const web = serviceBlock(source, "web");

  assert.match(
    postgres,
    /image: docker\.io\/library\/postgres@sha256:f3bd19c606e442c3d7bdfa8002e03fe260a1023351e0ea4598032022b68dd6e3/u
  );
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
    compose.replace("docker.io/library/postgres@sha256:", "docker.io/library/postgres:"),
    compose.replace("rustfs_data:/data", "postgres_data:/data"),
    compose.replace("  data:\n    internal: true", "  data:")
  ];
  for (const [index, mutation] of mutations.entries()) {
    assert.throws(() => validate(mutation), `compose drift mutation ${index + 1} was not rejected`);
  }
}
