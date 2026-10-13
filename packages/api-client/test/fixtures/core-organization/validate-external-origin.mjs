import { fileURLToPath } from "node:url";

const INVALID_ORIGIN_CHARACTER = /[,\s\p{Cc}]/u;

export function validateExternalOrigin(value) {
  if (typeof value !== "string" || value.length === 0 || INVALID_ORIGIN_CHARACTER.test(value)) {
    throw new TypeError("invalid external origin");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("invalid external origin");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" || url.password !== "" || url.pathname !== "/" ||
    url.search !== "" || url.hash !== "" || url.origin !== value
  ) {
    throw new TypeError("invalid external origin");
  }
  return value;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(validateExternalOrigin(process.env.NURITEO_CLIENT_TEST_EXTERNAL_URL));
  } catch {
    process.stderr.write(
      "NURITEO_CLIENT_TEST_EXTERNAL_URL must be a canonical absolute HTTP(S) origin\n"
    );
    process.exitCode = 2;
  }
}
