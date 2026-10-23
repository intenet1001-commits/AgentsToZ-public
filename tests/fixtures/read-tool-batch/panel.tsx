import React from 'react';
import {createRoot} from 'react-dom/client';
import {ReadToolBundlePanel} from '../../../src/ReadToolBundlePanel';
import type {ReadToolBatchRequest,ReadToolBatchResponse,ReadToolBatchStage} from '../../../src/readToolBatchClient';
import type {WorkPackClient,WorkPackList} from '../../../src/workPackClient';

// A fake host: receipts survive "lost" responses so the UI must read them, never restart.
const f=window as any;f.calls=[] as ReadToolBatchRequest[];f.mode='ok';f.copied=[] as string[];
Object.defineProperty(navigator,'clipboard',{value:{writeText:async(text:string)=>{f.copied.push(text);}},configurable:true});
const receipts=new Map<string,ReadToolBatchResponse>();
const section:Record<string,string>={'project.git.read':'git','workroom.status.read':'workroom','tester.status.read':'tester','tester.report.read':'tester','memory.reference.read':'memory'};
// Saved packs keep their plan here; a pack run replays that plan as an ordinary receipt.
let packList:WorkPackList={revision:'r0',packs:[{guideId:'stale-cmd',title:'Old command',state:'stale',reason:'source-commandBodyHash-changed',definitionRevision:'rev-old',steps:[{id:'git',operation:'project.git.read'}]}],commands:[{guideId:'cmd-status',title:'개발 현황 조회'}]};
const packPlans=new Map<string,unknown>();f.packSaves=[] as unknown[];
const packs:WorkPackClient={
 async list(){return structuredClone(packList);},
 async save(input){f.packSaves.push(structuredClone(input));packPlans.set(input.guideId,input.plan);const steps=(input.plan as {steps:{id:string;input:{operation:string}}[]}).steps;
  packList={...packList,revision:'r'+f.packSaves.length,packs:[...packList.packs.filter(p=>p.guideId!==input.guideId),{guideId:input.guideId,title:'개발 현황 조회',state:'reviewed',reason:'definition-reviewed',definitionRevision:'rev-'+f.packSaves.length,steps:steps.map(s=>({id:s.id,operation:s.input.operation as never})),...(input.queryInput?{query:{default:'x'}}:{})}]};return structuredClone(packList);},
 async disable(input){packList={...packList,packs:packList.packs.map(p=>p.guideId===input.guideId?{...p,state:'disabled'}:p)};return structuredClone(packList);},
};
function receipt(req:{targetId:string;threadId:string;requestId:string;plan:unknown}):ReadToolBatchResponse {
 const steps=(req.plan as {steps:{id:string;input:{operation:string}}[]}).steps,at=Date.now();
 const stages:ReadToolBatchStage[]=steps.map(s=>({id:s.id,operation:s.input.operation as never,state:'completed',observedAt:at,availability:'ready',freshness:'current',outputDigest:'a'.repeat(64)}));
 return {success:true,payload:'available',
  batch:{runId:'run-'+receipts.size,threadId:req.threadId,requestId:req.requestId,owner:'local',targetId:req.targetId,bindingHash:'b'.repeat(64),intentHash:'c'.repeat(64),bootId:'boot',revision:2,createdAt:at,updatedAt:at,state:'completed',stages,payload:'unavailable'},
  result:{id:'result-'+receipts.size,targetId:req.targetId,collectedAt:at,expiresAt:at+300000,state:'completed',invalidated:false,stages,
   outputs:steps.map(s=>({stepId:s.id,operation:s.input.operation as never,observation:{id:section[s.input.operation] as never,availability:'ready',freshness:'current',observedAt:at,summary:[`${s.id} fixture summary`],limits:['independent observation']}}))}};
}
const request=async(req:ReadToolBatchRequest):Promise<ReadToolBatchResponse>=>{
 f.calls.push(JSON.parse(JSON.stringify(req)));await new Promise(r=>setTimeout(r,30));
 if(req.operation==='batch.start'||req.operation==='pack.run'){
  if(f.mode==='disabled')throw Object.assign(new Error('disabled'),{code:'READ_TOOL_DISABLED',serverRejected:true});
  const plan=req.operation==='pack.run'?packPlans.get(req.guideId):req.plan;
  if(!plan)throw Object.assign(new Error('not reviewed'),{code:'WORK_PACK_NOT_REVIEWED',serverRejected:true});
  receipts.set(req.requestId,receipt({...req,plan}));
  if(f.mode==='lost')throw new Error('READ_TOOL_BATCH_TIMEOUT');
 }
 const found=receipts.get(req.requestId);
 if(!found)throw Object.assign(new Error('missing'),{code:'PROJECT_STATE_BATCH_UNAVAILABLE',serverRejected:true});
 const pack=req.operation==='pack.run'||req.operation==='pack.read';
 return pack?{...found,completion:{complete:true,meaning:'read-completion-only',conditions:found.batch.stages.map(s=>({stepId:s.id,kind:'step-completed',satisfied:true,reason:'read-condition-satisfied'}))}}:found;
};
createRoot(document.getElementById('root')!).render(<React.StrictMode><ReadToolBundlePanel targetId="fixture-target" threadId="thread-one" visible supported request={request} packs={packs}/></React.StrictMode>);
