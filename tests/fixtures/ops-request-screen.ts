/** Owned loopback fixture. No installed API, provider, credentials or remote device is contacted. */
import {createServer} from 'vite';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import type {OpsRequestReceipt} from '../../src/opsRequestProtocol';
const root=process.cwd(),temp=mkdtempSync(join(tmpdir(),'ops-screen-'));
const empty=join(temp,'empty-env');mkdirSync(empty);
for(const key of Object.keys(process.env))if(key.startsWith('VITE_'))delete process.env[key];
let receipt:OpsRequestReceipt|null=null,submissions=0,lost=false,windowPending=false;
// Next submit is not admitted: 'reject' answered by the receiver (status then answers not-found), 'outside' refused on
// this Mac before anything is sent (not in the community), 'timeout' unanswered in time (outcome unknown, status then
// answers not-found), 'outdated' answered by a receiver without OPS requests (every later read says the same, late).
// All mirror the app's control route answers.
let refuse:''|'reject'|'outside'|'timeout'='',outdated=false;const attempts:string[]=[];
const endpointId='40000000-0000-4000-8000-000000000001';
const server=await createServer({root,configFile:join(root,'vite.config.ts'),configLoader:'runner',envDir:empty,
  cacheDir:join(temp,'node_modules/.vite'),mode:'maintainer-test',logLevel:'warn',
  server:{host:'127.0.0.1',port:0,strictPort:false,proxy:{}},
  plugins:[{name:'ops-request-screen-fixture',configureServer(vite){vite.middlewares.use(async(req,res,next)=>{
    const url=new URL(req.url??'/','http://127.0.0.1');
    const json=(value:unknown,status=200)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
    if(url.pathname==='/fixture/state')return json({receipt,submissions,attempts});
    if(url.pathname==='/fixture/reset'){receipt=null;submissions=0;lost=false;windowPending=false;refuse='';outdated=false;attempts.length=0;return json({ok:true});}
    if(url.pathname==='/fixture/timeout'){refuse='timeout';return json({ok:true});}
    if(url.pathname==='/fixture/outdated'){outdated=true;return json({ok:true});}
    if(url.pathname==='/fixture/reject'){refuse='reject';return json({ok:true});}
    if(url.pathname==='/fixture/outside'){refuse='outside';return json({ok:true});}
    if(url.pathname==='/fixture/finish'){if(receipt)receipt={...receipt,state:'completed',result:'상대 기기에서 프로젝트 3개의 상태를 확인했습니다.',evidence:'2호의 등록 목록과 상태 응답 3건 확인.',updatedAt:Date.now()};return json({ok:true});}
    if(url.pathname==='/fixture/lost'){lost=true;return json({ok:true});}
    if(url.pathname==='/fixture/window'){windowPending=true;return json({ok:true});}
    if(url.pathname==='/api/agent-dialogue/control'){
      const parts:Buffer[]=[];for await(const part of req)parts.push(Buffer.from(part));const body=JSON.parse(Buffer.concat(parts).toString());
      if(body.operation==='ops-windows')return json({success:true,windows:windowPending&&receipt?[{claimId:endpointId,receipt:{...receipt,sessionId:'fixture_ops_session',targetId:'fixture_ops_project',agent:'claude'}}]:[]});
      if(body.operation==='ops-window-opened'){windowPending=false;if(receipt){if(body.inline)receipt.windowFallback=true;else receipt.windowOpened=true;}return json({success:true});}
      const action=body.request;
      if(body.operation!=='ops-action')return json({success:false,error:'Unsupported fixture request'},400);
      if(outdated){
        if(action.operation==='submit')attempts.push(action.requestId);
        // A status read answers later than the submit did, so the screen between the two answers is observable.
        else await new Promise(resolve=>setTimeout(resolve,1000));
        return json({success:false,code:'OPS_HOST_OUTDATED',error:'상대 기기의 AgentsToZ를 업데이트하세요. 지금 버전은 OPS 작업 요청을 받지 못합니다.'},400);
      }
      if(action.operation==='submit'){
        attempts.push(action.requestId);
        if(refuse==='reject'){refuse='';return json({success:false,code:'OPS_REQUEST_FAILED',error:'대기 중인 작업이 너무 많습니다.'},400);}
        if(refuse==='timeout'){refuse='';return json({success:false,code:'AGENT_DIALOGUE_CONTROL_TIMEOUT',error:'상대 기기가 제때 답하지 않았습니다. 그 기기의 AgentsToZ가 켜져 있는지 확인하세요. 요청이 실행됐는지는 알 수 없습니다.'},504);}
        if(refuse==='outside'){refuse='';return json({success:false,code:'OPS_REQUEST_PERMISSION',error:'기기 간 대화의 커뮤니티에 입장하세요.'},400);}
        if(!receipt||receipt.requestId!==action.requestId){submissions++;receipt={version:'ops-request-v1',requestId:action.requestId,state:'running',createdAt:Date.now(),updatedAt:Date.now(),windowOpened:false,agent:'claude'};}
        if(lost){lost=false;return json({success:false,error:'응답 유실 fixture'},504);}
      }
      if(!receipt||receipt.requestId!==action.requestId)return json({success:false,code:'OPS_REQUEST_NOT_FOUND',error:'이 기기에서 접수한 작업을 찾지 못했습니다.'},400);
      return json({success:true,version:'ops-request-v1',receipt});
    }
    if(url.pathname==='/'&&url.searchParams.has('workroom-popout')){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end('<h1>받는 기기의 OPS 워크룸</h1><p>fixture_ops_session · Claude</p>');}
    if(url.pathname!=='/ops-request-fixture'){
      // Every other API is refused. Never fall through to the user's real localhost proxy.
      if(url.pathname.startsWith('/api/'))return json({success:false,error:'Fixture route only'},404);
      return next();
    }
    const html=`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">
      import React from 'react';import{createRoot}from'react-dom/client';import '/src/index.css';
      import{OpsRequestPanel,OpsRequestWindows}from'/src/OpsRequestPanel.tsx';
      function Harness(){const[open,setOpen]=React.useState(true);return React.createElement(React.Fragment,null,
        React.createElement('h1',null,'아젠투지 1호 · 기기 간 OPS 작업'),React.createElement('button',{onClick:()=>setOpen(true)},'2호 OPS 부르기'),
        React.createElement(OpsRequestWindows,{onError:message=>console.error(message),onOpenInline:receipt=>{const node=document.createElement('p');node.dataset.testid='inline-ops';node.textContent='본창 OPS: '+receipt.targetId+' / '+receipt.sessionId;document.body.append(node);}}),
        open&&React.createElement(OpsRequestPanel,{endpointId:'${endpointId}',deviceName:'아젠투지 2호',onClose:()=>setOpen(false),onViewWorkroom:()=>setOpen(false)}));}
      createRoot(document.getElementById('root')).render(React.createElement(Harness));</script></html>`;
    res.setHeader('Content-Type','text/html; charset=utf-8');res.end(await vite.transformIndexHtml(req.url!,html));
  });}}]});
await server.listen();console.log(`OPS_SCREEN_ORIGIN=${server.resolvedUrls?.local[0]}`);
const stop=async()=>{await server.close();rmSync(temp,{recursive:true,force:true});process.exit();};
process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
