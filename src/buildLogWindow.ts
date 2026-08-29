export interface BuildStatusLogWindow {
  output?: unknown;
  outputBase?: unknown;
  outputCursor?: unknown;
}

export interface BuildLogWindowDelta {
  entries: string[];
  cursor: number;
}

/**
 * Reads a bounded server log window without losing entries when the server has
 * already dropped older chunks. Older servers that do not send cursor metadata
 * continue to work as a simple zero-based array.
 */
export function buildLogWindowDelta(
  status: BuildStatusLogWindow,
  previousCursor: number,
): BuildLogWindowDelta {
  const output = Array.isArray(status.output)
    ? status.output.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const base = Number.isSafeInteger(status.outputBase) && Number(status.outputBase) >= 0
    ? Number(status.outputBase)
    : 0;
  const derivedCursor = base + output.length;
  const cursor = Number.isSafeInteger(status.outputCursor)
    && Number(status.outputCursor) === derivedCursor
    ? Number(status.outputCursor)
    : derivedCursor;
  const safePreviousCursor = Number.isSafeInteger(previousCursor) && previousCursor >= 0
    ? previousCursor
    : 0;
  const relativeStart = safePreviousCursor < base || safePreviousCursor > cursor
    ? 0
    : Math.min(output.length, safePreviousCursor - base);

  return {
    entries: output.slice(relativeStart),
    cursor,
  };
}
