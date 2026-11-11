// Awaits a frame and a timer at the module's top level, as a page that awaits renderer.compileAsync() before its
// loop does, and then turns the clear color green. A browser keeps running frames and timers while it waits.
await new Promise(resolve => requestAnimationFrame(resolve));
await new Promise(resolve => setTimeout(resolve, 5));
setClearColor(0, 1, 0, 1);
