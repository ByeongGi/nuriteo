import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const stateRoot = path.resolve(process.env.NURITEO_DEV_STATE_DIR ?? path.join(repositoryRoot, ".local/nuriteo-compose"));
const webPort = validatedPort("NURITEO_DEV_WEB_PORT", 3000);
const corePort = validatedPort("NURITEO_DEV_CORE_PORT", 8080);
const managementPort = validatedPort("NURITEO_DEV_MANAGEMENT_PORT", 9090);
const rustfsPort = validatedPort("NURITEO_DEV_RUSTFS_PORT", 19000);
const adminEmail = process.env.NURITEO_DEV_ADMIN_EMAIL ?? "admin@example.test";
const adminName = process.env.NURITEO_DEV_ADMIN_NAME ?? "Local Administrator";
const serverCommand = ["run", "--locked", "--package", "nuriteo-server", "--bin", "nuriteo-server", "--"];
const processes = new Set();
let stopping = false;

function validatedPort(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be an integer from 1 through 65535`);
  }
  return value;
}

function localEnvironment() {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("NURITEO_DEV_")),
  );
  for (const name of [
    "NURITEO_DATABASE_URL",
    "NURITEO_S3_ACCESS_KEY_ID",
    "NURITEO_S3_SECRET_ACCESS_KEY",
    "NURITEO_BOOTSTRAP_ADMIN_PASSWORD",
    "NURITEO_PREVIEW_SIGNING_KEY",
    "NURITEO_SAVE_IDEMPOTENCY_SECRET",
    "NURITEO_MASTER_KEY",
  ]) {
    delete environment[name];
  }
  return {
    ...environment,
    NURITEO_EXTERNAL_URL: `http://127.0.0.1:${webPort}`,
    NURITEO_HTTP_LISTEN_ADDR: `127.0.0.1:${corePort}`,
    NURITEO_MANAGEMENT_LISTEN_ADDR: `127.0.0.1:${managementPort}`,
    NURITEO_LOG_FORMAT: process.env.NURITEO_LOG_FORMAT ?? "text",
    NURITEO_LOG_LEVEL: process.env.NURITEO_LOG_LEVEL ?? "info",
    NURITEO_DATABASE_URL_FILE: path.join(stateRoot, "database-url-host"),
    NURITEO_DATABASE_CA_FILE: path.join(stateRoot, "postgres-tls/ca.crt"),
    NURITEO_S3_ENDPOINT: `https://127.0.0.1:${rustfsPort}`,
    NURITEO_S3_REGION: "us-east-1",
    NURITEO_S3_BUCKET: process.env.NURITEO_S3_BUCKET ?? "nuriteo",
    NURITEO_S3_ADDRESSING_STYLE: "path",
    NURITEO_S3_CREDENTIAL_PROVIDER: "static",
    NURITEO_S3_ACCESS_KEY_ID_FILE: path.join(stateRoot, "rustfs-access-key"),
    NURITEO_S3_SECRET_ACCESS_KEY_FILE: path.join(stateRoot, "rustfs-secret-key"),
    NURITEO_S3_CA_FILE: path.join(stateRoot, "rustfs-tls/ca.crt"),
    NURITEO_SAVE_IDEMPOTENCY_SECRET_FILE: path.join(stateRoot, "save-idempotency-secret"),
    NURITEO_SAVE_DEFAULT_QUOTA_BYTES: process.env.NURITEO_SAVE_DEFAULT_QUOTA_BYTES ?? "10737418240",
    NURITEO_SAVE_UPLOAD_TRANSPORT: "relay",
    NURITEO_MASTER_KEY_FILE: path.join(stateRoot, "master-key"),
    NURITEO_MASTER_KEY_VERSION: process.env.NURITEO_MASTER_KEY_VERSION ?? "1",
    NURITEO_PREVIEW_SIGNING_KEY_FILE: path.join(stateRoot, "preview-signing-key"),
  };
}

function spawnProcess(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: repositoryRoot,
    env: options.env ?? process.env,
    stdio: "inherit",
  });
  processes.add(child);
  child.once("exit", () => processes.delete(child));
  return child;
}

