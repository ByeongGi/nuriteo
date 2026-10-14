import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync("deploy/docker/operations.Dockerfile", "utf8");
const fromInstructions = source.match(/^FROM .+$/gmu) ?? [];

assert.equal(fromInstructions.length, 3, "operations image must use exactly three stages");
assert.match(fromInstructions[0], /^FROM docker\.io\/library\/rust:1\.97\.1-slim-bookworm@sha256:[0-9a-f]{64} AS builder$/u);
assert.match(fromInstructions[1], /^FROM docker\.io\/library\/postgres@sha256:[0-9a-f]{64} AS postgres-client$/u);
assert.match(fromInstructions[2], /^FROM gcr\.io\/distroless\/cc-debian13:nonroot@sha256:[0-9a-f]{64} AS runtime$/u);

for (const required of [
  "/usr/lib/postgresql/17/bin/pg_dump",
  "/usr/lib/postgresql/17/bin/pg_restore",
  "ldd /usr/lib/postgresql/17/bin/pg_dump",
  "ldd /usr/lib/postgresql/17/bin/pg_restore",
  'destination="$root$(dirname "$resolved")"',
  'cp -L "$library" "$destination/$(basename "$library")"',
  "COPY --from=postgres-client /runtime-root /",
  "COPY --from=builder /build/target/release/nuriteo-server /usr/local/bin/nuriteo-server",
  "USER 65532:65532",
  'ENTRYPOINT ["/usr/local/bin/nuriteo-server"]',
]) {
  assert.ok(source.includes(required), `operations image contract missing: ${required}`);
}

assert.doesNotMatch(
  fromInstructions[2],
  /postgres/u,
  "final operations runtime must not inherit the PostgreSQL server image",
);
const runtimeSource = source.slice(source.lastIndexOf(fromInstructions[2]));
assert.doesNotMatch(runtimeSource, /(?:apt-get|apk) install/u, "runtime tooling must come from the pinned client stage");

console.log("operations image contract ok (minimal clients, distroless non-root runtime)");
