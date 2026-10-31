import {generatedHookSubpath,unixActivityHookCommand} from './projectMemoryActivityHook';
export const RECOVERY_HOOK_MARKER='AGENTSTOZ_PRECOMPACTION_RECOVERY';
export const RECOVERY_HOOK_REL='.agent-memory/recovery-hook.py';
/** Metadata only; no provider stdout, prompt, tool result, token or secret is
 * copied into a request/log. Failure never stops or restarts the user's agent. */
export function recoveryHookScript(){return `#!/usr/bin/env python3
# ${RECOVERY_HOOK_MARKER}
import json, sys, urllib.request, urllib.error
try:
    raw = sys.stdin.buffer.read(65537)
    if len(raw) > 65536:
        raise ValueError('hook metadata too large')
    value = json.loads(raw)
    agent, event = sys.argv[1:3]
    if agent == 'agy':
        roots = value.get('workspacePaths')
        if not isinstance(roots, list) or len(roots) != 1:
            raise ValueError('ambiguous workspace')
        payload = dict(agent=agent, event='periodic', cwd=roots[0], sessionId=value.get('conversationId'), workspacePaths=roots)
    else:
        payload = dict(agent=agent, event=event, cwd=value.get('cwd'), sessionId=value.get('session_id'))
    request = urllib.request.Request('http://127.0.0.1:3001/api/project-memory/pre-compaction',
        data=json.dumps(payload).encode('utf-8'), headers={'Content-Type': 'application/json'}, method='POST')
    # Do not inherit system HTTP proxies or follow redirects with local metadata.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs): return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(request, timeout=1 if payload['event'] == 'periodic' else 8) as response:
        receipt = json.loads(response.read(16385))
        if event == 'pre-compaction' and receipt.get('localCheckpointSaved') is True:
            print('AgentsToZ: encrypted recovery fragment saved; project memory and cloud backup are separate.', file=sys.stderr)
except Exception:
    print('AgentsToZ: recovery checkpoint not confirmed; check the local saving status.', file=sys.stderr)
`;
}
export function recoveryHookCommand(agent:'codex'|'claude'|'agy',subpath:string,event:'pre-compaction'|'periodic'){
  return unixActivityHookCommand(agent,subpath)
    .replaceAll('AGENTSTOZ_PROJECT_MEMORY_ACTIVITY',RECOVERY_HOOK_MARKER)
    .replaceAll('.agent-memory/activity-hook.sh',RECOVERY_HOOK_REL)
    .replace(`/bin/sh "$hook" ${agent}`,`python3 "$hook" ${agent} ${event}`);
}
/** True only for a command recoveryHookCommand would have generated, byte for byte (any subpath). */
export function isAgentsToZRecoveryHookCommand(command:string,agent:'codex'|'claude'|'agy',event:'pre-compaction'|'periodic'){
  const subpath=generatedHookSubpath(command);
  return subpath!==null&&command===recoveryHookCommand(agent,subpath,event);
}

export function withRecoveryHook(existing:Record<string,any>,agent:'codex'|'claude'|'agy',subpath:string):Record<string,any>{
  if(agent==='agy'){
    const prior=existing['agentstoz-recovery'];
    if(prior!==undefined&&(!prior||typeof prior!=='object'||Array.isArray(prior)))throw Error('기존 Antigravity 복구 훅 설정을 확인하세요.');
    const preserved=(Array.isArray(prior?.PreInvocation)?prior.PreInvocation:[])
      .filter((hook:any)=>typeof hook?.command!=='string'||!hook.command.includes(RECOVERY_HOOK_MARKER));
    return {...existing,'agentstoz-recovery':{...prior,PreInvocation:[...preserved,{type:'command',command:recoveryHookCommand(agent,subpath,'periodic'),timeout:10}]}};
  }
  const hooks={...existing.hooks};
  for(const [event,phase] of [['PreCompact','pre-compaction'],['Stop','periodic']] as const){
    const rows=Array.isArray(hooks[event])?hooks[event]:[];
    const preserved=rows.flatMap((entry:any)=>{
      if(!entry||typeof entry!=='object'||!Array.isArray(entry.hooks))return [entry];
      const handlers=entry.hooks.filter((h:any)=>typeof h?.command!=='string'||!h.command.includes(RECOVERY_HOOK_MARKER));
      return handlers.length?[{...entry,hooks:handlers}]:[];
    });
    hooks[event]=[...preserved,{hooks:[{type:'command',command:recoveryHookCommand(agent,subpath,phase),timeout:10}]}];
  }
  return {...existing,hooks};
}
