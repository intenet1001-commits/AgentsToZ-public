import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import SetupWizard from '../../../src/SetupWizard';
function Fixture(){
 const [route,setRoute]=useState('setup');
 return route==='setup'?<SetupWizard onComplete={()=>{throw new Error('Cloud registration must not run');}}
  onSkip={()=>setRoute('closed')} onStartProject={choice=>setRoute(`project:${choice}`)} onStartControl={choice=>setRoute(`control:${choice}`)} onOpenProjects={()=>setRoute('projects')}/>:<p role="status">{route}</p>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Fixture/></React.StrictMode>);
