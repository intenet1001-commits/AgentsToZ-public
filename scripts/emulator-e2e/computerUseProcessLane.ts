/** J3A: real MCP process -> fixture A route -> PGlite mailbox -> independent fixture B -> fake Control.
 * Not evidence for installed sidecar, signing, native Control or the OS desktop. */
import {mkdirSync, readFileSync, writeFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes, randomUUID} from 'node:crypto';
import type {LaneContext, LaneDefinition} from '../emulator-e2e';
import type {LaneOutcome, PathLabels} from './evidence';
import {sandboxedArgv,listeningSockets} from './sandbox';
import {reserveLoopbackPort, trackChild} from './isolatedSidecar';

const labels:PathLabels={real:['MCP stdio server and its explicitly addressed loopback route','two independent sandboxed fixture processes using production remote sidecar, encrypted protocol, AgentDialogueHost and ComputerUseRuntime','canonical dialogue SQL through sandboxed PGlite Supabase shim'],
  standIn:['two source fixture hosts: not installed sidecars; installed binary and signed Main admission are injected facts','fake Control and synthetic display, signed by an in-memory fixture key; no OS input or capture','fixture control profile, device identities and scripted standing approval; no Keychain','no live Supabase, native Control or actual desktop']};

/** The database independently proves that A's requests were each taken and answered by B exactly once. */
export function judgeComputerUseAudit(dump:any,from:string,to:string):string[]{
  const rows=Array.isArray(dump?.audit?.dialogue_controls)?dump.audit.dialogue_controls:[];
  const inserts=rows.filter((r:any)=>r.event==='insert'&&r.request_kind==='computer-use'&&r.from_endpoint_id===from&&r.to_endpoint_id===to);
  const errors:string[]=[];if(inserts.length<6)errors.push(`only ${inserts.length} computer-use rows from A to B`);
  for(const row of inserts){const events=rows.filter((r:any)=>r.control_id===row.control_id);
    if(events.filter((r:any)=>r.state==='taken').length!==1||events.filter((r:any)=>r.state==='done').length!==1)errors.push('a computer-use row was not taken and answered exactly once');}
  return errors;
}

