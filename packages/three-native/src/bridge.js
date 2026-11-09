const native = globalThis.__nativeBridge;
const listeners = new Set();
if (!native && typeof window !== "undefined") {
  window.addEventListener("message", event => {
    for (const listener of listeners) listener(event.data);
  });
}

export const bridge = {
  open(path) {
    if (native) native.open(path);
  },
  send(patch) {
    if (native) native.send(patch);
    else window.postMessage(patch, "*");
  },
  onEvent(listener) {
    if (native) return native.onEvent(listener);
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