function waitForProcess(child, label) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed${signal ? ` with ${signal}` : ` with exit code ${code}`}`));
    });
  });
}

async function run(command, args, label, env = process.env) {
  console.log(`\n[live] ${label}`);
  await waitForProcess(spawnProcess(command, args, { env }), label);
}

function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function startCoreWatcher(environment) {
  let core;
  let restarting = false;
  let debounce;

  const start = () => {
    console.log(`\n[live] Core listening on http://127.0.0.1:${corePort} (watching Rust sources)`);
    core = spawnProcess("cargo", [...serverCommand, "serve"], { env: environment });
    core.once("exit", (code, signal) => {
      if (!stopping && !restarting) {
        console.error(`[live] Core stopped${signal ? ` (${signal})` : ` (exit ${code})`}; save a Rust file to retry.`);
      }
    });
  };

  start();
  const restart = () => {
    if (stopping) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      restarting = true;
      console.log("\n[live] Rust change detected; restarting Core…");
      const previous = core;
      const resume = () => {
        restarting = false;
        if (!stopping) start();
      };
      if (previous.exitCode !== null || previous.signalCode !== null) resume();
      else {
        previous.once("exit", resume);
        terminate(previous);
      }
    }, 200);
  };
  const watchInput = (absolute, options = {}) => {
    fs.watch(absolute, options, (_event, filename) => {
      if (filename && !/\.(rs|sql|toml|json)$/u.test(String(filename))) return;
      restart();
    });
  };
  for (const relativeRoot of ["crates", "compat"]) {
    const absolute = path.join(repositoryRoot, relativeRoot);
    if (fs.existsSync(absolute)) watchInput(absolute, { recursive: true });
  }
  for (const name of ["Cargo.toml", "Cargo.lock"]) watchInput(path.join(repositoryRoot, name));
}

async function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;
  console.log("\n[live] Core and Web stopping; PostgreSQL and RustFS remain available for the next run.");
  for (const child of processes) terminate(child);
  setTimeout(() => process.exit(exitCode), 750);
}

async function main() {
  process.once("SIGINT", () => void shutdown(0));
  process.once("SIGTERM", () => void shutdown(0));

  await run(path.join(repositoryRoot, "deploy/compose/dev-stack.sh"), ["infra"], "Starting PostgreSQL and RustFS");
  const environment = localEnvironment();
  await run("cargo", [...serverCommand, "storage-check"], "Checking object storage", environment);
  await run("cargo", [...serverCommand, "migrate"], "Applying database migrations", environment);
  await run(
    "cargo",
    [...serverCommand, "bootstrap-admin"],
    "Ensuring the local administrator exists",
    {
      ...environment,
      NURITEO_BOOTSTRAP_ADMIN_EMAIL: adminEmail,
      NURITEO_BOOTSTRAP_ADMIN_NAME: adminName,
      NURITEO_BOOTSTRAP_ADMIN_PASSWORD_FILE: path.join(stateRoot, "bootstrap-admin-password"),
    },
  );
  await run("pnpm", ["--filter", "@nuriteo/web", "runtime:assets"], "Preparing browser runtime assets");

  startCoreWatcher(environment);
  console.log(`[live] Web listening on http://127.0.0.1:${webPort} (Next.js HMR enabled)`);
  const web = spawnProcess(
    "pnpm",
    ["--filter", "@nuriteo/web", "exec", "next", "dev", "--hostname", "127.0.0.1", "--port", String(webPort)],
    {
      env: {
        ...process.env,
        NURITEO_INTERNAL_API_URL: `http://127.0.0.1:${corePort}`,
        NURITEO_EXTERNAL_URL: `http://127.0.0.1:${webPort}`,
        NURITEO_PREVIEW_BASE_DOMAIN: "preview.localhost",
        NURITEO_PREVIEW_SIGNING_KEY_FILE: path.join(stateRoot, "preview-signing-key"),
        NURITEO_PREVIEW_WILDCARD_READY: "true",
      },
    },
  );
  web.once("exit", (code) => {
    if (!stopping) void shutdown(code ?? 1);
  });
}

main().catch((error) => {
  console.error(`\n[live] ${error.message}`);
  void shutdown(1);
});
