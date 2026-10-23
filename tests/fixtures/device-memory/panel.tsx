import React,{useLayoutEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AppLanguagePicker,useAppLanguage} from '../../../src/useAppLanguage';
import {readAppLanguage,t,writeAppLanguage} from '../../../src/i18n';
import {DeviceOperatingMemoryPanel} from '../../../src/DeviceOperatingMemoryPanel';
const w=window as any;w.requests=[];w.failBackup=true;
let memory={profileId:'11111111-1111-4111-8111-111111111111',deviceId:'22222222-2222-4222-8222-222222222222',memoryId:'33333333-3333-8333-8333-333333333333',name:'아젠투지 1호',revision:null as string|null,prepared:false,savedAt:null as string|null,entries:[] as any[],total:0,offset:0,nextOffset:null};
const saved=new Map();
const request=async(body:Record<string,any>)=>{
 w.requests.push(structuredClone(body));await new Promise(r=>setTimeout(r,w.responseDelay??25));
 if(body.operation==='legacy-list')return {memories:[],nextOffset:null};
 if(body.operation==='read')return {memory:structuredClone(memory)};
 if(body.operation==='save'){
  if(!saved.has(body.requestId)){if(body.expectedRevision!==memory.revision)throw Error('revision changed');memory={...memory,revision:'revision-1',prepared:true,savedAt:new Date().toISOString(),entries:[{entryId:body.requestId,title:body.title,body:body.body}],total:1};saved.set(body.requestId,body);}
  return {saved:true,backup:{backedUp:!w.failBackup,reason:w.failBackup?'pending':'complete'},memory:structuredClone(memory)};
 }
 throw Error('unexpected operation');
};
function LateReader(){const [lang]=useAppLanguage();return <output data-testid="late-language">{lang}</output>;}
function MountRace(){const [lang]=useAppLanguage();useLayoutEffect(()=>{writeAppLanguage('fr');},[]);return <output data-testid="race-language">{lang}</output>;}
function App(){
 const [lang]=useAppLanguage(),[late,setLate]=useState(false),[race,setRace]=useState(false);
 return <main style={{maxWidth:780,margin:'auto',padding:16}}>
  <AppLanguagePicker/><h1>{t(lang,'myWorkspace')}</h1>
  <button data-testid="read-request-language" onClick={()=>{w.requestLanguage=readAppLanguage();}}>Read request language</button>
  <button data-testid="mount-late-reader" onClick={()=>setLate(true)}>Mount late reader</button>
  <button data-testid="mount-race" onClick={()=>setRace(true)}>Mount race</button>
  {late&&<LateReader/>}{race&&<MountRace/>}
  <p>{t(lang,'tabCommonMemory')} · {t(lang,'deviceMemory')}</p><DeviceOperatingMemoryPanel request={request}/>
 </main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
