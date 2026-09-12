export interface PortLogRead {
  exists: boolean;
  content: string;
  size: number;
}

export const PORT_LOG_LINE_LIMIT = 500;
export const PORT_LOG_RETAINED_BYTES = 512 * 1024;

/** UTF-16 text plus a small per-line allowance; the original log is untouched. */
export function retainPortLogLines(input: readonly string[]): string[] {
  const lines: string[] = [];
  let remaining = PORT_LOG_RETAINED_BYTES;
  for (let i = input.length - 1; i >= 0 && lines.length < PORT_LOG_LINE_LIMIT && remaining > 32; i--) {
    const line = input[i]!;
    const maxChars = Math.floor((remaining - 32) / 2);
    if (!maxChars) break;
    let retained = line.slice(-maxChars);
    // Do not start a truncated line in the middle of a Unicode surrogate pair.
    if (retained.length < line.length && /^[\uDC00-\uDFFF]/.test(retained)) retained = retained.slice(1);
    lines.push(retained);
    remaining -= retained.length * 2 + 32;
    if (retained.length < line.length) break;
  }
  return lines.reverse();
}

/** One viewer lifetime owns its timer, cursor and retained lines. */
export function startPortLogPolling(options: {
  portId: string;
  read: (portId: string, offset: number, signal: AbortSignal) => Promise<PortLogRead>;
  onLines: (lines: string[]) => void;
  onLoading: (loading: boolean) => void;
  schedule?: (callback: () => void) => () => void;
}): () => void {
  let stopped = false;
  let offset = 0;
  let lines: string[] = [];
  let cancelTimer: (() => void) | undefined;
  const controller = new AbortController();
  const schedule = options.schedule ?? (callback => {
    const timer = setTimeout(callback, 1000);
    return () => clearTimeout(timer);
  });
  const parse = (text: string) => retainPortLogLines(text.split('\n').filter(Boolean));
  const poll = async (initial: boolean) => {
    try {
      let data = await options.read(options.portId, initial ? 0 : offset, controller.signal);
      if (stopped) return;
      const rotated = !initial && data.exists && data.size < offset;
      if (rotated) {
        data = await options.read(options.portId, 0, controller.signal);
        if (stopped) return;
      }
      if (initial || rotated) {
        lines = data.exists ? parse(data.content) : [];
        if (data.exists && !lines.length) lines = ['(로그가 비어 있습니다)'];
        if (!data.exists) lines = ['로그 파일이 아직 생성되지 않았습니다.', '', '서버를 이 앱에서 실행하면 로그가 기록됩니다.'];
        offset = data.exists ? data.size : 0;
        options.onLines(lines);
      } else if (data.exists && data.size > offset) {
        const added = parse(data.content);
        if (added.length) {
          lines = retainPortLogLines([...lines, ...added]);
          options.onLines(lines);
        }
        offset = data.size;
      }
    } catch (error) {
      if (stopped) return;
      if (initial) {
        options.onLines(retainPortLogLines([`로그 읽기 실패: ${error}`]));
        return;
      }
      // A transient read failure keeps the last rendered window and cursor.
    } finally {
      if (initial && !stopped) options.onLoading(false);
    }
    if (!stopped) cancelTimer = schedule(() => void poll(false));
  };
  options.onLoading(true);
  void poll(true);
  return () => {
    stopped = true;
    controller.abort();
    cancelTimer?.();
    cancelTimer = undefined;
  };
}
