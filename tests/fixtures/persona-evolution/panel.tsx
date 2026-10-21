import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {ProjectTesterPanel} from '../../../src/ProjectTesterPanel';
import type {TesterRequest} from '../../../src/testerAgentContract';
function Fixture(){const [draft,setDraft]=useState('');const transport=async(r:TesterRequest)=>{const response=await fetch('/tester',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(r)});const result=await response.json();if(!response.ok)throw Error(result.error);return result;};
return <main style={{maxWidth:800,margin:'16px auto',padding:12}}><h1>개발 맥락별 페르소나</h1><ProjectTesterPanel portId="fixture-project" projectName="시험 프로젝트" initialOpen transport={transport} onDraft={setDraft}/><output style={{display:'block',overflowWrap:'anywhere'}} data-testid="prepared-draft">{draft}</output></main>;}
createRoot(document.getElementById('root')!).render(<Fixture/>);
