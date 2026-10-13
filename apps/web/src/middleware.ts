import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { previewOriginConfiguration, previewSigningKey } from "./lib/preview/config.ts";
import { verifySignedPreviewBinding } from "./lib/preview/signed-binding.ts";
import { parsePreviewHost } from "./runtime/preview-origin-contract.ts";

const PREVIEW_ASSET_PREFIX = "/runtime-preview/";

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const configuration = previewOriginConfiguration();
  const hostname = requestHostname(request.headers.get("host"));
  const configuredDomain = process.env.NURITEO_PREVIEW_BASE_DOMAIN?.trim().toLowerCase().replace(/\.$/u, "");
  const mightBePreview = configuredDomain !== undefined && hostname.endsWith(`.${configuredDomain}`);

  if (configuration.status === "disabled") {
    return mightBePreview
      ? previewErrorResponse("Preview wildcard DNS and TLS are not ready.", 503)
      : applicationResponse(NextResponse.next());
  }
  const binding = parsePreviewHost(hostname, configuration.baseDomain);
  if (!binding) {
    if (mightBePreview) return previewErrorResponse(null, 404);
    if (request.nextUrl.pathname.startsWith(PREVIEW_ASSET_PREFIX)) return applicationResponse(new NextResponse(null, { status: 404 }));
    return applicationResponse(NextResponse.next());
  }
  const verification = await verifySignedPreviewBinding(
    previewSigningKey() ?? "",
    binding.runtimeId,
    binding.port
  );
  if (verification !== "valid") return previewErrorResponse(null, verification === "expired" ? 410 : 404);
  if (request.nextUrl.pathname === "/runtime-preview/bootstrap") {
    return previewResponse(NextResponse.next());
  }
  if (request.nextUrl.pathname === "/runtime-preview/bootstrap.js" || request.nextUrl.pathname === "/runtime-preview/hmr.js") {
    return previewResponse(NextResponse.next());
  }
  if (request.nextUrl.pathname === "/runtime-preview/sw.js") {
    const response = previewResponse(NextResponse.next());
    response.headers.set("Service-Worker-Allowed", "/");
    return response;
  }
  return previewErrorResponse(null, 404);
}

export const config = {
  matcher: ["/:path*"],
  runtime: "nodejs"
};

function requestHostname(host: string | null): string {
  if (!host) return "";
  return host.replace(/:\d+$/u, "").toLowerCase().replace(/\.$/u, "");
}

function applicationResponse(response: NextResponse): NextResponse {
  response.headers.set("Cross-Origin-Resource-Policy", "same-origin");
  return response;
}

function previewResponse(response: NextResponse): NextResponse {
  response.headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  return response;
}

function previewErrorResponse(body: string | null, status: number): NextResponse {
  const response = previewResponse(new NextResponse(body, { status }));
  response.headers.set("Cache-Control", "no-store");
  return response;
}
