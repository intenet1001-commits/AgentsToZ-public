import {useCallback,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {CliAccountPicker} from '../../src/CliAccountPicker';
import {localAiTerminalTransport} from '../../src/aiTerminalClient';
import type {AiTerminalAgent,AiTerminalRequest} from '../../src/aiTerminalProtocol';
import '../../src/AiTerminalPanel.css';
function App(){
 const [agent,setAgent]=useState<AiTerminalAgent>('codex');
 const [target,setTarget]=useState('account-project');
 const request=useCallback((r:Omit<AiTerminalRequest,'requestId'>)=>localAiTerminalTransport({...r,requestId:crypto.randomUUID()}),[]);
 return <main className="ai-terminal-panel" style={{padding:16,color:'#e4e4e7',background:'#0a0a0b',minHeight:'100vh',fontFamily:'sans-serif'}}><h1>CLI 계정 관리 검사</h1><label>프로젝트 <select aria-label="검사할 프로젝트" value={target} onChange={e=>setTarget(e.target.value)}><option value="account-project">업무 프로젝트</option><option value="account-project-other">개인 프로젝트</option></select></label><label>AI <select aria-label="검사할 AI" value={agent} onChange={e=>setAgent(e.target.value as AiTerminalAgent)}><option value="codex">Codex CLI</option><option value="claude">Claude Code</option></select></label><CliAccountPicker agent={agent} targetId={target} request={request} remote={false} visible={true}/></main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
