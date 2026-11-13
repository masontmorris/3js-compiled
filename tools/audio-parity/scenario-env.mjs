// The files the scenarios load, under examples/audio. `base` is '' in Edge, which serves that folder at the origin's
// root, and the folder's file: URL in the host and in Node.
export function scenarioEnv(base) {
  const root = base.replace(/\/$/, '');
  return { clip: `${root}/clips/tone-stereo-44100.mp3`, json: `${root}/data/test.json`, text: `${root}/data/test.txt`, missing: `${root}/data/missing.bin` };
}
