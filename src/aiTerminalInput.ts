/** UTF-8 bounds preserve emoji/Korean when a paste spans multiple wire messages. */
export function splitTerminalInput(text: string): string[] {
  const parts: string[] = [];
  let part = '', bytes = 0, encoded = 0;
  for (const char of text) {
    const size = new TextEncoder().encode(char).length;
    const jsonSize = new TextEncoder().encode(JSON.stringify(char)).length - 2;
    if (bytes + size > 4096 || encoded + jsonSize > 7500) { parts.push(part); part = ''; bytes = 0; encoded = 0; }
    part += char; bytes += size; encoded += jsonSize;
  }
  if (part) parts.push(part);
  return parts;
}
