import {chmodSync,mkdirSync,mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startTestApiServer} from '../startTestApiServer';
import {handleAgentsToZUseMcpRequest} from '../../agentstoz-use-mcp-server';

/** Real API, MCP stdio adapter and native PTYs; fake provider login never opens a real browser or touches credentials. */
export async function createCliAccountsApiFixture() {
  const home=realpathSync(mkdtempSync(join(tmpdir(),'atz-account-api-'))),data=join(home,'app-data'),project=join(home,'project'),otherProject=join(home,'other-project'),bin=join(home,'.local','bin');
  mkdirSync(data);mkdirSync(project);mkdirSync(otherProject);mkdirSync(bin,{recursive:true});
  if(!Bun.spawnSync(['git','init','-q',project]).success)throw Error('Fixture Git init failed');
  if(!Bun.spawnSync(['git','init','-q',otherProject]).success)throw Error('Other fixture Git init failed');
  writeFileSync(join(data,'ports.json'),JSON.stringify([{id:'account-project',name:'Account fixture',folderPath:project},{id:'account-project-other',name:'Other account fixture',folderPath:otherProject}]));
  for(const agent of ['codex','claude']) {
    const script=`#!/bin/sh
dir="\${CODEX_HOME:-\${CLAUDE_CONFIG_DIR:-$HOME/default}}"
login=0; status=0
for arg in "$@"; do [ "$arg" = login ] && login=1; [ "$arg" = status ] && status=1; done
if [ "$status" = 1 ]; then
  if [ -f "$dir/signed-in" ]; then ${agent==='codex'?"echo 'Logged in using ChatGPT'":"echo '{\"loggedIn\":true,\"authMethod\":\"claude.ai\",\"email\":\"private@example.invalid\"}'"};exit 0;
  else ${agent==='codex'?"echo 'Not logged in' >&2":"echo '{\"loggedIn\":false,\"authMethod\":null}'"};exit 1;fi
fi
if [ "$login" = 1 ]; then touch "$dir/signed-in";exit 0;fi
stty -echo
printf 'READY:${agent}:%s\\n' "\${dir##*/}"
while IFS= read -r line; do printf 'GOT:%s\\n' "$line";done
`;
    writeFileSync(join(bin,agent),script);chmodSync(join(bin,agent),0o755);
  }
  const env={...process.env,HOME:home,APP_DATA_DIR:data,NODE_ENV:'test',AGENTSTOZ_SKIP_CONTROL_BOOTSTRAP:'1',AGENTSTOZ_SKIP_OUTPUT_STYLE_SYNC:'1',AGENTSTOZ_SKIP_HERMES_SYNC:'1'};
  const {baseUrl,child}=await startTestApiServer({cwd:join(import.meta.dir,'../..'),env,entrypoint:'tests/fixtures/ops-surface-api.ts'});
  const post=async(path:string,body:unknown)=>{const r=await fetch(baseUrl+path,{method:'POST',headers:{'Content-Type':'application/json',...(path.startsWith('/api/agent-runtime/')?{Origin:'http://localhost:9000'}:{})},body:JSON.stringify(body)});return {status:r.status,body:await r.json() as any};};
  await post('/api/control-profile/prepare',{});
  const call=async(name:string,args:object)=>{
    const r=await handleAgentsToZUseMcpRequest({id:1,method:'tools/call',params:{name:'agentstoz_use_'+name,arguments:args}},{...env,AGENTSTOZ_USE_ENDPOINT:baseUrl+'/api/agentstoz-use/action'}) as any;
    return r.result.structuredContent??JSON.parse(r.result.content[0].text);
  };
  return {home,data,baseUrl,child,post,call,close:async()=>{child.kill();await child.exited;rmSync(home,{recursive:true,force:true});}};
}
