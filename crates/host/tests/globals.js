const text = new TextDecoder().decode(new Uint8Array([0x63, 0x61, 0x66, 0xc3, 0xa9]));
requestAnimationFrame(() => setClearColor(Number(innerWidth === 640 && innerHeight === 360), Number(self === globalThis), Number(text === 'café' && new DOMException('m', 'OperationError') instanceof Error && new DOMException('m', 'OperationError').name === 'OperationError'), 1));
addEventListener('resize', event => {
  requestAnimationFrame(() => setClearColor(0, 0, 0, Number(innerWidth === event.width && innerHeight === 600) / 2));
});
