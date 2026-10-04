import assert from "node:assert/strict";
import fs from "node:fs";

const compose = fs.readFileSync("deploy/compose/compose.yaml", "utf8");
const external = fs.readFileSync("deploy/compose/compose.external-s3.yaml", "utf8");
const init = fs.readFileSync("deploy/compose/rustfs-init.sh", "utf8");
const postgresDockerfile = fs.readFileSync("deploy/compose/postgres.Dockerfile", "utf8");
const postgresEntrypoint = fs.readFileSync("deploy/compose/postgres-tls-entrypoint.sh", "utf8");
const acceptance = fs.readFileSync("deploy/compose/test-compose.sh", "utf8");

validate(compose, external, init, acceptance);
verifyDriftDetection();
console.log("compose clean-install contract ok (ordered one-shots, private persistence, external preflight only)");

function validate(source, externalSource, initSource, acceptanceSource) {
  const services = Object.fromEntries(
    ["postgres", "rustfs", "storage-init", "storage-check", "migrate", "bootstrap-admin", "core", "web"]
      .map((name) => [name, serviceBlock(source, name)])
  );

  assert.match(postgresDockerfile, /^FROM docker\.io\/library\/postgres@sha256:/mu);
  assert.match(postgresEntrypoint, /exec \/usr\/local\/bin\/docker-entrypoint\.sh "\$@"/u);
  assert.match(services.postgres, /pg_isready --username nuriteo --dbname nuriteo/u);
  assert.match(services.rustfs, /https:\/\/rustfs:9000\/health/u);
  for (const name of ["postgres", "rustfs", "core"]) {
    assert.match(services[name], /^    healthcheck:$/mu, `${name} must have a real healthcheck`);
  }

  assert.match(services["storage-init"], /condition: service_healthy/u);
  assert.match(services["storage-check"], /condition: service_completed_successfully/u);
  assert.match(services.migrate, /condition: service_healthy/u);
  assert.match(services["bootstrap-admin"], /condition: service_completed_successfully/u);
  assert.match(services.core, /bootstrap-admin:[\s\S]*condition: service_completed_successfully/u);
  assert.match(services.core, /storage-check:[\s\S]*condition: service_completed_successfully/u);
  assert.match(services.web, /core:[\s\S]*condition: service_healthy/u);
  assert.match(services.web, /NURITEO_EXTERNAL_URL: \$\{NURITEO_EXTERNAL_URL:\?set NURITEO_EXTERNAL_URL\}/u);
  assert.match(services.web, /NURITEO_PREVIEW_BASE_DOMAIN: \$\{NURITEO_PREVIEW_BASE_DOMAIN:\?set NURITEO_PREVIEW_BASE_DOMAIN\}/u);
  assert.match(services.web, /NURITEO_PREVIEW_SIGNING_KEY_FILE: \/run\/secrets\/preview_signing_key/u);
  assert.match(services.web, /secrets:\n      - preview_signing_key/u);
  assert.match(services.web, /NURITEO_PREVIEW_WILDCARD_READY: \$\{NURITEO_PREVIEW_WILDCARD_READY:-false\}/u);
  assert.match(acceptanceSource, /openssl rand -base64 32[\s\S]*preview-signing-key/u);
  assert.match(acceptanceSource, /chmod 600 "\$fixture_root\/preview-signing-key"/u);
  assert.match(acceptanceSource, /export NURITEO_PREVIEW_BASE_DOMAIN='preview\.localhost'/u);
  assert.match(acceptanceSource, /export NURITEO_PREVIEW_SIGNING_KEY_FILE="\$fixture_root\/preview-signing-key"/u);

  for (const [name, command] of [["storage-check", "storage-check"], ["migrate", "migrate"], ["bootstrap-admin", "bootstrap-admin"], ["core", "serve"]]) {
    assert.match(services[name], /image: \$\{NURITEO_SERVER_IMAGE:-localhost\/nuriteo-server:cmp-002\}/u);
    assert.match(services[name], new RegExp(`command: \\["${command}"\\]`, "u"));
  }
  assert.match(services["bootstrap-admin"], /NURITEO_BOOTSTRAP_ADMIN_PASSWORD_FILE: \/run\/secrets\/bootstrap_admin_password/u);
  assert.doesNotMatch(services["bootstrap-admin"], /PASSWORD(?!_FILE):/u);
  assert.doesNotMatch(services["bootstrap-admin"], /command:.*password/iu);

  for (const name of ["storage-init", "storage-check", "migrate", "bootstrap-admin"]) {
    assert.match(services[name], /^    restart: "no"$/mu, `${name} must be a one-shot`);
  }
  for (const name of ["storage-check", "migrate", "bootstrap-admin", "core", "web"]) {
    assert.match(services[name], /^    read_only: true$/mu);
    assert.match(services[name], /^    user: "65532:65532"$/mu);
    assert.match(services[name], /^    cap_drop:\n      - ALL$/mu);
  }

  assert.doesNotMatch(services.postgres, /^    ports:/mu);
  assert.doesNotMatch(services.rustfs, /^    ports:/mu);
  assert.doesNotMatch(services.core, /^    ports:/mu);
  assert.match(services.web, /^    ports:\n      - .*:3000$/mu);
  assert.match(source, /^  data:\n    internal: true$/mu);
  assert.match(source, /^  postgres_data:$/mu);
  assert.match(source, /^  rustfs_data:$/mu);

  for (const literal of [
    "POSTGRES_PASSWORD_FILE: /run/secrets/postgres_password",
    "NURITEO_DATABASE_URL_FILE: /run/secrets/database_url",
    "NURITEO_S3_ACCESS_KEY_ID_FILE: /run/secrets/rustfs_access_key",
    "NURITEO_BOOTSTRAP_ADMIN_PASSWORD_FILE: /run/secrets/bootstrap_admin_password"
  ]) assert(source.includes(literal), `missing file-secret contract: ${literal}`);
  assert.doesNotMatch(source, /^\s+(?:POSTGRES_PASSWORD|NURITEO_DATABASE_URL|NURITEO_BOOTSTRAP_ADMIN_PASSWORD|NURITEO_S3_ACCESS_KEY_ID|NURITEO_S3_SECRET_ACCESS_KEY):/mu);

  assert.match(initSource, /--request PUT "\$endpoint"/u);
  assert.match(initSource, /BucketAlreadyOwnedByYou/u);
  assert.match(initSource, /--head "\$endpoint"/u);
  assert.match(initSource, /--request PUT --data-binary "@\$cors_file" "\$endpoint\?cors"/u);
  for (const literal of [
    "nuriteo-browser-upload-v1",
    "<AllowedMethod>PUT</AllowedMethod>",
    "<AllowedHeader>content-type</AllowedHeader>",
    "<AllowedHeader>x-amz-checksum-sha256</AllowedHeader>",
    "<AllowedHeader>x-amz-sdk-checksum-algorithm</AllowedHeader>",
    "<ExposeHeader>etag</ExposeHeader>",
    "<ExposeHeader>x-amz-checksum-sha256</ExposeHeader>"
  ]) assert(initSource.includes(literal), `missing bundled browser CORS contract: ${literal}`);
  assert.doesNotMatch(initSource, /<AllowedOrigin>\*<\/AllowedOrigin>|<AllowedHeader>\*<\/AllowedHeader>/u);
  assert.doesNotMatch(initSource, /--request (?:DELETE|POST|PATCH)/u);

  const externalConfigure = serviceBlock(externalSource, "storage-configure-browser-upload-cors");
  assert.match(externalConfigure, /command: \["storage-configure-browser-upload-cors"\]/u);
  assert.match(externalConfigure, /profiles: \["configure-browser-upload-cors"\]/u);
  const externalCheck = serviceBlock(externalSource, "storage-check");
  assert.match(externalCheck, /command: \["storage-check"\]/u);
  assert.match(externalCheck, /NURITEO_S3_BUCKET: \$\{NURITEO_S3_BUCKET:\?set NURITEO_S3_BUCKET\}/u);
  assert.match(externalCheck, /NURITEO_S3_ACCESS_KEY_ID_FILE: \/run\/secrets\/s3_access_key/u);
  assert.doesNotMatch(externalSource, /storage-init|rustfs|migrate|bootstrap-admin|command:.*(?:create|delete)/iu);

  const startStack = shellFunction(acceptanceSource, "start_stack");
  const oneShotGate = 'for job in storage-init storage-check migrate bootstrap-admin; do';
  const oneShotCheck = 'wait_for_job "$job" 0';
  assert.match(startStack, new RegExp(oneShotGate, "u"));
  assert.match(startStack, /wait_for_job "\$job" 0/u);
  assert.ok(
    startStack.indexOf(oneShotGate) < startStack.indexOf(oneShotCheck) &&
      startStack.indexOf(oneShotCheck) < startStack.indexOf('core_container="$(service_container'),
    "the Podman Web compatibility path must verify every one-shot before Core health"
  );
  assert.ok(
    startStack.indexOf('core_container="$(service_container') < startStack.indexOf("run --no-deps"),
    "the Podman Web compatibility path must verify Core before bypassing dependency traversal"
  );
}

