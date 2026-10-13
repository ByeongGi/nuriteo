import assert from "node:assert/strict";
import fs from "node:fs";

const compose = fs.readFileSync("deploy/compose/compose.yaml", "utf8");
const external = fs.readFileSync("deploy/compose/compose.external-s3.yaml", "utf8");
const init = fs.readFileSync("deploy/compose/rustfs-init.sh", "utf8");
const postgresDockerfile = fs.readFileSync("deploy/compose/postgres.Dockerfile", "utf8");
const postgresEntrypoint = fs.readFileSync("deploy/compose/postgres-tls-entrypoint.sh", "utf8");
const acceptance = fs.readFileSync("deploy/compose/test-compose.sh", "utf8");
const browserAcceptance = fs.readFileSync("deploy/compose/relay-save-resume-browser.ts", "utf8");

validate(compose, external, init, acceptance, browserAcceptance);
verifyDriftDetection();
console.log("compose relay contract ok (private bundled storage, direct external preflight, ordered one-shots)");

function validate(
  source,
  externalSource,
  initSource,
  acceptanceSource,
  browserAcceptanceSource = browserAcceptance
) {
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
  assert.match(services.core, /NURITEO_SAVE_IDEMPOTENCY_SECRET_FILE: \/run\/secrets\/save_idempotency_secret/u);
  assert.match(services.core, /NURITEO_MASTER_KEY_FILE: \/run\/secrets\/master_key/u);
  assert.match(services.core, /NURITEO_PREVIEW_SIGNING_KEY_FILE: \/run\/secrets\/preview_signing_key/u);
  assert.match(services.core, /NURITEO_MASTER_KEY_VERSION: \$\{NURITEO_MASTER_KEY_VERSION:-1\}/u);
  assert.match(services.core, /NURITEO_SAVE_DEFAULT_QUOTA_BYTES: \$\{NURITEO_SAVE_DEFAULT_QUOTA_BYTES:-10737418240\}/u);
  assert.match(services.core, /^      NURITEO_SAVE_UPLOAD_TRANSPORT: relay$/mu);
  assert.match(services["storage-check"], /^      NURITEO_SAVE_UPLOAD_TRANSPORT: relay$/mu);
  assert.match(services["storage-init"], /NURITEO_LEGACY_BROWSER_CORS_ORIGIN: \$\{NURITEO_EXTERNAL_URL:\?set NURITEO_EXTERNAL_URL\}/u);
  assert.doesNotMatch(services["storage-init"], /^      NURITEO_EXTERNAL_URL:|NURITEO_SAVE_UPLOAD_TRANSPORT/mu);
  assert.match(services.core, /secrets:[\s\S]*- save_idempotency_secret/u);
  assert.match(services.core, /secrets:[\s\S]*- master_key/u);
  assert.match(services.core, /secrets:[\s\S]*- preview_signing_key/u);
  assert.match(acceptanceSource, /openssl rand -base64 32[\s\S]*preview-signing-key/u);
  assert.match(acceptanceSource, /chmod 644 "\$fixture_root\/preview-signing-key"/u);
  assert.match(acceptanceSource, /export NURITEO_PREVIEW_BASE_DOMAIN='preview\.localhost'/u);
  assert.match(acceptanceSource, /export NURITEO_PREVIEW_SIGNING_KEY_FILE="\$fixture_root\/preview-signing-key"/u);
  assert.match(acceptanceSource, /openssl rand -base64 32 >"\$fixture_root\/save-idempotency-secret"/u);
  assert.match(acceptanceSource, /chmod 644 "\$fixture_root\/save-idempotency-secret"/u);
  assert.match(acceptanceSource, /export NURITEO_SAVE_IDEMPOTENCY_SECRET_FILE="\$fixture_root\/save-idempotency-secret"/u);
  assert.match(acceptanceSource, /openssl rand -base64 32 >"\$fixture_root\/master-key"/u);
  assert.match(acceptanceSource, /chmod 644 "\$fixture_root\/master-key"/u);
  assert.match(acceptanceSource, /export NURITEO_MASTER_KEY_FILE="\$fixture_root\/master-key"/u);
  assert.match(acceptanceSource, /export NURITEO_MASTER_KEY_VERSION=1/u);
  assert.match(acceptanceSource, /chmod 644 "\$fixture_root\/rustfs-tls\/rustfs_key\.pem"/u);
  assert.match(acceptanceSource, /install_exact_legacy_cors/u);
  assert.match(acceptanceSource, /install_drifted_legacy_cors/u);
  assert.match(acceptanceSource, /wait_for_job storage-init 1/u);
  assert.match(acceptanceSource, /storage-init failed \(legacy-cors-drift\)/u);
  assert.match(acceptanceSource, /cmp "\$fixture_root\/drift-cors-before\.xml" "\$fixture_root\/drift-cors-after\.xml"/u);
  assert.match(acceptanceSource, /for service in core web; do assert_service_not_running "\$project" "\$service" \|\| exit \$\?; done/u);
  assert.doesNotMatch(acceptanceSource, /compose ps --status running --services/u);
  assert.match(
    acceptanceSource,
    /if \[ "\$engine" = podman \]; then[\s\S]*failure_compose up --detach --no-build bootstrap-admin \|\| true[\s\S]*else\s+failure_compose up --detach --no-build \|\| true/u
  );
  assert.match(acceptanceSource, /for service in core web; do assert_service_not_running "\$failure_project" "\$service" \|\| exit \$\?; done/u);
  assert.match(acceptanceSource, /grep -q '<title>NURITEO<\/title>' "\$fixture_root\/web\.html"/u);
  assert.match(browserAcceptanceSource, /Issue invitation/u);
  assert.match(browserAcceptanceSource, /Activate account/u);
  assert.match(browserAcceptanceSource, /Issue Organization invitation/u);
  assert.match(browserAcceptanceSource, /Accept invitation/u);
  assert.match(browserAcceptanceSource, /CMP 003 Organization Organization Workspace/u);
  const projectGrantJourney = browserAcceptanceSource.slice(
    browserAcceptanceSource.indexOf('journeyStage = "project-grant";'),
    browserAcceptanceSource.indexOf('journeyStage = "project-open";')
  );
  assert.match(
    projectGrantJourney,
    /getByLabel\("Organization member"\)\.selectOption\(\{\s*label: `\$\{inviteeDisplayName\} · Organization member`\s*\}\)/u
  );
  assert.match(projectGrantJourney, /Grant role/u);
  assert.match(
    projectGrantJourney,
    /getByText\(`\$\{inviteeDisplayName\} · Organization member`, \{ exact: true \}\)/u
  );
  assert.doesNotMatch(projectGrantJourney, /\.fill\(|user\s*id|uuid/iu);
  assert.doesNotMatch(browserAcceptanceSource, /\/api\/v1\/me/u);
  assert.doesNotMatch(browserAcceptanceSource, /Organization member user ID/u);
  assert.match(browserAcceptanceSource, /waitForPreviewFrame/u);
  assert.match(browserAcceptanceSource, /crossOriginIsolated/u);
  assert.match(browserAcceptanceSource, /Preview request carried an application cookie/u);
  assert.match(browserAcceptanceSource, /NURITEO_COMPOSE_STORAGE_SECRET_KEY_FILE/u);
  assert.match(browserAcceptanceSource, /assertNoPrivateStorageMaterial\(JSON\.stringify/u);
  assert.match(browserAcceptanceSource, /\.catch\(\(error: unknown\) => recordLedgerError/u);
  assert.match(browserAcceptanceSource, /await drainLedger\(ledger\)/u);
  assert.match(browserAcceptanceSource, /ledger\.closingContexts\.has\(context\).*isTargetClosed\(error\)/u);
  assert.match(browserAcceptanceSource, /Resume saved Project/u);

  for (const [name, command] of [["storage-check", "storage-check"], ["migrate", "migrate"], ["bootstrap-admin", "bootstrap-admin"], ["core", "serve"]]) {
    assert.match(services[name], /image: \$\{NURITEO_SERVER_IMAGE:-localhost\/nuriteo-server:cmp-003\}/u);
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
    "NURITEO_BOOTSTRAP_ADMIN_PASSWORD_FILE: /run/secrets/bootstrap_admin_password",
    "NURITEO_SAVE_IDEMPOTENCY_SECRET_FILE: /run/secrets/save_idempotency_secret",
    "NURITEO_MASTER_KEY_FILE: /run/secrets/master_key"
  ]) assert(source.includes(literal), `missing file-secret contract: ${literal}`);
  assert.doesNotMatch(source, /^\s+(?:POSTGRES_PASSWORD|NURITEO_DATABASE_URL|NURITEO_BOOTSTRAP_ADMIN_PASSWORD|NURITEO_S3_ACCESS_KEY_ID|NURITEO_S3_SECRET_ACCESS_KEY):/mu);

  assert.match(initSource, /--request PUT "\$endpoint"/u);
  assert.match(initSource, /BucketAlreadyOwnedByYou/u);
  assert.match(initSource, /--head "\$endpoint"/u);
  assert.match(initSource, /NURITEO_LEGACY_BROWSER_CORS_ORIGIN/u);
  assert.match(initSource, /NoSuchCORSConfiguration/u);
  assert.match(initSource, /legacy_cors_is_exact \|\|/u);
  assert.match(initSource, /nuriteo-browser-upload-v1/u);
  assert.match(initSource, /--request DELETE "\$endpoint\?cors"/u);
  assert.doesNotMatch(initSource, /--request PUT[\s\S]{0,200}\?cors/u);
  assert.doesNotMatch(initSource, /<AllowedOrigin>\*<\/AllowedOrigin>|<AllowedHeader>\*<\/AllowedHeader>/u);
  assert.doesNotMatch(initSource, /--request (?:POST|PATCH)/u);

  const externalConfigure = serviceBlock(externalSource, "storage-configure-browser-upload-cors");
  assert.match(externalConfigure, /command: \["storage-configure-browser-upload-cors"\]/u);
  assert.match(externalConfigure, /profiles: \["configure-browser-upload-cors"\]/u);
  const externalCheck = serviceBlock(externalSource, "storage-check");
  assert.match(externalCheck, /command: \["storage-check"\]/u);
  assert.match(externalCheck, /^      NURITEO_SAVE_UPLOAD_TRANSPORT: direct$/mu);
  assert.match(externalCheck, /NURITEO_S3_BUCKET: \$\{NURITEO_S3_BUCKET:\?set NURITEO_S3_BUCKET\}/u);
  assert.match(externalCheck, /NURITEO_S3_ACCESS_KEY_ID_FILE: \/run\/secrets\/s3_access_key/u);
  assert.doesNotMatch(externalSource, /storage-init|rustfs|migrate|bootstrap-admin|command:.*(?:create|delete)/iu);

  const startStack = shellFunction(acceptanceSource, "start_stack");
  const oneShotGate = 'for job in storage-init storage-check migrate bootstrap-admin; do';
  const oneShotCheck = 'wait_for_job "$job" 0';
  assert.match(startStack, /set \+e\s+compose_status=0\s+compose up --detach --no-build \|\| compose_status=\$\?\s+set -e/u);
  assert.match(startStack, /if \[ "\$compose_status" -eq 0 \]; then\s+return 0/u);
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
  assert.match(startStack, /if web_container="\$\(service_container "\$project" web\)"; then/u);
  assert.match(startStack, /web_status="\$\(\$engine inspect --format '\{\{\.State\.Status\}\}' "\$web_container"\)"/u);
  assert.match(startStack, /if \[ "\$web_status" = running \]; then\s+return 0/u);
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
    [compose.replaceAll("NURITEO_PREVIEW_SIGNING_KEY_FILE: /run/secrets/preview_signing_key", "NURITEO_PREVIEW_SIGNING_KEY: public"), external, init, acceptance],
    [compose.replace("NURITEO_SAVE_IDEMPOTENCY_SECRET_FILE: /run/secrets/save_idempotency_secret", "NURITEO_SAVE_IDEMPOTENCY_SECRET: public"), external, init, acceptance],
    [compose.replace("NURITEO_MASTER_KEY_FILE: /run/secrets/master_key", "NURITEO_MASTER_KEY: public"), external, init, acceptance],
    [compose.replace("NURITEO_SAVE_UPLOAD_TRANSPORT: relay", "NURITEO_SAVE_UPLOAD_TRANSPORT: direct"), external, init, acceptance],
    [compose.replace("NURITEO_LEGACY_BROWSER_CORS_ORIGIN", "NURITEO_EXTERNAL_URL"), external, init, acceptance],
    [compose, external.replace("NURITEO_SAVE_UPLOAD_TRANSPORT: direct", "NURITEO_SAVE_UPLOAD_TRANSPORT: relay"), init, acceptance],
    [compose, external.replace('command: ["storage-check"]', 'command: ["storage-init"]'), init, acceptance],
    [compose, external, init.replace('--request DELETE "$endpoint?cors"', '--request PUT "$endpoint?cors"'), acceptance],
    [compose, external, init.replace("legacy_cors_is_exact ||", ": ||"), acceptance],
    [compose, external, init.replace("--head", "--request DELETE"), acceptance],
    [compose, external, init, acceptance.replace("wait_for_job \"$job\" 0", ":"), browserAcceptance],
    [compose, external, init, acceptance, browserAcceptance.replace("Issue Organization invitation", "Issue invitation")],
    [compose, external, init, acceptance, browserAcceptance.replace("Organization member", "Organization user")],
    [compose, external, init, acceptance, browserAcceptance.replace("selectOption({", "fill(inviteeDisplayName); ({")],
    [compose, external, init, acceptance, browserAcceptance.replace('journeyStage = "project-grant";', 'journeyStage = "project-grant"; fetch("/api/v1/me");')],
    [compose, external, init, acceptance, browserAcceptance.replaceAll("waitForPreviewFrame", "findPreviewUrl")],
    [compose, external, init, acceptance, browserAcceptance.replace("crossOriginIsolated", "isSecureContext")],
    [compose, external, init, acceptance, browserAcceptance.replace("Resume saved Project", "Start workspace from template")]
  ];
  for (const [index, args] of mutations.entries()) {
    assert.throws(() => validate(...args), `compose drift mutation ${index + 1} was not rejected`);
  }
}
