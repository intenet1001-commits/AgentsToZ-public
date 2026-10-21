export interface OrcaFloatingVisibility {
  open: boolean;
  toggleElementIndex: number | null;
}

function collectStringValues(value: unknown, output: string[]): void {
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(item => collectStringValues(item, output));
    return;
  }
  if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach(item => collectStringValues(item, output));
  }
}

/** Inspect `orca computer get-app-state --json` without depending on one result envelope version. */
export function inspectOrcaFloatingVisibility(value: unknown): OrcaFloatingVisibility {
  const strings: string[] = [];
  collectStringValues(value, strings);
  const open = strings.some(text => text.includes('Minimize floating workspace'));
  let toggleElementIndex: number | null = null;

  for (const text of strings) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes('Show floating workspace') || !line.includes('toggle button')) continue;
      const match = line.trimStart().match(/^(\d+)\s+/);
      if (match) {
        toggleElementIndex = Number(match[1]);
        break;
      }
    }
    if (toggleElementIndex !== null) break;
  }

  return { open, toggleElementIndex };
}
