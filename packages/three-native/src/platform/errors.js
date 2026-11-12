// WebIDL's DOMException for the platform's own throws. Edge gives one the platform throws a stack that begins with
// its name and message; one a script constructs has no stack, which bootstrap.js keeps by deleting the Error's own.
export function withStack(error, message = error.message) {
  const trace = new Error(String(message)).stack ?? '';
  const newline = trace.indexOf('\n');
  error.stack = `${error.name}: ${String(message)}${newline < 0 ? '' : trace.slice(newline)}`;
  return error;
}

export function platformError(message, name = 'Error') {
  return withStack(new DOMException(message, name), message);
}
