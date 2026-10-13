export default {
  server: {
    headers: {
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; worker-src 'self'; connect-src 'self' ws:; style-src 'self'",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin"
    }
  }
};
