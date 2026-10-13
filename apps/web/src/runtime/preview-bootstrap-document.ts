export function previewBootstrapDocument(input: {
  applicationOrigin: string;
  binding: string;
  runtimeId: string;
}): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="nuriteo-application-origin" content="${escapeAttribute(input.applicationOrigin)}">
<meta name="nuriteo-preview-binding" content="${escapeAttribute(input.binding)}">
<meta name="nuriteo-runtime-id" content="${escapeAttribute(input.runtimeId)}">
<title>Nuriteo Preview</title><style>html,body,#nuriteo-preview-frame{border:0;height:100%;margin:0;padding:0;width:100%}body{overflow:hidden}</style></head>
<body>Connecting isolated Preview…<script src="/runtime-preview/bootstrap.js" defer></script></body></html>`;
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
