export class PlatformCliError extends Error {}
export const platformCliPublicError = (error:unknown):string => error instanceof PlatformCliError ? error.message : 'CLI 계정·프로젝트 상태를 확인하지 못했습니다. 같은 요청의 결과를 확인한 뒤 다시 시도하세요.';
/** Public account metadata. Credentials never belong in this protocol's responses. */
export const PLATFORM_CLI_PATH = '/api/agent-runtime/platform-cli';
export const PLATFORM_CLI_PROVIDERS = ['github', 'vercel', 'supabase', 'google-workspace'] as const;
export type PlatformCliProvider = typeof PLATFORM_CLI_PROVIDERS[number];
export type PlatformCliAccountPurpose = 'project-cli' | 'app-sync-account';
export function platformCliAccountPurpose(value:unknown,provider:PlatformCliProvider):PlatformCliAccountPurpose {
  if(value===undefined||value==='project-cli')return 'project-cli';
  if(value==='app-sync-account'&&provider==='supabase')return value;
  throw new PlatformCliError('계정 연결 용도를 확인하세요.');
}
export const PLATFORM_CLI_LABELS: Record<PlatformCliProvider, string> = {github: 'GitHub', vercel: 'Vercel', supabase: 'Supabase', 'google-workspace': 'Google Workspace'};
export interface PlatformCliAccount {id: string; provider: PlatformCliProvider; label: string; identity: string | null; state: 'unchecked' | 'ready' | 'login-required'; revision: string; source?: 'managed'|'native'|'default'; active?:boolean; verifiedEmail?:string}
export interface PlatformCliDeviceDefault {email:string; accountId:string|null}
export type PlatformCliDeviceDefaults = Partial<Record<PlatformCliProvider,PlatformCliDeviceDefault>>;
export function platformCliEmail(value:unknown):string {
  const email=platformCliText(value,120).toLowerCase();
  if(!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email))throw new PlatformCliError('계정 이메일을 확인하세요.');
  return email;
}
export interface PlatformCliBinding {accountId: string; scope: string; resourceId: string}
export const PLATFORM_CLI_DEFAULT_ACCOUNT = 'pcli_default';
export const platformCliManagedId = (v: unknown): v is string => typeof v === 'string' && /^pcli_[0-9a-f-]{36}$/.test(v);
export const platformCliNativeGithubId = (login:string) => 'pcli_gh_' + login.toLowerCase();
export const platformCliNativeGithubLogin = (id:string):string|null => /^pcli_gh_[a-z0-9-]{1,39}$/.test(id) ? id.slice(8) : null;
export const platformCliProvider = (v: unknown): v is PlatformCliProvider => PLATFORM_CLI_PROVIDERS.includes(v as PlatformCliProvider);
export const platformCliId = (v: unknown): v is string => typeof v === 'string' && (platformCliManagedId(v)||v===PLATFORM_CLI_DEFAULT_ACCOUNT||platformCliNativeGithubLogin(v)!==null);
export function platformCliText(v: unknown, max = 120): string {
  if (typeof v !== 'string' || v !== v.trim() || v.length > max || /[\x00-\x1f\x7f]/.test(v)) throw new PlatformCliError('CLI 설정 값을 확인하세요.');
  return v;
}
export function platformCliRequestId(v: unknown): string {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{8,160}$/.test(v)) throw new PlatformCliError('CLI 요청 ID를 확인하세요.');
  return v;
}
export function platformCliBinding(value: unknown): PlatformCliBinding {
  const b = value as PlatformCliBinding;
  if (!b || typeof b !== 'object' || Object.keys(b).some(k => !['accountId','scope','resourceId'].includes(k)) || !platformCliId(b.accountId)) throw new PlatformCliError('연결할 CLI 계정을 선택하세요.');
  const scope = platformCliText(b.scope), resourceId = platformCliText(b.resourceId);
  if ([scope,resourceId].some(v => v && !/^[A-Za-z0-9][A-Za-z0-9_.@/-]{0,119}$/.test(v))) throw new PlatformCliError('CLI 팀·프로젝트 식별자를 확인하세요.');
  return {accountId:b.accountId,scope,resourceId};
}
