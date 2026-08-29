/** 공개 소스에 개인 포털 기본값을 넣지 않고, 사용자가 소유한 HTTPS 주소만 사용한다. */
export function normalizeHttpsPortalBaseUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

/** localhost API 통합 allowlist에는 경로 없는 HTTPS Origin 하나만 허용한다. */
export function normalizeHttpsExactOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.trim().toLowerCase() === 'null') return null;
  try {
    const raw = value.trim();
    if (!/^https:\/\/[^/?#\\]+\/?$/i.test(raw)) return null;
    const url = new URL(raw);
    if (
      url.protocol !== 'https:'
      || url.username
      || url.password
      || url.pathname !== '/'
      || url.search
      || url.hash
    ) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** 자동 배포 결과는 Vercel이 발급한 호스트만 portal.json에 신뢰해 보존한다. */
export function normalizeVercelPortalDeployUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    const hostname = url.hostname.toLowerCase();
    if (
      url.protocol !== 'https:'
      || url.username
      || url.password
      || url.port
      || url.pathname !== '/'
      || url.search
      || url.hash
      || hostname === 'vercel.app'
      || !hostname.endsWith('.vercel.app')
    ) return null;
    return url.origin;
  } catch {
    return null;
  }
}

const ANSI_ESCAPE_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const LABELED_VERCEL_URL_PATTERN = /\b(Aliased|Production):\s*(https:\/\/[a-zA-Z0-9.-]+\.vercel\.app\/?)/gi;

/**
 * `vercel deploy --prod`의 완료 결과만 받아 안정 alias를 우선 선택한다.
 * Vercel의 진행 로그에 섞인 Inspect/preview URL이나 다른 CLI 명령의 URL은 받지 않는다.
 */
export function selectVercelProductionPortalUrl(stdout: unknown, stderr: unknown): string | null {
  const clean = (value: unknown) => typeof value === 'string'
    ? value.replace(ANSI_ESCAPE_PATTERN, '')
    : '';
  const combined = `${clean(stdout)}\n${clean(stderr)}`;
  const labeled: Array<{ kind: string; url: string }> = [];
  for (const match of combined.matchAll(LABELED_VERCEL_URL_PATTERN)) {
    const normalized = normalizeVercelPortalDeployUrl(match[2]);
    if (normalized && match[1]) labeled.push({ kind: match[1].toLowerCase(), url: normalized });
  }

  // `Aliased:`는 다음 배포에도 유지되는 production hostname이고,
  // `Production:`은 그 배포의 검증된 production URL이다. 둘 다 없을 때만
  // Vercel 공식 계약인 stdout 단일 Deployment URL을 사용한다.
  return labeled.findLast(candidate => candidate.kind === 'aliased')?.url
    ?? labeled.findLast(candidate => candidate.kind === 'production')?.url
    ?? clean(stdout)
      .split(/\r?\n/)
      .map(line => normalizeVercelPortalDeployUrl(line.trim()))
      .filter((value): value is string => !!value)
      .at(-1)
    ?? null;
}

export function portalUrlWithParams(baseUrl: string, params: URLSearchParams): string {
  const url = new URL(baseUrl);
  url.search = params.toString();
  return url.toString();
}
