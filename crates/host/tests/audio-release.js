// Each call to __churn() makes nodes and buffers and drops them, starting half the sources, as a game playing one-shot
// sounds does. The host test collects the garbage and checks that the engine let their handles go.
const ctx = new AudioContext();
globalThis.__churn = () => {
  for (let i = 0; i < 100; i++) {
    const buffer = ctx.createBuffer(1, 128, ctx.sampleRate);
    buffer.getChannelData(0)[0] = 1;
    const source = new AudioBufferSourceNode(ctx, { buffer });
    source.connect(new GainNode(ctx)).connect(ctx.destination);
    if (i % 2) source.start();
  }
};
