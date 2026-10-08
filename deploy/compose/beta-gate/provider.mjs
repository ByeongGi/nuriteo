import fs from "node:fs";
import https from "node:https";
import tls from "node:tls";

const mode = process.env.NURITEO_GATE_PROVIDER_MODE ?? "health";
const port = Number(process.env.NURITEO_GATE_PROVIDER_PORT ?? "8443");
const options = {
  cert: fs.readFileSync("/run/gate-provider/tls.crt"),
  key: fs.readFileSync("/run/gate-provider/tls.key")
};
if (mode === "smtp") {
  tls.createServer(options, (socket) => {
    socket.setEncoding("utf8");
    socket.write("220 gate-005 ESMTP ready\r\n");
    let dataMode = false;
    socket.on("data", (chunk) => {
      for (const line of chunk.split(/\r?\n/u)) {
        if (dataMode && line === ".") { dataMode = false; socket.write("250 queued\r\n"); continue; }
        if (dataMode || line === "") continue;
        if (/^(?:EHLO|HELO) /iu.test(line)) socket.write("250-gate-005\r\n250 PIPELINING\r\n");
        else if (/^(?:MAIL FROM|RCPT TO):/iu.test(line)) socket.write("250 ok\r\n");
        else if (line === "DATA") { dataMode = true; socket.write("354 end with .\r\n"); }
        else if (line === "QUIT") { socket.write("221 bye\r\n"); socket.end(); }
        else socket.write("250 ok\r\n");
      }
    });
  }).listen(port, "0.0.0.0");
} else {
const json = (response, status, value) => {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
};
https.createServer(options, (request, response) => {
  if (request.url === "/health") return json(response, 200, { status: "ready", provider: mode });
  if (mode === "oidc" && request.url === "/.well-known/openid-configuration") {
    return json(response, 200, {
      issuer: "https://oidc-provider:8443",
      authorization_endpoint: "https://oidc-provider:8443/authorize",
      token_endpoint: "https://oidc-provider:8443/token",
      jwks_uri: "https://oidc-provider:8443/jwks",
      response_types_supported: ["code"], subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"], code_challenge_methods_supported: ["S256"]
    });
  }
  if (mode === "registry" && request.url?.endsWith("/-/ping")) return json(response, 200, {});
  if (mode === "git" && request.url === "/capabilities") return json(response, 200, { smartHttp: true });
  return json(response, 404, { error: "not_found" });
}).listen(port, "0.0.0.0");
}
