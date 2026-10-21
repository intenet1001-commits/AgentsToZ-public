/** Owned private-LAN fixture for native Mac/iPhone persona journeys. No real provider or app data. */
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir,networkInterfaces} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {WorkroomThreadStore} from '../../../src/workroomThreadStore';
import {WorkroomThreadService} from '../../../src/workroomThreadService';
import {isPrivateRemoteControlIpv4} from '../../../src/remoteControlLanServer';
import {normalizeMobileWorkspaceRequest} from '../../../src/mobileWorkspaceProtocol';
import {TesterAgentHost} from '../../../src/testerAgentHost';
import {acquireOwnedFileLock} from '../../../src/portalFileLock';
const root=resolve(import.meta.dir,'../../..'),temp=mkdtempSync(join(tmpdir(),'workroom-persona-host-'));
const address=Object.values(networkInterfaces()).flat().find(r=>r&&!r.internal&&r.family==='IPv4'&&isPrivateRemoteControlIpv4(r.address))?.address;
if(!address)throw Error('Private LAN required');
const built=await Bun.build({entrypoints:[join(root,'tests/fixtures/workroom-native-persona.tsx')],target:'browser',format:'esm',define:{'process.env.NODE_ENV':'"production"'}});
if(!built.success)throw Error(built.logs.map(x=>x.message).join('\n'));
const js=await built.outputs.find(x=>x.path.endsWith('.js'))!.text(),css=await built.outputs.find(x=>x.path.endsWith('.css'))!.text();
const store=new WorkroomThreadStore(temp,{read:async()=>Buffer.alloc(32,9),create:async()=>Buffer.alloc(32,9)}),starts:{requestId:string;targetId:string}[]=[];
const service=new WorkroomThreadService({store,resolve:async id=>({fingerprint:id}),inspect:()=>({state:'running',inputRevision:0}),start:async(id,targetId,agent)=>{starts.push({requestId:id,targetId});return {written:true,session:{id:'native_session_'+id,targetId,agent,state:'running',createdAt:new Date().toISOString(),exitCode:null,cols:100,rows:28}};},reply:async()=>({written:true})});
const grants=new Set<string>(),executes:Record<string,number>={};
const testerRoot=join(temp,'project');mkdirSync(testerRoot);
const tester=new TesterAgentHost({directory:join(temp,'tester'),runner:join(root,'scripts/agentstoz-maintainer.py'),python:()=>Bun.which('python3'),resolve:async()=>({root:testerRoot,label:'실기 검증',targets:[]}),lease:async()=>{const release=await acquireOwnedFileLock(join(temp,'tester-write.lock'));return {release:()=>{release();}};}});
const manifest={builtAt:new Date().toISOString(),bundleHash:createHash('sha256').update(js).update(css).digest('hex'),sources:Object.fromEntries(['src/CommunityWorkspace.tsx','src/RemoteWorkroomHistoryPanel.tsx','src/remoteWorkroomHistoryClient.ts','src/TesterImprovementPanel.tsx','src/testerImprovementJournal.ts','src/testerImprovements.ts','tests/fixtures/workroom-native-persona.tsx'].map(path=>[path,createHash('sha256').update(readFileSync(join(root,path))).digest('hex')]))};
async function fetchFixture(request:Request):Promise<Response>{
 const url=new URL(request.url);
 if(url.pathname==='/remote/app.js')return new Response(js,{headers:{'content-type':'text/javascript'}});
 if(url.pathname==='/remote/app.css')return new Response(css,{headers:{'content-type':'text/css'}});
 if(url.pathname==='/remote/'&&request.method==='GET')return new Response('<!doctype html><html data-app-theme="gray"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><link rel="stylesheet" href="/remote/app.css"><div id="root"></div><script type="module" src="/remote/app.js"></script></html>',{headers:{'content-type':'text/html'}});
 if(url.pathname==='/fixture/status')return Response.json({starts,executes,grants:[...grants]});
 if(request.method!=='POST'||request.headers.get('origin')!==url.origin)return new Response('refused',{status:403});
 try{
  if(url.pathname==='/fixture/grant'){const body=await request.json();if(!['native_phone_project_01','native_mac_project_01'].includes(body.targetId))throw Error('Fixture target refused');grants.add(body.targetId);return Response.json({ok:true});}
  if(url.pathname==='/fixture/tester')return Response.json(await tester.perform(await request.json()));
  const r=normalizeMobileWorkspaceRequest(await request.json()),action=r.workspace.action;
  if(url.pathname==='/fixture/workspace'&&action.startsWith('workroom.threads.'))return Response.json({kind:'workspace',action,threads:await service.perform(action as any,(r.workspace as any).thread,r.targetId,r.requestId,{owner:'native-persona',active:()=>true,readAll:false})});
  if(url.pathname==='/fixture/history'){
   if(!grants.has(r.targetId))throw Error('Mac에서 이 기기의 ‘워크룸 대화 기록 보기’ 권한을 허용하세요.');
   if(action==='history.list')return Response.json({kind:'workspace',action,history:{records:[{id:'native_saved_conversation_01',title:'지난 업무 대화',agent:'codex',state:'ended',resumable:true,updatedAt:new Date().toISOString(),revision:1}],nextBefore:null}});
   if(action==='history.resume.review')return Response.json({kind:'workspace',action,history:{review:{id:'native_resume_review_01',expiresAt:Date.now()+60000,available:true,reason:'',revision:1}}});
   if(action==='history.resume.execute'){executes[r.targetId]=(executes[r.targetId]??0)+1;return Response.json({kind:'workspace',action,history:{resume:{state:'completed',sessionId:'native_resumed_session_01'}}});}
  }
  throw Error('Fixture action refused');
 }catch(e){return Response.json({error:e instanceof Error?e.message:String(e)},{status:400});}
}
const server=Bun.serve({hostname:address,port:0,fetch:fetchFixture}),macServer=Bun.serve({hostname:'127.0.0.1',port:0,fetch:fetchFixture});
const state=process.argv[2]??'/private/tmp/workroom-persona-host.json';mkdirSync(join(root,'mobile/ios/build/workroom-persona-device'),{recursive:true});writeFileSync(state,JSON.stringify({url:`http://${address}:${server.port}/remote/`,macUrl:`http://127.0.0.1:${macServer.port}/remote/`,root,temp,manifest,realAI:false,productionData:false}),{mode:0o600});
console.log('Native persona fixture ready: '+state);
let closing=false;async function close(){if(closing)return;closing=true;server.stop(true);macServer.stop(true);await service.idle();await tester.shutdown();tester.store.close();rmSync(temp,{recursive:true,force:true});process.exit(0);}
process.once('SIGTERM',()=>void close());process.once('SIGINT',()=>void close());
