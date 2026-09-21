import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import OnboardingCodexInstaller from '../../../src/OnboardingCodexInstaller';
const transport=async(body:Record<string,unknown>)=>{
 const response=await fetch('/fixture/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 return {status:response.status,body:await response.json()};
};
function Panel(){const [next,setNext]=useState(0);return <><OnboardingCodexInstaller transport={transport} onContinue={()=>setNext(n=>n+1)} /><output aria-label="next-step">{next}</output></>;}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Panel/></React.StrictMode>);
