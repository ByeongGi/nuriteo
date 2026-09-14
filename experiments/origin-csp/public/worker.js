let sabOk = false;
let error = null;

try {
  const buffer = new SharedArrayBuffer(4);
  const control = new Int32Array(buffer);
  Atomics.store(control, 0, 7);
  sabOk = Atomics.load(control, 0) === 7;
} catch (cause) {
  error = cause?.message || String(cause);
}

postMessage({
  crossOriginIsolated,
  sharedArrayBufferType: typeof SharedArrayBuffer,
  sabOk,
  error
});
