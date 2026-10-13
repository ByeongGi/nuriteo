import type { RuntimeHeaders, RuntimeHttpRequest, RuntimeHttpResponse } from "./types.ts";

export function parseHttpRequest(raw: string): RuntimeHttpRequest {
  const [head, body = ""] = splitHttpMessage(raw);
  const [requestLine, ...headerLines] = head.split("\r\n");
  const [method = "GET", path = "/", version = "HTTP/1.1"] = (requestLine || "").split(" ");
  return {
    method,
    path,
    version,
    headers: parseHeaders(headerLines),
    body
  };
}

export function serializeHttpRequest(request: Partial<RuntimeHttpRequest>): string {
  const headers = serializeHeaders(request.headers || {});
  return `${request.method || "GET"} ${request.path || "/"} ${request.version || "HTTP/1.1"}\r\n${headers}\r\n\r\n${request.body || ""}`;
}

export function parseHttpResponse(raw: string): RuntimeHttpResponse {
  const [head, body = ""] = splitHttpMessage(raw);
  const [statusLine, ...headerLines] = head.split("\r\n");
  const match = (statusLine ?? "").match(/^(HTTP\/\d\.\d) (\d{3}) ?(.*)$/);
  return {
    version: match?.[1] || "HTTP/1.1",
    statusCode: Number(match?.[2] || 0),
    statusText: match?.[3] || "",
    headers: parseHeaders(headerLines),
    body
  };
}

export function serializeHttpResponse(response: Partial<RuntimeHttpResponse>): string {
  const headers = serializeHeaders(response.headers || {});
  return `HTTP/1.1 ${response.statusCode || 200} ${response.statusText || "OK"}\r\n${headers}\r\n\r\n${response.body || ""}`;
}

function splitHttpMessage(raw: string): [string, string] {
  const index = raw.indexOf("\r\n\r\n");
  if (index < 0) return [raw, ""];
  return [raw.slice(0, index), raw.slice(index + 4)];
}

function parseHeaders(lines: string[]): RuntimeHeaders {
  const headers: RuntimeHeaders = {};
  for (const line of lines) {
    if (!line) continue;
    const index = line.indexOf(":");
    if (index < 0) continue;
    headers[line.slice(0, index).toLowerCase()] = line.slice(index + 1).trim();
  }
  return headers;
}

function serializeHeaders(headers: RuntimeHeaders): string {
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\r\n");
}
