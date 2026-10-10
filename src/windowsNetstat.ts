export interface WindowsNetstatListener {
  port: number;
  pid: number;
}

const NON_LISTENER_STATES = new Set([
  'BOUND',
  'CLOSED',
  'CLOSE_WAIT',
  'CLOSING',
  'DELETE_TCB',
  'ESTABLISHED',
  'FIN_WAIT_1',
  'FIN_WAIT_2',
  'LAST_ACK',
  'SYN_RECEIVED',
  'SYN_SENT',
  'TIME_WAIT',
]);

const endpointPort = (endpoint: string): number | null => {
  const separator = endpoint.lastIndexOf(':');
  if (separator < 0) return null;
  const port = Number(endpoint.slice(separator + 1));
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : null;
};

const isWildcardForeignEndpoint = (endpoint: string): boolean => (
  /^(?:0\.0\.0\.0|\[::\]):0$/.test(endpoint)
);

/** Parse plain `netstat -ano` output. Do not use `netstat -q`: `-q` adds
 * BOUND non-listeners that share the wildcard foreign endpoint. State labels
 * are localized, so the wildcard `:0` endpoint is the locale-independent
 * listener signal and known English non-listener states are rejected as an
 * additional guard. */
export function parseWindowsNetstatListeners(output: string): WindowsNetstatListener[] {
  const listeners: WindowsNetstatListener[] = [];
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[0]?.toUpperCase() !== 'TCP') continue;
    const localEndpoint = parts[1];
    const foreignEndpoint = parts[2];
    const state = parts[parts.length - 2]?.toUpperCase();
    const pid = Number(parts[parts.length - 1]);
    if (!localEndpoint || !foreignEndpoint || !state) continue;
    if (NON_LISTENER_STATES.has(state) || !isWildcardForeignEndpoint(foreignEndpoint)) continue;
    const port = endpointPort(localEndpoint);
    if (!port || !Number.isInteger(pid) || pid <= 1) continue;
    const key = `${port}:${pid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    listeners.push({ port, pid });
  }
  return listeners;
}

export function windowsListenerPidsForPort(output: string, port: number): string[] {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return [];
  return parseWindowsNetstatListeners(output)
    .filter(listener => listener.port === port)
    .map(listener => String(listener.pid));
}

export function windowsListeningPorts(output: string): Set<number> {
  return new Set(parseWindowsNetstatListeners(output).map(listener => listener.port));
}
