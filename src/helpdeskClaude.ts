import {accessSync,constants,realpathSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {homedir} from 'node:os';
import {macSetupCommand} from './macSetupEffects';
import type {HelpdeskConnection} from './helpdeskHost';

export const HELPDESK_CLAUDE_ARGS=['--print','--output-format','json','--safe-mode','--restricted','--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--disable-slash-commands','--no-session-persistence','--settings','{"disableAllHooks":true}'] as const;
/** Runs the published official CLI with the user's own authentication. No OAuth extraction or proxy billing. */
export function createHelpdeskClaude(options:{home?:string;searchPaths?:string[]}={}){
  const home=options.home??homedir();
  const paths=options.searchPaths??[join(home,'.local/bin'),join(home,'.local/share/agentstoz/tools/npm/bin'),...(process.env.PATH??'').split(':').filter(isAbsolute),'/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin'];
  const environment=()=>{
    const env:NodeJS.ProcessEnv={HOME:home,USER:process.env.USER,LOGNAME:process.env.LOGNAME,TMPDIR:process.env.TMPDIR,PATH:[...new Set(paths)].join(':'),LANG:'en_US.UTF-8',NO_COLOR:'1'};
    // Preserve official supported auth/provider choices; unrelated service credentials and app capabilities stay out.
    for(const [k,v] of Object.entries(process.env))if(/^(ANTHROPIC_|CLAUDE_CONFIG_DIR$|CLAUDE_CODE_USE_|AWS_|GOOGLE_APPLICATION_CREDENTIALS$|HTTPS?_PROXY$|NO_PROXY$)/.test(k))env[k]=v;
    return env;
  };
  const executable=()=>{for(const p of paths)try{const file=join(p,'claude');accessSync(file,constants.X_OK);return realpathSync(file);}catch{}return null;};
  async function check():Promise<HelpdeskConnection>{
    const exe=executable();if(!exe)return 'missing';
    // The official CLI returns exit 1 with loggedIn:false when it needs authentication.
    try{const auth=JSON.parse(await macSetupCommand(exe,['auth','status','--json'],environment(),undefined,20_000,true,[0,1]));if(auth.loggedIn===false)return 'signed-out';if(auth.loggedIn!==true)return 'unknown';const help=await macSetupCommand(exe,['--help'],environment());return ['--safe-mode','--restricted','--tools','--strict-mcp-config','--disable-slash-commands','--no-session-persistence'].every(flag=>help.includes(flag))?'ready':'unsupported';}catch{return 'unknown';}
  }
  return {check,
    async answer(prompt:string,signal:AbortSignal){
      const exe=executable();if(!exe||await check()!=='ready')throw Error('CLAUDE_LOGIN_REQUIRED');
      // Older CLIs must fail closed rather than silently dropping any safety option.
      const help=await macSetupCommand(exe,['--help'],environment(),signal);
      for(const flag of ['--safe-mode','--restricted','--tools','--strict-mcp-config','--disable-slash-commands','--no-session-persistence'])if(!help.includes(flag))throw Error('CLAUDE_UPDATE_REQUIRED');
      const result=JSON.parse(await macSetupCommand(exe,[...HELPDESK_CLAUDE_ARGS,'--',prompt],environment(),signal,120_000));
      if(result.is_error||typeof result.result!=='string')throw Error('CLAUDE_ANSWER_FAILED');return result.result;
    },
    async login(signal:AbortSignal){
      const exe=executable();if(!exe||await check()!=='signed-out')throw Error('CLAUDE_LOGIN_RECHECK');
      // Keep all official login choices. The browser handles passwords/2FA; no login output is retained.
      await macSetupCommand(exe,['auth','login'],environment(),signal,600_000,false);
    },
  };
}
