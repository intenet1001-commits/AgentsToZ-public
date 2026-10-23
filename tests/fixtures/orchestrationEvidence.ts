/** Pure response evidence shared by regression tests and the opt-in live harness. */
export function exactMarkerLineCount(text: string, marker: string): number {
  return normalizedResponseLines(text).filter(line => line === marker).length;
}

export function hasExactMarkerLine(text: string, marker: string): boolean {
  return exactMarkerLineCount(text, marker) > 0;
}

/** Remove only a known TUI answer bullet. Prompt echoes such as `› ... marker ...` stay distinct. */
export function normalizedResponseLines(text: string): string[] {
  return text.split(/\r?\n/).map(line => line.trim().replace(/\s+[│┃]$/, '').replace(/^[│┃]\s*/, '').replace(/^[•●⏺✦*+-]\s+/, '').trim());
}
