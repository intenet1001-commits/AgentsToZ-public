import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {CommunityWorkspace} from '../../../src/CommunityWorkspace';
import {projectStateRequest} from '../../../src/projectStateBundleClient';
import {AppLanguagePicker} from '../../../src/useAppLanguage';
import '../../../src/index.css';
import '../../../src/workspaceDesign.css';
const projects=[{targetId:'state-project-one',label:'첫 프로젝트'},{targetId:'state-project-two',label:'다른 프로젝트'},{targetId:'state-product-use',label:'제품',executionRole:'use' as const,serviceKey:'example'}];
const transport=async(request:any)=>{const response=await fetch('/fixture/workspace',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});const result=await response.json();if(!response.ok)throw Error(result.error);return result;};
function Fixture(){const [visible,setVisible]=useState(true);return <><AppLanguagePicker/><button onClick={()=>setVisible(value=>!value)}>Toggle visibility</button><CommunityWorkspace visible={visible} channels={[{id:'local',label:'로컬 Mac',projects:async()=>projects,transport,projectState:projectStateRequest},{id:'remote',label:'원격 Mac',projects:async()=>projects,transport}]} onOpenWorkroom={()=>{}}/></>;}
createRoot(document.getElementById('root')!).render(<Fixture/>);
