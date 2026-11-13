// Ends a loopback recorder by its stop line. A recorder that has already exited is stopped, though Node may not have
// seen the exit yet, so the write to its closed pipe fails, and that failure is not an error.
export function stopRecorder(recorder) {
  recorder.stdin.on('error', error => {
    if (error.code !== 'EPIPE') throw error;
  });
  recorder.stdin.end('stop\n');
}
