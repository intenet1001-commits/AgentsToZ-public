import {expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {resolveAppDataDir} from '../src/appDataDir';
import {testerRequestId,TESTER_ENDPOINT} from '../src/testerAgentContract';
import {startTestApiServer} from './startTestApiServer';
import {handleAgentsToZUseMcpRequest} from '../agentstoz-use-mcp-server';
import {REMOTE_CONTROL_PROTOCOL_VERSION} from '../src/remoteControlCore';

function message(socket:WebSocket,match:(v:any)=>boolean):Promise<any>{return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{socket.removeEventListener('message',onMessage);reject(Error('tester wire timeout'));},8000);
  const onMessage=(e:MessageEvent)=>{const v=JSON.parse(String(e.data));if(match(v)){clearTimeout(timer);socket.removeEventListener('message',onMessage);resolve(v);}};
  socket.addEventListener('message',onMessage);
});}

test('real tester API resolves registered projects, enforces local origin and executes the installed project runner',async()=>{
  const home=realpathSync(mkdtempSync(join(tmpdir(),'agentstoz-tester-api-')));
  const project=join(home,'project');mkdirSync(join(project,'tests'),{recursive:true});
  writeFileSync(join(project,'tests/test_core.py'),'import unittest\nclass Core(unittest.TestCase):\n def test_ok(self): self.assertEqual(1+1,2)\n');
  const env={...process.env,NODE_ENV:'test',HOME:home,APPDATA:join(home,'AppData'),XDG_CONFIG_HOME:join(home,'.config')};
  const data=resolveAppDataDir(process.platform,env,home);mkdirSync(data,{recursive:true});
  writeFileSync(join(data,'ports.json'),JSON.stringify([{id:'tester-project',name:'Tester fixture',aiName:'Generated alias',folderPath:project}]));
  writeFileSync(join(data,'workspace-roots.json'),'[]');
  let child:Bun.Subprocess|undefined;
  try{
    const fixture=await startTestApiServer({cwd:resolve(import.meta.dir,'..'),env,entrypoint:'tests/fixtures/agentstoz-use-api.ts'});child=fixture.child;
    const post=async(body:unknown,origin='http://localhost:9000',suffix='')=>{
      const response=await fetch(fixture.baseUrl+TESTER_ENDPOINT+suffix,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(body)});
      return {status:response.status,data:await response.json() as any};
    };
    const status={portId:'tester-project',operation:'status'};
    expect((await post(status,'https://unknown.example')).status).toBe(403);
    expect((await post(status,'http://localhost:9000','?path=/tmp')).status).toBe(403);
    expect((await post({...status,path:'/tmp'})).status).toBe(400);
    expect((await post({...status,portId:'unknown'})).data.success).toBe(false);
    expect((await post({...status,extra:'x'.repeat(9000)})).status).toBe(413);
    expect((await post(status)).data.status.installation).toBe('absent');
    const plan=(await post({...status,operation:'plan'})).data.plan;
    expect((await post({...status,operation:'apply',revision:plan.revision})).data.applied).toBe(true);
    const ready=(await post(status)).data.status;
    const started=(await post({...status,operation:'start',revision:ready.configurationRevision,profileId:'quick',requestId:testerRequestId()})).data.run;
    expect(started.id).toMatch(/^\d{8}T/);
    let done:any;
    for(let i=0;i<120;i++){
      done=(await post({...status,operation:'read',runId:started.id})).data.run;
      if(!['queued','starting','running','canceling'].includes(done.state))break;
      await Bun.sleep(50);
    }
    expect(done.state).toBe('passed');expect(done.report.checks[0].output).toContain('OK');
    expect(JSON.stringify(done)).not.toContain(home);
    const prepared=await fetch(fixture.baseUrl+'/api/control-profile/prepare',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>r.json()) as any;
    expect(prepared.success).toBe(true);expect(prepared.profile.state).toBe('ready');
    const mcp=await handleAgentsToZUseMcpRequest({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'agentstoz_use_read_tester_run',arguments:{portId:'tester-project',runId:started.id}}},{...env,APP_DATA_DIR:data,AGENTSTOZ_USE_ENDPOINT:fixture.baseUrl+'/api/agentstoz-use/action'});
    expect((mcp!.result as any).isError).toBe(false);expect((mcp!.result as any).structuredContent.tester.run.id).toBe(started.id);
    const local=async(path:string,body:unknown={})=>fetch(fixture.baseUrl+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://localhost:9000'},body:JSON.stringify(body)}).then(r=>r.json()) as Promise<any>;
    const overview=await local('/api/control-profile/tester-results');
    expect(overview.success).toBe(true);expect(overview.overview.entries.find((p:any)=>p.projectId==='tester-project').name).toBe('Tester fixture');expect(overview.overview.entries.find((p:any)=>p.projectId==='tester-project').run.id).toBe(started.id);
    const list=await handleAgentsToZUseMcpRequest({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'agentstoz_use_list_tester_results',arguments:{}}},{...env,APP_DATA_DIR:data,AGENTSTOZ_USE_ENDPOINT:fixture.baseUrl+'/api/agentstoz-use/action'});
    expect((list!.result as any).isError).toBe(false);
    const interfaces=await local('/api/remote-control/interfaces');
    expect(interfaces.interfaces.length).toBeGreaterThan(0);
    let socket:WebSocket|undefined;
    try{
      const enabled=await local('/api/remote-control/enable',{interfaceAddress:interfaces.interfaces[0].address});expect(enabled.enabled).toBe(true);
      const pair=await local('/api/remote-control/pairing/rotate');const url=new URL(pair.pairingUrl);
      const connect=async(payload:any,type:string)=>{
        const ws=new (WebSocket as any)(url.origin.replace('http:','ws:')+'/remote/ws',{headers:{Origin:url.origin}}) as WebSocket;
        socket=ws;const ready=message(ws,m=>m.type===type);
        ws.addEventListener('open',()=>ws.send(JSON.stringify({protocolVersion:REMOTE_CONTROL_PROTOCOL_VERSION,...payload})),{once:true});return ready;
      };
      const paired=await connect({type:'controller.pair',token:new URLSearchParams(url.hash.slice(1)).get('pair')},'session.ready');
      const capabilityId=crypto.randomUUID(),capability=message(socket!,m=>m.type==='action.result'&&m.actionId===capabilityId);
      socket!.send(JSON.stringify({type:'action.request',protocolVersion:REMOTE_CONTROL_PROTOCOL_VERSION,sessionToken:paired.sessionToken,actionId:capabilityId,action:'protocol.capabilities'}));
      expect((await capability).supportedFeatures).toContain('tester-v1');
      const targetId=paired.projects.find((p:any)=>p.name==='Tester fixture').controlId;
      const access=await local('/api/agent-runtime/terminals/access');const owner=access.connections[0].id;
      const grant=async(scopes:string[])=>{const v=await local('/api/agent-runtime/terminals/access',{owner,enabled:true,rememberDevice:true,targetIds:['tester-project'],workspaceScopes:scopes});expect(v.error).toBeUndefined();};
      const wire=async(workspace:any)=>{const requestId=crypto.randomUUID();const pending=message(socket!,m=>m.type==='terminal.result'&&m.requestId===requestId);socket!.send(JSON.stringify({type:'terminal.request',sessionToken:paired.sessionToken,request:{operation:'workspace',requestId,targetId,workspace}}));return pending;};
      await grant(['tester.read']);
      const read=await wire({action:'tester.status'});expect(read.ok).toBe(true);expect(read.body.tester.canRun).toBe(false);
      const start={action:'tester.start',profileId:'quick',revisionHash:read.body.tester.revision,testRequestId:testerRequestId()};
      expect((await wire(start)).ok).toBe(false);
      await grant(['tester.read','tester.run']);
      const admitted=await wire(start);expect(admitted.ok).toBe(true);const runId=admitted.body.tester.run.id;
      socket!.close();await Bun.sleep(50);
      await connect({type:'session.restore',sessionToken:paired.sessionToken},'session.restored');
      const replay=await wire(start);expect(replay.ok).toBe(true);expect(replay.body.tester.run.id).toBe(runId);
      let result:any;
      for(let i=0;i<120;i++){result=await wire({action:'tester.read',runId});if(!['queued','starting','running','canceling'].includes(result.body?.tester?.run?.state))break;await Bun.sleep(50);}
      expect(result.ok).toBe(true);expect(result.body.tester.run.state).toBe('passed');
      expect(JSON.stringify(result)).not.toContain(home);expect(JSON.stringify(result)).not.toContain('output');
    }finally{socket?.close();await local('/api/remote-control/disable');}
  }finally{if(child){child.kill();await child.exited;}rmSync(home,{recursive:true,force:true});}
},30000);
