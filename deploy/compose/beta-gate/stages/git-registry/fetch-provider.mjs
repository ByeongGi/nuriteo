#!/usr/bin/env node
import fs from "node:fs";
import https from "node:https";

const command = process.argv[2];
const output = required("NURITEO_GATE_PROVIDER_FETCH_OUTPUT");
const ca = fs.readFileSync(required("NURITEO_GATE_PROVIDER_CA_FILE"));
if (command === "stats") {
  const body = await get(new URL("/__stats", required("NURITEO_GATE_PROVIDER_FETCH_ORIGIN")), undefined);
  JSON.parse(body.toString("utf8"));
  fs.writeFileSync(output, body, { mode: 0o600 });
} else if (command === "tarball") {
  const metadata = JSON.parse(fs.readFileSync(required("NURITEO_GATE_REGISTRY_METADATA_FILE"), "utf8"));
  const tarball = metadata.versions?.["1.0.0"]?.dist?.tarball;
  if (typeof tarball !== "string") throw new Error("metadata tarball URL is absent");
  const url = new URL(tarball);
  const fetchOrigin = process.env.NURITEO_GATE_PROVIDER_FETCH_ORIGIN?.trim();
  if (fetchOrigin) {
    const reachable = new URL(fetchOrigin);
    url.protocol = reachable.protocol;
    url.host = reachable.host;
  }
  const body = await get(url, `Bearer ${required("NURITEO_GATE_PROVIDER_TOKEN")}`);
  fs.writeFileSync(output, body, { mode: 0o600 });
} else {
  throw new Error("usage: fetch-provider.mjs {stats|tarball}");
}

function get(url, authorization) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: "GET", ca,
      headers: authorization ? { authorization, accept: "application/octet-stream" } : {},
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => response.statusCode === 200
        ? resolve(Buffer.concat(chunks))
        : reject(new Error(`provider returned ${response.statusCode}`)));
    });
    request.once("error", reject);
    request.end();
  });
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
