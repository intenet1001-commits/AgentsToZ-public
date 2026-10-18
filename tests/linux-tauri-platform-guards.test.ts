import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');

function functionSection(name: string, nextName: string): string {
  const start = source.indexOf(`fn ${name}`);
  const end = source.indexOf(`fn ${nextName}`, start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

test('Linux folder-terminal command has an explicit unsupported-platform result', () => {
  const section = functionSection('open_terminal_at_folder', 'open_tmux_claude');
  expect(section).toContain('#[cfg(not(any(target_os = "macos", target_os = "windows")))]');
  expect(section).toContain('Err("이 기능은 macOS 또는 Windows에서만 지원됩니다".to_string())');
});

test('Linux agent view does not compile a macOS Terminal/iTerm launch path', () => {
  const section = functionSection('open_terminal_agent_view', 'open_cmux_project_agents');
  expect(section).toContain('#[cfg(target_os = "macos")]');
  expect(section).toContain('#[cfg(not(any(target_os = "macos", target_os = "windows")))]');
  expect(section).not.toContain('#[cfg(not(target_os = "windows"))]');
});
