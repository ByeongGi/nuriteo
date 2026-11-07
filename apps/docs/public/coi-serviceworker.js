self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.cache === "only-if-cached" && request.mode !== "same-origin") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(isolate(request));
});

async function isolate(request) {
  // Chrome fails a navigation (net::ERR_FAILED) when this worker follows a
  // redirect itself. GitHub Pages redirects /sdk to /sdk/, so hand that
  // redirect back and add isolation headers on the response that stays.
  const response = request.mode === "navigate"
    ? await fetch(request, { redirect: "manual" })
    : await fetch(request);
  if (request.mode === "navigate" && response.status >= 300 && response.status < 400) return response;
  if (response.status === 0) return response;
  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