function shellFunction(source, name) {
  const match = new RegExp(`^${name}\\(\\) \\{\\n([\\s\\S]*?)^\\}`, "mu").exec(source);
  assert(match, `missing shell function: ${name}`);
  return match[0];
}

function serviceBlock(source, name) {
  const servicesStart = source.indexOf("services:\n");
  assert.notEqual(servicesStart, -1, "missing services section");
  const services = source.slice(servicesStart + "services:\n".length);
  const match = new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9_-]*:\\n|^networks:|^volumes:|^secrets:)`, "mu").exec(services);
  assert(match, `missing service: ${name}`);
  return `  ${name}:\n${match[1]}`;
}

function verifyDriftDetection() {
  const mutations = [
    [compose.replace("condition: service_completed_successfully", "condition: service_started"), external, init, acceptance],
    [compose.replace('command: ["migrate"]', 'command: ["serve"]'), external, init, acceptance],
    [compose.replace("NURITEO_BOOTSTRAP_ADMIN_PASSWORD_FILE", "NURITEO_BOOTSTRAP_ADMIN_PASSWORD"), external, init, acceptance],
    [compose.replace("  data:\n    internal: true", "  data:"), external, init, acceptance],
    [compose.replace("NURITEO_PREVIEW_WILDCARD_READY:-false", "NURITEO_PREVIEW_WILDCARD_READY:-true"), external, init, acceptance],
    [compose.replace("NURITEO_PREVIEW_SIGNING_KEY_FILE: /run/secrets/preview_signing_key", "NURITEO_PREVIEW_SIGNING_KEY: public"), external, init, acceptance],
    [compose, external.replace('command: ["storage-check"]', 'command: ["storage-init"]'), init, acceptance],
    [compose, external, init.replace("--head", "--request DELETE"), acceptance],
    [compose, external, init, acceptance.replace("wait_for_job \"$job\" 0", ":")]
  ];
  for (const [index, args] of mutations.entries()) {
    assert.throws(() => validate(...args), `compose drift mutation ${index + 1} was not rejected`);
  }
}
