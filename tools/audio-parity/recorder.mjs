// Ends a loopback recorder by its stop line.
export function stopRecorder(recorder) {
  recorder.stdin.end('stop\n');
}
