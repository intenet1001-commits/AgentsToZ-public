/**
 * Hermes' dashboard backend publishes this compact receipt through
 * HERMES_DESKTOP_READY_FILE. It is a backend port announcement, not proof that
 * the renderer selected a particular conversation.
 */
export function hermesDashboardReadyPort(receipt: unknown): number | null {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return null;
  const port = Number((receipt as Record<string, unknown>).port);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}
