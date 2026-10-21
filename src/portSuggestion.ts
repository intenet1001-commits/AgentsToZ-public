/**
 * Port candidates for 「추천」. Starting after the port already in the field
 * means each press offers the next free port instead of the same first one
 * (VOC 2026-09-24). The shown port itself is skipped; the order wraps once.
 */
export function* portSuggestionOrder(base: number, max: number, current?: string | number | null): Generator<number> {
  const shown = Number(current);
  const inRange = Number.isInteger(shown) && shown >= base && shown <= max;
  if (!inRange) {
    for (let port = base; port <= max; port++) yield port;
    return;
  }
  for (let port = shown + 1; port <= max; port++) yield port;
  for (let port = base; port < shown; port++) yield port;
}
