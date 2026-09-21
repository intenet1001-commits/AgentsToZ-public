export function processPortEnvironment(port: unknown): Record<string, string> {
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return {};
  return {
    PORT: String(port),
    ...(port < 65535 ? { API_PORT: String(port + 1) } : {}),
  };
}
