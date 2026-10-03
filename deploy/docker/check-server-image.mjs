import fs from "node:fs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const dockerfilePath = "deploy/docker/server.Dockerfile";
const ignorePath = `${dockerfilePath}.dockerignore`;
const dockerfile = fs.readFileSync(dockerfilePath, "utf8");
const instructions = dockerfile
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));
const fromInstructions = instructions.filter((line) => line.startsWith("FROM "));

assert(fromInstructions.length === 2, "server image must have exactly builder and runtime stages");
assert(
  /^FROM docker\.io\/library\/rust:1\.97\.1-slim-bookworm@sha256:[0-9a-f]{64} AS builder$/.test(
    fromInstructions[0]
  ),
  "builder must pin the Rust 1.97.1 Bookworm multi-arch digest"
);
assert(
  /^FROM gcr\.io\/distroless\/cc-debian12:nonroot@sha256:[0-9a-f]{64} AS runtime$/.test(
    fromInstructions[1]
  ),
  "runtime must pin the non-root distroless multi-arch digest"
);
assert(
  instructions.includes(
    "RUN cargo build --locked --release --package nuriteo-server --bin nuriteo-server"
  ),
  "release build must use Cargo.lock and select only the server binary"
);
assert(
  instructions.includes(
    "COPY --from=builder /build/target/release/nuriteo-server /usr/local/bin/nuriteo-server"
  ),
  "runtime stage must copy only the release server binary"
);
assert(instructions.includes("USER 65532:65532"), "runtime user must be the numeric non-root identity");
assert(
  instructions.includes('ENTRYPOINT ["/usr/local/bin/nuriteo-server"]'),
  "runtime entrypoint must use exec form and the installed binary"
);
assert(!instructions.some((line) => line.startsWith("ADD ")), "ADD is not allowed in the server image");
assert(!instructions.some((line) => /^COPY\s+\.\s/.test(line)), "the repository root must not be copied wholesale");

const runtimeStart = instructions.indexOf(fromInstructions[1]);
const runtimeInstructions = instructions.slice(runtimeStart + 1);
const allowedRuntimeInstructions = new Set([
  "COPY --from=builder /build/target/release/nuriteo-server /usr/local/bin/nuriteo-server",
  "USER 65532:65532",
  'ENTRYPOINT ["/usr/local/bin/nuriteo-server"]'
]);
for (const instruction of runtimeInstructions) {
  assert(allowedRuntimeInstructions.has(instruction), `unexpected runtime instruction: ${instruction}`);
}

const ignoreRules = fs
  .readFileSync(ignorePath, "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));
const expectedIgnoreRules = [
  "**",
  "!Cargo.toml",
  "!Cargo.lock",
  "!crates/",
  "!crates/**/",
  "!crates/**/Cargo.toml",
  "!crates/**/src/",
  "!crates/**/src/**"
];
assert(
  JSON.stringify(ignoreRules) === JSON.stringify(expectedIgnoreRules),
  "server build context must remain an exact Cargo source allowlist"
);

for (const requiredPath of ["Cargo.toml", "Cargo.lock", "crates/nuriteo-server/Cargo.toml"]) {
  assert(fs.existsSync(requiredPath), `missing build input: ${requiredPath}`);
}

console.log("server image contract ok (pinned multi-stage, non-root distroless runtime, allowlisted context)");
