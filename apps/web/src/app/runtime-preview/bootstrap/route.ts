import { NextResponse } from "next/server";

import { previewOriginConfiguration, previewSigningKey } from "../../../lib/preview/config.ts";
import { verifySignedPreviewBinding } from "../../../lib/preview/signed-binding.ts";
import { previewBootstrapDocument } from "../../../runtime/preview-bootstrap-document.ts";
import { parsePreviewHost } from "../../../runtime/preview-origin-contract.ts";

export async function GET(request: Request): Promise<NextResponse> {
  const configuration = previewOriginConfiguration();
  if (configuration.status === "disabled") return new NextResponse(null, { status: 503 });
  const hostname = requestHostname(request.headers.get("host"));
  const binding = parsePreviewHost(hostname, configuration.baseDomain);
  if (!binding) return new NextResponse(null, { status: 404 });
  const verification = await verifySignedPreviewBinding(previewSigningKey() ?? "", binding.runtimeId, binding.port);
  if (verification !== "valid") return new NextResponse(null, { status: verification === "expired" ? 410 : 404 });

  return new NextResponse(previewBootstrapDocument({
    applicationOrigin: configuration.applicationOrigin,
    binding: binding.label,
    runtimeId: binding.runtimeId
  }), {
    headers: previewBootstrapHeaders(configuration.applicationOrigin),
    status: 200
  });
}

function previewBootstrapHeaders(applicationOrigin: string): HeadersInit {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; worker-src 'self'; frame-src 'self'; connect-src 'self'; frame-ancestors ${applicationOrigin}; base-uri 'none'; form-action 'none'`,
    "Content-Type": "text/html; charset=utf-8",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff"
  };
}

function requestHostname(host: string | null): string {
  if (!host) return "";
  return host.replace(/:\d+$/u, "").toLowerCase().replace(/\.$/u, "");
}
