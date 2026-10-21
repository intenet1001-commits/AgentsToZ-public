import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const rust = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from + start.length);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe('process control authority', () => {
  test('desktop and browser both use the loopback Bun sidecar lifecycle routes', () => {
    const api = between(app, 'const API = {', 'const AI_NAME_BATCH_CHAT_PROMPT');
    for (const route of [
      '/api/execute-command',
      '/api/detect-start-command',
      '/api/stop-command',
      '/api/force-restart-command',
      '/api/check-port-status',
      '/api/check-ports-batch',
    ]) {
      expect(api).toContain(route);
    }
    expect(api).toContain("isTauri() ? 'http://127.0.0.1:3001' : ''");
    for (const command of [
      "invoke('execute_command'",
      "invoke('detect_start_command'",
      "invoke('stop_command'",
      "invoke('force_restart_command'",
      "invoke('check_port_status'",
      "invoke('check_ports_status_batch'",
    ]) {
      expect(api).not.toContain(command);
    }
  });

  test('native invoke registry cannot bypass the shared sidecar launch lock', () => {
    const handler = between(rust, '.invoke_handler(tauri::generate_handler![', '])');
    for (const command of [
      'execute_command,',
      'detect_start_command,',
      'stop_command,',
      'force_restart_command,',
      'check_port_status,',
      'check_ports_status_batch,',
    ]) {
      expect(handler).not.toContain(command);
    }
  });
});
