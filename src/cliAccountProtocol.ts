/** Public metadata only. Credentials, directories and provider output never cross this boundary. */
export const CLI_ACCOUNT_AGENTS = ['codex', 'claude'] as const;
export type CliAccountAgent = typeof CLI_ACCOUNT_AGENTS[number];
export const HOST_CLI_ACCOUNT_ID = 'host-default';
export const CLI_ACCOUNT_MAX_PROFILES = 24;
export interface CliAccountSummary {
  id: string;
  agent: CliAccountAgent;
  label: string;
  authState: 'signed-in' | 'signed-out' | 'unknown';
  checkedAt: string | null;
  loginState: 'idle' | 'authenticating' | 'failed';
}
export interface CliAccountSelection {
  agent: CliAccountAgent;
  items: CliAccountSummary[];
  selectedAccountId: string;
}
export type CliAccountAdminRequest =
  | { operation: 'list'; agent: CliAccountAgent }
  | { operation: 'create'; agent: CliAccountAgent; label: string; requestId: string }
  | { operation: 'check' | 'login' | 'cancel-login' | 'archive'; accountId: string; requestId: string }
  | { operation: 'rename'; accountId: string; label: string; requestId: string };
export const cliAccountId = (v: unknown): v is string => v === HOST_CLI_ACCOUNT_ID || typeof v === 'string' && /^acct_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
export const cliAccountAgent = (v: unknown): v is CliAccountAgent => CLI_ACCOUNT_AGENTS.includes(v as CliAccountAgent);
export const cliAccountLabel = (v: unknown): v is string => typeof v === 'string' && v === v.trim() && v.length > 0 && v.length <= 64 && !/[\x00-\x1f\x7f]/.test(v);
const requestId = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_-]{8,160}$/.test(v);
export function normalizeCliAccountAdminRequest(value: unknown): CliAccountAdminRequest {
  const r = value as CliAccountAdminRequest;
  const fields: Record<CliAccountAdminRequest['operation'], string[]> = {
    list: ['agent'], create: ['agent', 'label', 'requestId'], check: ['accountId', 'requestId'],
    login: ['accountId', 'requestId'], 'cancel-login': ['accountId', 'requestId'], archive: ['accountId', 'requestId'], rename: ['accountId', 'label', 'requestId'],
  };
  if (!r || typeof r !== 'object' || Array.isArray(r) || !Object.hasOwn(fields, r.operation)
    || Object.keys(r).some(k => k !== 'operation' && !fields[r.operation].includes(k))
    || ('agent' in r && !cliAccountAgent(r.agent)) || ('accountId' in r && !cliAccountId(r.accountId))
    || ('label' in r && !cliAccountLabel(r.label)) || (r.operation !== 'list' && !requestId(r.requestId))) throw new Error('계정 관리 요청 형식을 확인하세요.');
  if ((r.operation === 'list' || r.operation === 'create') && !cliAccountAgent(r.agent)
    || r.operation === 'create' && !cliAccountLabel(r.label)
    || !['list', 'create'].includes(r.operation) && !cliAccountId((r as {accountId?: string}).accountId)
    || r.operation === 'rename' && !cliAccountLabel(r.label)) throw new Error('계정 관리 요청 형식을 확인하세요.');
  return {...r};
}
export function normalizeCliAccountSummary(value: unknown): CliAccountSummary {
  const s = value as CliAccountSummary;
  if (!s || typeof s !== 'object' || Array.isArray(s) || Object.keys(s).some(k => !['id','agent','label','authState','checkedAt','loginState'].includes(k))
    || !cliAccountId(s.id) || !cliAccountAgent(s.agent) || !cliAccountLabel(s.label)
    || !['signed-in','signed-out','unknown'].includes(s.authState) || !['idle','authenticating','failed'].includes(s.loginState)
    || !(s.checkedAt === null || typeof s.checkedAt === 'string' && s.checkedAt.length <= 40 && Number.isFinite(Date.parse(s.checkedAt)))) throw new Error('계정 응답 형식을 확인하세요.');
  return {...s};
}
export function normalizeCliAccountSelection(value: unknown): CliAccountSelection {
  const r = value as CliAccountSelection;
  if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).some(k => !['agent','items','selectedAccountId'].includes(k))
    || !cliAccountAgent(r.agent) || !Array.isArray(r.items) || !r.items.length || r.items.length > CLI_ACCOUNT_MAX_PROFILES + 1 || !cliAccountId(r.selectedAccountId)) throw new Error('계정 선택 응답 형식을 확인하세요.');
  const items = r.items.map(normalizeCliAccountSummary);
  if (items.some(s => s.agent !== r.agent) || new Set(items.map(s => s.id)).size !== items.length || !items.some(s => s.id === r.selectedAccountId)) throw new Error('계정 선택 응답 형식을 확인하세요.');
  return {...r, items};
}
