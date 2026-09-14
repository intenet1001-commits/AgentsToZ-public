import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { classifyOnboardingAuth } from './onboardingAuthDiagnosis';

export interface SupabaseProjectsProbe { ok: boolean; stdout: string; stderr: string; timedOut: boolean }
export interface SupabaseCliStatus {
  installed: boolean; loggedIn: boolean | null; state: 'missing' | 'ready' | 'needs-login' | 'unknown';
  projects?: Array<{ ref: string; name: string; region: string }>;
  cliPath?: string; loginCmd?: string; detail?: string;
}

/** A bounded, noninteractive read. Raw stdout/stderr never leave this module. */
export function probeSupabaseProjects(executable: string, timeoutMs = 10_000): Promise<SupabaseProjectsProbe> {
  return new Promise(resolve => {
    const child = execFile(executable, ['projects', 'list', '--output', 'json'], {
      encoding: 'utf8', cwd: homedir(), timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true,
      maxBuffer: 512 * 1024,
    }, (error, stdout, stderr) => resolve({ ok: !error, stdout, stderr, timedOut: error?.killed === true }));
    child.stdin?.end();
  });
}

export function supabaseStatusFromProbe(cliPath: string, probe: SupabaseProjectsProbe): SupabaseCliStatus {
  const auth = classifyOnboardingAuth({ ok: probe.ok, output: `${probe.stdout}\n${probe.stderr}`, timedOut: probe.timedOut });
  const base = { installed: true, cliPath };
  if (auth.state !== 'ready') return { ...base, state: auth.state, loggedIn: auth.authenticated ?? null,
    detail: auth.detail, ...(auth.state === 'needs-login' ? { loginCmd: 'supabase login' } : {}) };
  try {
    const rows: unknown = JSON.parse(probe.stdout);
    if (!Array.isArray(rows) || rows.length > 5_000) throw new Error('format');
    const projects = rows.map(row => {
      if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !/^[a-z0-9]{20}$/.test(row.id)
        || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 256
        || typeof row.region !== 'string' || row.region.length > 100) throw new Error('format');
      return { ref: row.id, name: row.name, region: row.region };
    });
    if (new Set(projects.map(project => project.ref)).size !== projects.length) throw new Error('duplicate');
    return { ...base, state: 'ready', loggedIn: true, projects };
  } catch {
    return { ...base, state: 'unknown', loggedIn: null, detail: '프로젝트 목록의 형식을 확인하지 못했습니다. 기존 연결을 유지하고 CLI 버전을 확인하세요.' };
  }
}

/** Repeated UI checks share only the in-flight read; no cross-account cache. */
export function createSupabaseStatusReader(probe = probeSupabaseProjects) {
  const inFlight = new Map<string, Promise<SupabaseCliStatus>>();
  return async (cliPath: string) => {
    const existing = inFlight.get(cliPath);
    if (existing) return existing;
    const task = probe(cliPath).then(result => supabaseStatusFromProbe(cliPath, result)).catch((): SupabaseCliStatus => ({
      installed: true, state: 'unknown', loggedIn: null, detail: 'CLI 상태를 확인하지 못했습니다. 기존 인증을 유지합니다.',
    }));
    inFlight.set(cliPath, task);
    try { return await task; } finally { if (inFlight.get(cliPath) === task) inFlight.delete(cliPath); }
  };
}
