/** The two groups are deliberately independent: an AI executable is not a service login. */
export const MAC_SETUP_TOOLS = [
  {id:'codex-app', label:'Codex 앱', group:'앱', url:'https://developers.openai.com/codex/app/'},
  {id:'claude-app', label:'Claude 앱', group:'앱', url:'https://claude.com/download'},
  {id:'hermes-app', label:'Hermes 앱', group:'앱', url:'https://hermes-agent.nousresearch.com/desktop'},
  {id:'ego-app', label:'Ego Lite', group:'브라우저', url:'https://lite.ego.app/'},
  {id:'git', label:'Git', group:'기반 도구', url:'https://git-scm.com/download/mac'},
  {id:'node', label:'Node.js · npm', group:'기반 도구', url:'https://nodejs.org/en/download'},
  {id:'codex', label:'Codex CLI', group:'AI CLI', url:'https://developers.openai.com/codex/cli/'},
  {id:'claude', label:'Claude Code CLI', group:'AI CLI', url:'https://code.claude.com/docs/en/setup'},
  {id:'hermes', label:'Hermes CLI', group:'AI CLI', url:'https://hermes-agent.nousresearch.com/docs/getting-started/installation'},
  {id:'agy', label:'agy CLI', group:'AI CLI', url:'https://antigravity.google/docs/cli/install/'},
  {id:'github', label:'GitHub CLI', group:'서비스 CLI', url:'https://cli.github.com/'},
  {id:'vercel', label:'Vercel CLI', group:'서비스 CLI', url:'https://vercel.com/docs/cli'},
  {id:'supabase', label:'Supabase CLI', group:'서비스 CLI', url:'https://supabase.com/docs/guides/local-development/cli/getting-started'},
  {id:'google-workspace', label:'Google Workspace CLI', group:'서비스 CLI', url:'https://github.com/googleworkspace/cli'},
] as const;
export type MacSetupToolId = typeof MAC_SETUP_TOOLS[number]['id'];
export const MAC_SETUP_REQUIRED_SERVICES:readonly MacSetupToolId[] = ['github','supabase'];
export const MAC_SETUP_DEFAULT_SELECTION:MacSetupToolId[] = ['git','codex','claude',...MAC_SETUP_REQUIRED_SERVICES];
export type MacSetupState = 'unknown'|'missing'|'installed'|'running'|'checking'|'installing'|'needs-action'|'failed'|'cancelled';
export interface MacSetupRow {id:MacSetupToolId;state:MacSetupState;message:string;checkedAt?:number}
export interface MacSetupView {schemaVersion:1;recipe:1;revision:number;requestId:string|null;active:boolean;rows:MacSetupRow[];updatedAt:number}
export const macSetupToolId=(v:unknown):v is MacSetupToolId=>MAC_SETUP_TOOLS.some(t=>t.id===v);
export const macSetupPending=(v:MacSetupState)=>v==='checking'||v==='installing';
export function macSetupPrerequisites(selected:MacSetupToolId[]):MacSetupToolId[]{
  const ids=new Set(selected);
  if(selected.some(id=>['codex','claude','vercel','google-workspace'].includes(id)))ids.add('node');
  if(ids.has('hermes'))ids.add('git');
  return MAC_SETUP_TOOLS.filter(t=>ids.has(t.id)).map(t=>t.id);
}
export function macSetupHandoff(view:MacSetupView):string {
  return `AgentsToZ Mac 준비 이어가기 · recipe ${view.recipe} · revision ${view.revision}\n앱의 ‘내 기기와 연결 → Mac 준비’에서 최신 상태와 같은 요청 ${view.requestId??'없음'}의 결과부터 확인하세요.\n${view.rows.map(r=>`${MAC_SETUP_TOOLS.find(t=>t.id===r.id)!.label}: ${r.state}`).join('\n')}\n설치·실행·로그인·프로젝트 권한은 별도로 확인합니다. 기존 설정과 계정을 보존하고 OS 승인·비밀번호·2FA는 사용자가 직접 처리합니다. JSON·토큰·키·비밀번호를 채팅으로 요청하지 마세요. 앱 데이터 저장소·작업용 CLI 기본 계정·iPhone/웹 허용 이메일은 별개입니다. 진행 중이거나 결과가 불확실한 설치와 인증을 다시 시작하지 마세요.`;
}
