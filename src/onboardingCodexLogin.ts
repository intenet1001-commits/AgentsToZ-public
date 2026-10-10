export const CODEX_LOGIN_RECIPE='codex-browser-login-v1';
export type CodexLoginState='ready-to-login'|'authenticating'|'configured'|'needs-review'|'storage-review'|'cancelled';
export interface CodexLoginReceipt {
 schema:1;recipe:string;id:string;revision:string;state:CodexLoginState;
 checkedAt:string;updatedAt:string;ownerPid:number|null;guardPid:number|null;
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function parseCodexLoginReceipt(value:unknown):CodexLoginReceipt{
 const r=value as CodexLoginReceipt;
 if(!r||typeof r!=='object'||r.schema!==1||typeof r.recipe!=='string'||r.recipe.length>80||!uuid.test(r.id)||!uuid.test(r.revision)
  ||!['ready-to-login','authenticating','configured','needs-review','storage-review','cancelled'].includes(r.state)
  ||![r.checkedAt,r.updatedAt].every(t=>typeof t==='string'&&Number.isFinite(Date.parse(t)))
  ||![r.ownerPid,r.guardPid].every(p=>p===null||(Number.isSafeInteger(p)&&p!>1))
  ||Object.keys(r).sort().join(',')!=='checkedAt,guardPid,id,ownerPid,recipe,revision,schema,state,updatedAt')throw new Error('로그인 기록 확인 필요');
 return r;
}
/** The URL is private process memory only, never a request argument or status DTO. */
export function isCodexLoginUrl(value:string):boolean{
 if(value.length>4096||/[\x00-\x20\x7f]/.test(value))return false;
 try{
  const u=new URL(value),p=u.searchParams;
  const allowed=['response_type','client_id','redirect_uri','scope','code_challenge','code_challenge_method','id_token_add_organizations','codex_cli_simplified_flow','state','originator'];
  return u.origin==='https://auth.openai.com'&&!u.username&&!u.password&&!u.hash&&u.pathname==='/oauth/authorize'
   &&[...p.keys()].every(k=>allowed.includes(k)&&p.getAll(k).length===1)
   &&p.get('scope')==='openid profile email offline_access api.connectors.read api.connectors.invoke'
   &&p.get('response_type')==='code'&&p.get('client_id')==='app_EMoamEEZ73f0CkXaXp7hrann'
   &&p.get('redirect_uri')==='http://localhost:1455/auth/callback'
   &&p.get('code_challenge_method')==='S256'&&/^[A-Za-z0-9_-]{43}$/.test(p.get('code_challenge')??'')
   &&/^[A-Za-z0-9_-]{43}$/.test(p.get('state')??'');
 }catch{return false;}
}
export const CODEX_LOGIN_LABELS:Record<CodexLoginState,string>={
 'ready-to-login':'로그인을 시작할 수 있습니다',authenticating:'브라우저에서 로그인을 마쳐 주세요',
 configured:'로그인 정보 확인 · 첫 응답으로 연결을 확인하세요',
 'needs-review':'로그인 결과를 다시 확인해 주세요',
 'storage-review':'로그인 정보 파일의 보호 상태를 확인해 주세요',cancelled:'로그인은 나중에 이어갈 수 있습니다',
};
