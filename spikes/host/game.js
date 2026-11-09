// Stand-in for the game: runs in V8 (deno_core), talks to the Servo HUD only through the bridge ops.
let frame = 0;
let hp = 100;

globalThis.tick = () => {
  const batches = JSON.parse(Deno.core.ops.op_take_events());
  for (const event of batches.flat()) {
    if (event.type === "click") hp = 100;
  }
  frame++;
  if (frame % 6 === 0) hp = hp > 0 ? hp - 1 : 100;
  Deno.core.ops.op_send_patch(JSON.stringify({ frame, hp }));
};
