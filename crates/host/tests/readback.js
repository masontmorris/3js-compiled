addEventListener('gpu-response', event => {
  const [response] = event.responses;
  const bytes = response.bytes;
  const ok = response.request === 5 && bytes instanceof ArrayBuffer && bytes.byteLength === 1280 * 720 * 4 && new Uint8Array(bytes)[bytes.byteLength - 1] === 7;
  setClearColor(ok ? 0 : 1, ok ? 1 : 0, 0, 1);
});
