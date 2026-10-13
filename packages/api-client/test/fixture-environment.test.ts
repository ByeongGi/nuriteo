import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("./fixtures/core-organization/run.sh", import.meta.url));
const validator = fileURLToPath(
  new URL("./fixtures/core-organization/validate-external-origin.mjs", import.meta.url)
);
const validationError =
  "NURITEO_CLIENT_TEST_EXTERNAL_URL must be a canonical absolute HTTP(S) origin\n";

for (const origin of [
  "http://127.0.0.1:3010",
  "https://preview.example.test",
  "http://[::1]:3010"
]) {
  const result = runValidator(origin);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, origin);
  assert.equal(result.stderr, "");
}

for (const origin of [
  "",
  "preview.example.test",
  "ftp://preview.example.test",
  "https://user@preview.example.test",
  "https://preview.example.test/",
  "https://preview.example.test/path",
  "https://preview.example.test?query=true",
  "https://preview.example.test#fragment",
  "https://preview.example.test,https://other.example.test",
  "https://preview.example.test whitespace",
  "https://preview.example.test\n",
  "HTTPS://preview.example.test",
  "https://preview.example.test:443"
]) {
  const result = runValidator(origin);
  assert.equal(result.status, 2, origin);
  assert.equal(result.stdout, "", origin);
  assert.equal(result.stderr, validationError, origin);
}

const invalidFixture = spawnSync("bash", [fixture], {
  encoding: "utf8",
  env: {
    ...process.env,
    CONTAINER_RUNTIME: "nuriteo-container-runtime-must-not-run",
    NURITEO_CLIENT_TEST_EXTERNAL_URL: "https://user@preview.example.test"
  }
});
assert.equal(invalidFixture.status, 2);
assert.equal(invalidFixture.stdout, "");
assert.equal(invalidFixture.stderr, validationError);

const fixtureSource = readFileSync(fixture, "utf8");
const validationIndex = fixtureSource.indexOf("validate-external-origin.mjs");
assert.ok(validationIndex >= 0);
for (const boundary of [
  "fixture_dir=\"$(mktemp",
  "openssl rand -base64 32",
  "\"$runtime\" run --detach"
]) {
  assert.ok(validationIndex < fixtureSource.indexOf(boundary), boundary);
}
assert.match(fixtureSource, /export NURITEO_EXTERNAL_URL="\$external_url"/u);
assert.match(
  fixtureSource,
  /export NURITEO_HTTP_LISTEN_ADDR="127\.0\.0\.1:\$\{core_port\}"/u
);
assert.match(
  fixtureSource,
  /NURITEO_CLIENT_TEST_BASE_URL=http:\/\/127\.0\.0\.1:\$\{core_port\}/u
);
assert.match(
  fixtureSource,
  /client_environment\+=\("NURITEO_CLIENT_TEST_EXTERNAL_URL=\$external_url_override"\)/u
);

function runValidator(origin: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [validator], {
    encoding: "utf8",
    env: { ...process.env, NURITEO_CLIENT_TEST_EXTERNAL_URL: origin }
  });
}
