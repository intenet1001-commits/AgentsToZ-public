import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {MobileWorkspacePanel} from '../../src/MobileWorkspacePanel';
import {TesterOverviewPanel} from '../../src/TesterOverviewPanel';
import {mountLanTester} from '../../src/mobileTesterLan';
import {normalizeMobileWorkspaceRequest,type MobileWorkspaceRequest,type MobileWorkspaceResult} from '../../src/mobileWorkspaceProtocol';
const w=window as any;
const run={id:'20260914T060000Z-1234abcd',state:'running' as const,profileId:'quick',createdAt:'2026-09-14T06:00:00Z',origin:'app' as const,checkCount:0,checks:[]};
w.fixture={requests:[],overview:[],canRun:false,run:null,fail:false,hold:false,held:[],online:true,owner:'phone-a',opened:''};
const f=w.fixture;
async function transport(request:MobileWorkspaceRequest):Promise<MobileWorkspaceResult>{
 normalizeMobileWorkspaceRequest(request);f.requests.push(request);
 const action=request.workspace.action;
 if(f.hold)return new Promise<MobileWorkspaceResult>(resolve=>f.held.push(()=>resolve({kind:'workspace',action,tester:{canRun:false,canCancel:false,run:{...run,id:'20260914T060000Z-deadbeef'}}})));
 if(action==='tester.start'){if(f.fail)throw Error('응답 확인 필요');f.run={...run};}
 if(action==='tester.cancel')f.run={...run,state:'interrupted'};
 return {kind:'workspace' as const,action,tester:{canRun:f.canRun,canCancel:!!f.run&&f.run.state==='running',run:f.run,...(action==='tester.status'?{installation:'ready' as const,environmentReady:true,revision:'a'.repeat(64),profiles:[{id:'quick',configured:true}],defaultProfile:'quick',freshness:'current' as const}:{})}};
}
const projects=[{controlId:'project_1234',name:'검증 프로젝트',alias:null,workspaceRoot:null,branch:null,port:null,kind:'main' as const,status:'stopped' as const,actions:[]},{controlId:'project_5678',name:'다른 프로젝트',alias:null,workspaceRoot:null,branch:null,port:null,kind:'main' as const,status:'stopped' as const,actions:[]}];
function Fixture(){const [online,setOnline]=useState(true),[owner,setOwner]=useState('phone-a');f.setOnline=setOnline;f.setOwner=setOwner;
 return <><MobileWorkspacePanel key={owner} mode="manage" projects={projects} available testerAvailable online={online} transport={transport} onDraft={()=>{}}/><TesterOverviewPanel transport={async r=>{f.overview.push(r);return {hostName:'Fixture Mac',checkedAt:'2026-09-14T06:00:00Z',revision:'a'.repeat(64),total:21,complete:true,nextOffset:r.offset?null:20,entries:[{projectId:r.offset?'p21':'p1',name:r.offset?'다음 프로젝트 결과':'첫 프로젝트 결과',state:'observed',run:{...run,state:'passed'}}]}}} onOpenProject={id=>f.opened=id}/></>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
// Exercise the exact self-contained function representation embedded in LAN app.js.
const lanMount=(0,eval)('('+mountLanTester.toString()+')');
f.lan=lanMount(document.getElementById('lan')!,transport,()=>({online:f.online,owner:f.owner,supported:true,projects}));f.lan.update();
