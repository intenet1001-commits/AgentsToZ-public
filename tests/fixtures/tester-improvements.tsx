import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {TesterImprovementPanel} from '../../src/TesterImprovementPanel';
const control={requests:[] as any[],loseAck:false,hold:false,waiting:false,release:()=>{}};
(window as any).improvementFixture=control;
function Fixture(){
 const [project,setProject]=useState('a');
 return <main style={{maxWidth:800,margin:'auto',padding:12}}><button onClick={()=>setProject(p=>p==='a'?'b':'a')}>프로젝트 바꾸기</button><p>현재 프로젝트 {project}</p><TesterImprovementPanel target={{portId:project}} transport={async request=>{
  control.requests.push(request);const response=await fetch('/tester',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request)}),result=await response.json();if(!response.ok)throw Error(result.error);
  if(request.operation==='improvements'&&control.hold){control.hold=false;control.waiting=true;await new Promise<void>(resolve=>{control.release=()=>{control.waiting=false;resolve();};});}
  if(request.operation==='improvement-record'&&control.loseAck){control.loseAck=false;throw Error('저장 응답을 확인하지 못했습니다. 같은 내용으로 다시 확인하세요.');}
  return result;
 }}/></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
