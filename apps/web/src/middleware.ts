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
      ? new NextResponse("Preview wildcard DNS and TLS are not ready.", { status: 503 })
      : NextResponse.next();
  }
  const binding = parsePreviewHost(hostname, configuration.baseDomain);
  if (!binding) {
    if (mightBePreview || request.nextUrl.pathname.startsWith(PREVIEW_ASSET_PREFIX)) return new NextResponse(null, { status: 404 });
    return NextResponse.next();
  }
  const verification = await verifySignedPreviewBinding(
    previewSigningKey() ?? "",
    binding.runtimeId,
    binding.port
  );
  if (verification !== "valid") return new NextResponse(null, { status: verification === "expired" ? 410 : 404 });
  if (request.nextUrl.pathname === "/runtime-preview/bootstrap") {
    return NextResponse.next();
  }
  if (request.nextUrl.pathname === "/runtime-preview/bootstrap.js" || request.nextUrl.pathname === "/runtime-preview/hmr.js") {
    return NextResponse.next();
  }
  if (request.nextUrl.pathname === "/runtime-preview/sw.js") {
    const response = NextResponse.next();
    response.headers.set("Service-Worker-Allowed", "/");
    return response;
  }
  return new NextResponse(null, { status: 404 });
}

export const config = {
  matcher: ["/:path*"],
  runtime: "nodejs"
};

function requestHostname(host: string | null): string {
  if (!host) return "";
  return host.replace(/:\d+$/u, "").toLowerCase().replace(/\.$/u, "");
}
