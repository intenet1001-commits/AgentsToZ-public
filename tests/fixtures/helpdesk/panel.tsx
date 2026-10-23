import {createRoot} from 'react-dom/client';
import {HelpdeskPanel} from '../../../src/HelpdeskPanel';
const helpdesk=async(body:Record<string,unknown>)=>{const r=await fetch('/helpdesk',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Error(data.error);return data;};
const setup=async(body:Record<string,unknown>)=>{const r=await fetch('/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
const codex=async()=>({status:200,body:{success:true,receipt:null,supported:true,browserReady:false}});
createRoot(document.getElementById('root')!).render(<HelpdeskPanel standalone transport={helpdesk} setupTransport={setup} codexLoginTransport={codex} onClose={()=>{}} onAction={action=>{document.getElementById('destination')!.textContent='앱 화면: '+action;}}/>);
