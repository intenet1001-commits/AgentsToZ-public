import { spawn } from 'node:child_process';

export interface CodexRateLimitWindow {
  used_percent?: number;
  window_minutes?: number | null;
  resets_at?: number | null;
}

export interface CodexRateLimits {
  primary?: CodexRateLimitWindow | null;
  secondary?: CodexRateLimitWindow | null;
  credits?: { has_credits?: boolean; unlimited?: boolean; balance?: string | null } | null;
  plan_type?: string | null;
  limit_id?: string | null;
  limit_name?: string | null;
}

export interface CodexLiveRateLimits {
  rateLimits: CodexRateLimits;
  checkedAt: string;
}

const asRecord = (value: unknown): Record<string, any> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null;

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

function normalizeWindow(value: unknown): CodexRateLimitWindow | null {
  const window = asRecord(value);
  if (!window) return null;
  const usedPercent = asNumber(window.usedPercent ?? window.used_percent);
  if (usedPercent === undefined) return null;
  return {
    used_percent: usedPercent,
    window_minutes: asNumber(window.windowDurationMins ?? window.window_minutes) ?? null,
    resets_at: asNumber(window.resetsAt ?? window.resets_at) ?? null,
  };
}

/** Maps the app-server camelCase payload and historical JSONL snake_case
 * payload into the single browser-facing shape. */
export function normalizeCodexRateLimits(payload: unknown): CodexRateLimits | null {
  const root = asRecord(payload);
  if (!root) return null;
  const buckets = asRecord(root.rateLimitsByLimitId ?? root.rate_limits_by_limit_id);
  const bucket = asRecord(buckets?.codex) ?? asRecord(root.rateLimits ?? root.rate_limits) ?? root;
  const primary = normalizeWindow(bucket.primary);
  const secondary = normalizeWindow(bucket.secondary);
  const rawCredits = asRecord(bucket.credits);
  const credits = rawCredits ? {
    has_credits: rawCredits.hasCredits ?? rawCredits.has_credits,
    unlimited: rawCredits.unlimited,
    balance: typeof rawCredits.balance === 'string' ? rawCredits.balance : null,
  } : null;
  if (!primary && !secondary && !bucket.planType && !bucket.plan_type && !credits) return null;
  return {
    primary,
    secondary,
    credits,
    plan_type: typeof (bucket.planType ?? bucket.plan_type) === 'string'
      ? bucket.planType ?? bucket.plan_type
      : null,
    limit_id: typeof (bucket.limitId ?? bucket.limit_id) === 'string'
      ? bucket.limitId ?? bucket.limit_id
      : null,
    limit_name: typeof (bucket.limitName ?? bucket.limit_name) === 'string'
      ? bucket.limitName ?? bucket.limit_name
      : null,
  };
}

/**
 * Calls Codex's read-only app-server account endpoint.  This does not create
 * a Codex thread or submit a prompt, unlike `codex exec`.
 */
export async function readCodexLiveRateLimits(
  codexPath: string,
  timeoutMs = 15_000,
): Promise<CodexLiveRateLimits> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(codexPath, ['app-server', '--stdio'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });
    } catch (error) {
      reject(error);
      return;
    }

    let settled = false;
    let stdout = '';
    let stderr = '';
    const finish = (result?: CodexLiveRateLimits, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      if (error) reject(error);
      else if (result) resolve(result);
    };
    const fail = (message: string) => finish(undefined, new Error(message));
    const send = (id: number, method: string, params: unknown) => {
      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    };
    const notify = (method: string, params?: unknown) => {
      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })}\n`);
    };
    const rpcErrorDetail = (error: unknown) => {
      const record = asRecord(error);
      const code = record && (typeof record.code === 'number' || typeof record.code === 'string') ? `code ${record.code}` : '';
      const message = record && typeof record.message === 'string' ? record.message : '';
      return [code, message].filter(Boolean).join(': ') || '알 수 없는 앱서버 오류';
    };
    const timeout = setTimeout(() => fail('Codex 실시간 한도 조회 시간이 초과되었습니다.'), timeoutMs);

    child.on('error', error => finish(undefined, error));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', chunk => {
      stdout += String(chunk);
      let newline = stdout.indexOf('\n');
      while (newline >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        newline = stdout.indexOf('\n');
        if (!line) continue;
        let message: any;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          if (message.error) {
            fail(`Codex 앱서버 초기화가 거부되었습니다 (${rpcErrorDetail(message.error)}).`);
            return;
          }
          // Kept separate from the initialize request for compatibility with
          // current and future app-server protocol versions.
          notify('initialized');
          send(2, 'account/rateLimits/read', null);
          continue;
        }
        if (message.id !== 2) continue;
        if (message.error) {
          fail(`Codex 실시간 한도 조회를 거부했습니다 (${rpcErrorDetail(message.error)}).`);
          return;
        }
        const rateLimits = normalizeCodexRateLimits(message.result);
        if (!rateLimits) {
          fail('Codex 앱서버 응답에 한도 정보가 없습니다.');
          return;
        }
        finish({ rateLimits, checkedAt: new Date().toISOString() });
      }
    });
    child.on('exit', code => {
      if (!settled) {
        const detail = stderr.trim() || `exit ${code ?? 'unknown'}`;
        fail(`Codex 실시간 한도 조회를 시작하지 못했습니다 (${detail.slice(0, 180)}).`);
      }
    });

    send(1, 'initialize', {
      clientInfo: { name: 'AgentsToZ_byCS', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
  });
}