export const lane:LaneDefinition={id:'j3a-process',title:'J3A fixture processes — MCP → mailbox → fake Control (not installed app)',async run(ctx:LaneContext):Promise<LaneOutcome>{
  const children:Bun.Subprocess[]=[];let shim:Awaited<ReturnType<LaneContext['startSupabaseShim']>>|undefined;let result:LaneOutcome={status:'fail',reason:'fixture did not finish',labels};
  const details:Record<string,unknown>={};const fixtureRoots:string[]=[];const sandboxHashes:string[]=[];let endpoints:{from:string;to:string}|undefined;
  try{
    if(ctx.preflight.status!=='pass'||ctx.preflight.canaries?.passed!==true)throw Error('sandbox preflight and canaries must pass');
    shim=await ctx.startSupabaseShim({label:'j3a-process',https:false});
    if(!shim.ready.httpUrl)throw Error('shim HTTP unavailable');
    const shared=randomUUID(),token=randomBytes(32).toString('hex'),devices=[randomUUID(),randomUUID()];
    const hosts=[] as {pid:number;port:number;endpoint:string;device:string}[];
    const profiles=[] as ReturnType<LaneContext['isolatedProfile']>[];
    for(const [index,role] of ['b','a'].entries()){
      const profile=ctx.isolatedProfile(`j3a-${role}`);profiles.push(profile);fixtureRoots.push(profile.root);
      const port=reserveLoopbackPort(),sandbox=ctx.sandboxProfile(`j3a-${role}`,{allowedLoopbackPorts:shim.loopbackPorts});
      if(!sandbox.deniedPorts.includes(3001)||sandbox.allowedLoopbackPorts.includes(3001))throw Error('3001 sandbox refusal missing');sandboxHashes.push(sandbox.sha256);
      const config={role,profile:shared,device:devices[index],token,port,shim:shim.ready.httpUrl,serviceKey:shim.credentials().serviceRoleKey,scratch:profile.root};
      const configPath=join(profile.root,'config.json');writeFileSync(configPath,JSON.stringify(config),{mode:0o600});
      const child=Bun.spawn(sandboxedArgv(sandbox,[process.execPath,'--env-file=/dev/null',join(ctx.repoRoot,'scripts/emulator-e2e/computerUseProcessFixture.ts'),configPath]),{
        cwd:ctx.repoRoot,env:ctx.allowlistedEnv({profile}),stdin:'ignore',stdout:'ignore',stderr:'pipe'});trackChild(child);children.push(child);
      const stderr=new Response(child.stderr).text();const ready=join(profile.root,'ready.json');const deadline=Date.now()+90000;
      while(!existsSync(ready)&&child.exitCode===null&&Date.now()<deadline)await Bun.sleep(100);
      if(!existsSync(ready)){if(child.exitCode===null)child.kill('SIGKILL');await child.exited;throw Error(`fixture ${role} failed before ready: ${(await stderr).slice(0,600)}`);}
      const host=JSON.parse(readFileSync(ready,'utf8'));if(host.pid!==child.pid||host.port!==port||host.sandboxed!==true)throw Error(`fixture ${role} readiness mismatch`);
      hosts.push(host);
    }
    const [b,a]=hosts;if(!a||!b||a.pid===b.pid||a.device===b.device)throw Error('two independent fixture hosts required');endpoints={from:a.endpoint,to:b.endpoint};
    // MCP uses only its own app data and an explicit, non-reserved fixture A endpoint.
    const profile=ctx.isolatedProfile('j3a-mcp');mkdirSync(join(profile.appDataDir,'control-profile'),{recursive:true,mode:0o700});
    writeFileSync(join(profile.appDataDir,'control-profile/access.json'),JSON.stringify({schemaVersion:1,profileId:shared,token}),{mode:0o600});
    const mcpProfile=ctx.sandboxProfile('j3a-mcp',{allowedLoopbackPorts:[a.port]});
    if(!mcpProfile.deniedPorts.includes(3001)||mcpProfile.allowedLoopbackPorts.includes(3001))throw Error('MCP sandbox does not deny 3001');sandboxHashes.push(mcpProfile.sha256);
    const assertFixtureListener=()=>{const seen=listeningSockets(a.pid);if(!seen.some(socket=>socket.address==='127.0.0.1'&&socket.port===a.port)||seen.some(socket=>socket.address!=='127.0.0.1'))throw Error('fixture A no longer owns its loopback listener');};
    assertFixtureListener();
    const endpoint=`http://127.0.0.1:${a.port}/api/agentstoz-use/action`;
    const mcp=Bun.spawn(sandboxedArgv(mcpProfile,[process.execPath,'--env-file=/dev/null',join(ctx.repoRoot,'agentstoz-use-mcp-server.ts')]),{
      cwd:ctx.repoRoot,env:ctx.allowlistedEnv({profile,laneOverrides:{AGENTSTOZ_USE_ENDPOINT:endpoint}}),stdin:'pipe',stdout:'pipe',stderr:'pipe'});
    trackChild(mcp);children.push(mcp);if([a.pid,b.pid].includes(mcp.pid))throw Error('MCP and hosts are not independent processes');
    const reader=mcp.stdout.getReader(),decoder=new TextDecoder();let buffer='',id=0;
    const call=async(method:string,params:Record<string,unknown>)=>{
      assertFixtureListener();const requestId=++id;mcp.stdin.write(JSON.stringify({jsonrpc:'2.0',id:requestId,method,params})+'\n');mcp.stdin.flush();
      const deadline=Date.now()+50000;
      while(Date.now()<deadline){
        const at=buffer.indexOf('\n');if(at>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);const value=JSON.parse(line);if(value.id!==requestId)continue;
          if(value.error||value.result?.isError)throw Error(`MCP ${method}: ${JSON.stringify(value.error??value.result).slice(0,500)}`);return value.result;}
        let timer:ReturnType<typeof setTimeout>|undefined;let chunk:Awaited<ReturnType<typeof reader.read>>;try{chunk=await Promise.race([reader.read(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('MCP timeout')),50000);})]);}finally{clearTimeout(timer);}
        if(chunk.done)throw Error('MCP ended');buffer+=decoder.decode(chunk.value,{stream:true});
      }throw Error('MCP timeout');
    };
    await call('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'j3a-fixture',version:'1'}});
    const session=async(input:Record<string,unknown>)=>(await call('tools/call',{name:'agentstoz_use_computer_session',arguments:input})).structuredContent;
    const status=await session({operation:'status',device:b.device});if(status.success!==true)throw Error('remote status failed');
    const access=await session({operation:'request-access',device:b.device});if(access.state!=='granted')throw Error(`access ${JSON.stringify(access).slice(0,300)}`);
    const current=await session({operation:'status',device:b.device});const grant=current.grants?.[0];if(!grant)throw Error('no grant');
    const observed=await session({operation:'observe',device:b.device,grant:grant.grant,epoch:grant.epoch,capture:true});if(!observed.observationId||!observed.image)throw Error('synthetic observation missing');
    const click=await session({operation:'click',device:b.device,grant:grant.grant,epoch:grant.epoch,observationId:observed.observationId,displayId:'display_1',requestId:'j3a-click-0001',x:10,y:10,button:'left',clickCount:1});
    if(click.receipt?.state!=='confirmed')throw Error('fixture click receipt missing');
    const log=readFileSync(join(profiles[0]!.root,'control.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
    if(log.filter(row=>row.operation==='scope-click'&&row.requestId==='j3a-click-0001').length!==1)throw Error('fixture did not record exactly one click');
    const wire=readFileSync(join(profiles[1]!.root,'rpc.log'),'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(row=>row.envelope==='call');
    if(wire.length<5||wire.some(row=>!row.hasBox||row.containsSentinel))throw Error('mailbox did not receive sealed calls');
    details.sealedCallCount=wire.length;
    assertFixtureListener();details.hosts=hosts;details.mcpPid=mcp.pid;details.sandboxHashes=sandboxHashes;details.preflightCanariesPassed=true;details.explicitMcpEndpoint=true;details.forbiddenPort3001='excluded from generated sandbox outbound allowlists';details.operations=log.map(row=>row.operation);details.receipt=click.receipt;
    result={status:'pass',labels,details};
  }catch(error){result={status:'fail',reason:(error as Error).message.slice(0,1200),labels,details};}
  details.controlLogs=fixtureRoots.map(root=>existsSync(join(root,'control.jsonl'))?readFileSync(join(root,'control.jsonl'),'utf8').slice(-5000):'');
  details.rpcLogs=fixtureRoots.map(root=>existsSync(join(root,'rpc.log'))?readFileSync(join(root,'rpc.log'),'utf8').slice(-5000):'');
  for(const child of children.reverse()){if(child.exitCode===null){child.kill('SIGTERM');const done=await Promise.race([child.exited,Bun.sleep(8000).then(()=>null)]);if(done===null){child.kill('SIGKILL');await child.exited;}}}
  if(shim){await shim.stop();const problems=shim.problems();
    if(result.status==='pass'){const db=join(shim.evidenceDir,'dialogue-db.json');if(!existsSync(db)||!endpoints)problems.push('missing independent mailbox evidence');else problems.push(...judgeComputerUseAudit(JSON.parse(readFileSync(db,'utf8')),endpoints.from,endpoints.to));}
    if(problems.length)result={status:'fail',reason:problems.join('; '),labels,details};}
  ctx.evidence.writeJson('j3a-process/summary.json',result);
  return {...result,artifacts:['j3a-process/summary.json','supabase-shim/j3a-process/dialogue-db.json','supabase-shim/j3a-process/supabase-shim-report.json']};
}};
