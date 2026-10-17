import React from 'react';
import {createRoot} from 'react-dom/client';
import {ProjectMemoryCorrections, type ProjectMemoryCorrectionClient} from '../../../src/ProjectMemoryCorrections';
const f=window as any;f.calls=[];f.writes=[];f.receipts=new Set();f.loseReply=true;f.outcomeCalls=[];
const client:ProjectMemoryCorrectionClient={
 review:async()=>({correctionReview:{pendingEntries:1,changedVersionEntries:0,unboundReports:0},hourlyCheckedAt:null,
  correctionOutcomes:{protocolVersion:1,protocolHash:'f'.repeat(64),protocolStatus:'proposed',exposuresObserved:3,
   excluded:{'delivery-uncertain':1,withheld:0,'pre-protocol':0,unrelated:0,'target-unresolved':0},eligible:2,pending:1,finalized:{avoided:0,repeated:1,unknown:0},
   otherProtocol:0,distinctCorrections:1,bySource:{'human-attestation':0,'re-correction':1,'tester-check':0},conflicts:0,
   primary:{units:1,finalized:{avoided:0,repeated:1,unknown:0},repeatRate:null,repeatRateReason:'insufficient-sample'},
   secondary:{units:2,finalized:{avoided:0,repeated:1,unknown:0},repeatRate:null,repeatRateReason:'insufficient-sample'},
   coverage:{exposedPaths:['composer-submission','reviewed-voice','@-route-submission'],notExposed:['mcp-instruction','new-session-first-prompt','@-route-raw','legacy-lan']},
   efficacyVerified:false}}),
 outcomes:async request=>{
  f.outcomeCalls.push(request);
  if(request.operation==='list')return {ok:true,operation:'list',truncated:false,units:[{unitId:'1'.repeat(64),conversationTitle:'셸 입력 수정 대화',
   entryTitle:'project-a shell rule',entryCurrent:true,writtenAt:'2026-10-15T00:00:00.000Z',windowClosesAt:'2026-10-18T00:00:00.000Z',windowOpen:true,
   attestable:!f.finalized,outcome:f.finalized?'unknown':null,attestations:f.attested?['avoided']:[],boundChecks:f.bound??[],availableChecks:['other','shell-input']}]};
  // The observer finalized the unit while the route was writing (review S4-05, 2026-10-16): the host refuses it as too late.
  if(request.operation==='attest'&&f.finalizeOnAttest){f.finalized=true;throw Error('남기는 사이 이 요청의 관찰 결과가 확정되어 이 결과는 남기지 않았습니다.');}
  if(request.operation==='attest'){f.attested=true;return {ok:true,operation:'attest',unitId:request.unitId,recorded:'inserted',conflict:false};}
  f.bound=request.checkIds;return {ok:true,operation:'bind',unitId:request.unitId,recorded:'inserted'};
 },
 recall:async(folderPath,query)=>{
  f.calls.push({folderPath,query});
  if(f.holdSearch)await new Promise<void>(resolve=>{f.releaseSearch=resolve;});
  return {hits:[{entryKey:'e'.repeat(24),contentVersionHash:'a'.repeat(32),identitySource:'explicit',title:folderPath+' shell rule',body:'Use JSON for shell arguments.'}],...(f.oldServer?{}:{corrections:[],correctionSearch:{complete:!f.corrupt,warning:f.corrupt?'교정 기록 복구 필요':undefined}})};
 },
 correct:async input=>{
  f.writes.push(input);const key=JSON.stringify(input),appended=!f.receipts.has(key);f.receipts.add(key);
  if(f.loseReply){f.loseReply=false;throw Error('응답 연결 끊김 · 다시 저장하여 영수증을 확인하세요.');}
  return {success:true,appended};
 }
};
function Fixture(){const [folder,setFolder]=React.useState('project-a');f.changeFolder=setFolder;return <ProjectMemoryCorrections key={folder} folderPath={folder} client={client}/>;}
createRoot(document.getElementById('root')!).render(<Fixture/>);
