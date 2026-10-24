import { previewOriginConfiguration } from "#src/lib/preview/config.ts";

export function GET(): Response {
  const configuration = previewOriginConfiguration();
  if (configuration.status === "disabled") {
    return new Response("Preview is unavailable.", { status: 503 });
  }
  const publicPort = configuration.publicPort ? `:${configuration.publicPort}` : "";
  const previewSource = `${configuration.protocol}//*.${configuration.baseDomain}${publicPort}`;
  return new Response(`<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>미리보기 · NURITEO</title>
  <style>html,body,main{width:100%;height:100%;margin:0}body{font-family:system-ui,sans-serif}main{display:grid;background:#fff}p{margin:auto;color:#475569;font-size:14px}iframe{display:block;width:100%;height:100%;border:0;background:#fff}</style>
</head>
<body>
  <main id="preview-window"><p>미리보기를 연결하는 중…</p></main>
  <script src="/preview-window.js"></script>
</body>
</html>`, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; frame-src ${previewSource}; base-uri 'none'; form-action 'none'`,
      "Content-Type": "text/html; charset=utf-8",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff"
    }
  });
}
