/**
 * 에뮬레이터 하네스 전용 사이드카 진입점(관측 텔레메트리). **차단 장치가 아니다** — 차단은 sandbox-exec가 한다
 * (scripts/emulator-e2e/sandbox.ts). api-server는 로드할 때 child_process를 바인딩하고 네이티브 애드온은 이 래퍼를
 * 거치지 않으므로 여기서 보이는 것은 JS가 부른 실행뿐이다.
 *
 * - `open`·`osascript`는 기록하고 거절한다(실행하지 않는다).
 * - `security`·TCC 도구·`launchctl`·`defaults`·`screencapture`·`pbcopy`·`pbpaste`는 기록하고 그대로 넘긴다 —
 *   샌드박스가 막는 것(EPERM)을 이 기록으로 본다.
 * 기록 위치는 AGENTSTOZ_EMULATOR_SIDE_EFFECT_LOG(JSONL, 실행 스크래치). 값이 없으면 시작을 거절한다.
 *
 * 이 파일은 build-sidecar.ts의 진입점이 아니고 운영 빌드에 실리지 않는다(tests/emulator-sandbox.test.ts가 확인).
 */
import {appendFileSync} from 'node:fs';
import {basename} from 'node:path';

const LOG = process.env.AGENTSTOZ_EMULATOR_SIDE_EFFECT_LOG;
if (!LOG || !LOG.startsWith('/')) {
  console.error('[side-effect-guard] AGENTSTOZ_EMULATOR_SIDE_EFFECT_LOG must be an absolute path');
  process.exit(64);
}
delete process.env.AGENTSTOZ_EMULATOR_SIDE_EFFECT_LOG;

const REFUSED = new Set(['open', 'osascript']);
const OBSERVED = new Set(['security', 'tccutil', 'launchctl', 'defaults', 'screencapture', 'pbcopy', 'pbpaste', 'shortcuts']); // emulator-guard:forbidden-tool-declaration

type Record_ = {at: string; api: string; command: string; argc: number; outcome: string; code?: string; pid?: number};

function record(entry: Omit<Record_, 'at'>): void {
  try { appendFileSync(LOG!, `${JSON.stringify({at: new Date().toISOString(), ...entry})}\n`, {mode: 0o600}); } catch { /* 관측 실패가 사이드카를 멈추면 안 된다 */ }
}

/** 실행 파일 이름(경로·셸 문자열의 첫 단어). 인자는 기록하지 않는다(비밀이 섞일 수 있다). */
function programOf(command: unknown): string | null {
  if (typeof command !== 'string' || !command.trim()) return null;
  const first = command.trim().split(/\s+/)[0]!;
  return basename(first.replace(/^["']|["']$/g, ''));
}

function classify(program: string | null): 'refuse' | 'observe' | null {
  if (!program) return null;
  if (REFUSED.has(program)) return 'refuse';
  if (OBSERVED.has(program)) return 'observe';
  return null;
}

function refusal(api: string, program: string): Error {
  const error = new Error(`side-effect guard refused ${program} (${api})`) as Error & {code: string};
  error.code = 'EMULATOR_GUARD_REFUSED';
  return error;
}

// ── Bun.spawn / Bun.spawnSync ──
const bunSpawn = Bun.spawn.bind(Bun);
const bunSpawnSync = Bun.spawnSync.bind(Bun);
function bunCommand(args: unknown[]): {program: string | null; argc: number} {
  const first = args[0] as unknown;
  const cmd = Array.isArray(first) ? first : (first && typeof first === 'object' ? (first as {cmd?: unknown}).cmd : null);
  if (!Array.isArray(cmd)) return {program: null, argc: 0};
  return {program: programOf(String(cmd[0] ?? '')), argc: cmd.length};
}
for (const [api, original] of [['Bun.spawn', bunSpawn], ['Bun.spawnSync', bunSpawnSync]] as const) {
  (Bun as unknown as Record<string, unknown>)[api.slice(4)] = (...args: unknown[]) => {
    const {program, argc} = bunCommand(args);
    const kind = classify(program);
    if (kind === 'refuse') { record({api, command: program!, argc, outcome: 'refused-by-wrapper'}); throw refusal(api, program!); }
    if (kind !== 'observe') return (original as (...a: unknown[]) => unknown)(...args);
    try {
      const result = (original as (...a: unknown[]) => {pid?: number; exitCode?: number | null}) (...args);
      record({api, command: program!, argc, outcome: 'spawned', pid: result?.pid});
      return result;
    } catch (error) {
      record({api, command: program!, argc, outcome: 'spawn-error', code: String((error as {code?: string}).code ?? (error as Error).message).slice(0, 80)});
      throw error;
    }
  };
}

// ── node:child_process ──
const childProcess = require('node:child_process') as Record<string, (...args: unknown[]) => unknown>;
const SHELL_APIS = new Set(['exec', 'execSync']);
for (const api of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync'] as const) {
  const original = childProcess[api]!;
  childProcess[api] = (...args: unknown[]) => {
    const program = programOf(String(args[0] ?? ''));
    const argc = SHELL_APIS.has(api) ? 0 : (Array.isArray(args[1]) ? args[1].length + 1 : 1);
    const kind = classify(program);
    if (kind === 'refuse') {
      record({api: `child_process.${api}`, command: program!, argc, outcome: 'refused-by-wrapper'});
      const callback = args.find(arg => typeof arg === 'function') as ((error: Error) => void) | undefined;
      if (callback && (api === 'execFile' || api === 'exec')) { queueMicrotask(() => callback(refusal(api, program!))); return undefined; }
      throw refusal(api, program!);
    }
    if (kind !== 'observe') return original(...args);
    try {
      const result = original(...args) as {pid?: number; once?: (event: string, listener: (error: {code?: string}) => void) => void; error?: {code?: string}};
      record({api: `child_process.${api}`, command: program!, argc, outcome: 'spawned', pid: result?.pid});
      if (result?.error) record({api: `child_process.${api}`, command: program!, argc, outcome: 'spawn-error', code: String(result.error.code ?? 'ERROR')});
      result?.once?.('error', error => record({api: `child_process.${api}`, command: program!, argc, outcome: 'spawn-error', code: String(error?.code ?? 'ERROR')}));
      return result;
    } catch (error) {
      record({api: `child_process.${api}`, command: program!, argc, outcome: 'spawn-error', code: String((error as {code?: string}).code ?? 'ERROR')});
      throw error;
    }
  };
}

record({api: 'guard', command: 'start', argc: 0, outcome: 'installed', pid: process.pid});
await import('../../api-server.ts');
