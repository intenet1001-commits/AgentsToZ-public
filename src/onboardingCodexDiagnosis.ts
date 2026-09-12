import type {OnboardingToolDiagnostic} from './onboardingInfrastructure';
/** Newly installed user-local tools need not be in an already-open shell's PATH. */
export function codexLoginCommand(platform:'mac'|'linux'|'windows'):string {
 return platform==='windows'?'codex login':'if command -v codex >/dev/null 2>&1; then codex login; else "$HOME/.local/bin/codex" login; fi';
}
/** CLI login status reports cached credentials, not a successful model request.
 * Raw output may include API-key details and must never leave this classifier. */
export function diagnoseCodexLogin(probe:{ok:boolean;output:string;timedOut:boolean}):Pick<OnboardingToolDiagnostic,'state'|'authenticated'|'authenticationEvidence'|'detail'>{
 if(!probe.timedOut&&probe.ok&&/^Logged in using (?:ChatGPT|an API key)(?:\s|$)/.test(probe.output.trim()))return {
  state:'ready',authenticationEvidence:'cached',detail:'저장된 Codex 로그인 정보를 확인했습니다. 실제 연결과 권한은 첫 작업에서 확인합니다.',
 };
 if(!probe.timedOut&&!probe.ok&&/^Not logged in[.!]?$/i.test(probe.output.trim()))return {state:'needs-login',authenticated:false,detail:'Codex 로그인이 필요합니다.'};
 return {state:'unknown',detail:'Codex 로그인 상태를 확인하지 못했습니다. 기존 로그인 정보를 유지하고 다시 확인하세요.'};
}
