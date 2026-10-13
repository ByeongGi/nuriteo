/* Preview service worker: routes /__preview/* to the controlling product page. */

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/__nuriteo_runtime_module/")) {
    event.respondWith(routeRuntimeModule(event.request));
    return;
  }
  if (!url.pathname.startsWith("/__preview/")) return;
  event.respondWith(routePreview(event.request));
});

async function routeRuntimeModule(request) {
  const response = await caches.match(request);
  if (response) return response;
  return new Response("Runtime module was not published.", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp"
    }
  });
}

async function routePreview(request) {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const client = clients.find((entry) => entry.frameType === "top-level") || clients[0];
  const corpHeaders = {
    "content-type": "text/plain; charset=utf-8",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp"
  };

  if (!client) {
    return new Response("Preview host page is not available.", {
      status: 503,
      headers: corpHeaders
    });
  }

  const channel = new MessageChannel();
  const responsePromise = new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(new Response("Preview relay timed out.", {
        status: 504,
        headers: corpHeaders
      }));
    }, 5000);

    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      const payload = event.data || {};
      resolve(new Response(payload.body ?? "", {
        status: payload.status || 500,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "Cross-Origin-Resource-Policy": "same-origin",
          "Cross-Origin-Embedder-Policy": "require-corp",
          ...(payload.headers || {})
        }
      }));
    };
  });

  const url = new URL(request.url);
  client.postMessage({
    type: "preview-sw:fetch",
    path: `${url.pathname}${url.search}`,
    method: request.method || "GET"
  }, [channel.port2]);

  return responsePromise;
}
