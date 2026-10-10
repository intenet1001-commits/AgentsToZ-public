import React,{useCallback,useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import OnboardingInstallAll from '../../../src/OnboardingInstallAll';
import type {OnboardingToolDiagnostic} from '../../../src/onboardingInfrastructure';
const transport=(tool:string)=>async(body:Record<string,unknown>)=>{
 const response=await fetch(`/fixture/${tool}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 return {status:response.status,body:await response.json()};
};
const transports={codex:transport('codex'),github:transport('github')};
function Panel(){
 const [diagnostics,setDiagnostics]=useState<OnboardingToolDiagnostic[]>([]);
 const [finished,setFinished]=useState(0);
 const read=useCallback(async()=>setDiagnostics(await (await fetch('/fixture/diagnostics')).json()),[]);
 useEffect(()=>{void read();},[read]);
 return <><OnboardingInstallAll diagnostics={diagnostics} checked={diagnostics.length>0} transports={transports}
  onFinished={()=>{setFinished(n=>n+1);void read();}} /><output aria-label="finished">{finished}</output></>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Panel/></React.StrictMode>);
