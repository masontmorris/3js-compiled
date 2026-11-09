requestAnimationFrame(() => {
  Promise.resolve().then(() => setClearColor(0, 1, 0));
});
addEventListener("keydown", () => {
  Promise.resolve().then(() => setClearColor(1, 0, 0));
});
