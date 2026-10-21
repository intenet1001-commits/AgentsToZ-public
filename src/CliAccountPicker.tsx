import {useEffect, useRef, useState} from 'react';
import {AI_TERMINAL_PREFIX, aiTerminalSnapshotUnsupported, type AiTerminalAgent, type AiTerminalRequest, type AiTerminalResponse} from './aiTerminalProtocol';
import {terminalLocalRequest} from './aiTerminalClient';
import {cliAccountAgent, normalizeCliAccountSummary, type CliAccountSummary, type CliAccountAdminRequest, type CliAccountSelection} from './cliAccountProtocol';

const authLabel = (state: CliAccountSummary['authState']) => ({'signed-in':'로그인됨','signed-out':'로그인 필요',unknown:'확인 필요'}[state]);
const requestId = () => globalThis.crypto.randomUUID?.() ?? 'account_' + [...crypto.getRandomValues(new Uint8Array(16))].map(v=>v.toString(16).padStart(2,'0')).join('');
/** Selection follows the transport's host and target; it is never cached as a browser-wide account. */
export function CliAccountPicker({agent,targetId,request,remote,visible,onChanged,onlyWhenChoice=false}: {
  agent: AiTerminalAgent; targetId: string; remote: boolean; visible: boolean;
  /** The phone's 「새 작업」 sheet (w11): shown only when the host lists more than one account to choose from. */
  onlyWhenChoice?: boolean;
  request: (r: Omit<AiTerminalRequest,'requestId'>) => Promise<AiTerminalResponse>;
  onChanged?: () => void;
}) {
  const [selection,setSelection] = useState<CliAccountSelection|null>(null);
  const [message,setMessage] = useState('');
  const [busy,setBusy] = useState(false);
  const [manageOpen,setManageOpen] = useState(false);
  const [label,setLabel] = useState('');
  const [items,setItems] = useState<CliAccountSummary[]>([]);
  const generation = useRef(0);
  const supported = cliAccountAgent(agent);
  useEffect(()=>{
    const epoch=++generation.current; setSelection(null);setItems([]);setMessage('');setBusy(false);setManageOpen(false);setLabel('');
    if(!supported||!targetId||!visible)return;
    void request({operation:'accounts',accountAction:'list',targetId,agent}).then(r=>{if(generation.current===epoch&&r.accounts){setSelection(r.accounts);setItems(r.accounts.items);}},error=>{
      if(generation.current===epoch)setMessage(aiTerminalSnapshotUnsupported(error)?'이 호스트의 앱을 업데이트하면 계정 선택을 사용할 수 있습니다.':error instanceof Error?error.message:'계정 목록을 확인하지 못했습니다.');
    });
    return()=>{generation.current++;};
  },[agent,targetId,request,visible,supported]);
  useEffect(()=>{
    if(!manageOpen||remote||!visible||!supported||!items.some(s=>s.loginState==='authenticating'))return;
    const epoch=generation.current;let pending=false;
    const timer=setInterval(()=>{if(pending)return;pending=true;void terminalLocalRequest(AI_TERMINAL_PREFIX+'/accounts',{operation:'list',agent}).then(r=>{
      if(generation.current===epoch&&Array.isArray(r.accounts)){const next=r.accounts.map(normalizeCliAccountSummary);setItems(next);setSelection(old=>old?{...old,items:next}:old);}
    }).catch(()=>{}).finally(()=>{pending=false;});},2000);
    return()=>clearInterval(timer);
  },[manageOpen,remote,visible,supported,agent,items.some(s=>s.loginState==='authenticating')]);
  const select = async(id:string)=>{
    if(busy||!supported)return;const epoch=generation.current;setBusy(true);setMessage('');
    try {const r=await request({operation:'accounts',accountAction:'select',targetId,agent,accountId:id});if(generation.current===epoch&&r.accounts){setSelection(r.accounts);setItems(r.accounts.items);setMessage('다음에 시작하는 작업부터 이 계정을 사용합니다.');onChanged?.();}}
    catch(error){if(generation.current===epoch)setMessage(error instanceof Error?error.message:'계정 선택 결과를 확인하지 못했습니다. 목록을 다시 확인하세요.');}
    finally{if(generation.current===epoch)setBusy(false);}
  };
  const manage = async(r:CliAccountAdminRequest)=>{
    if(busy)return;const epoch=generation.current;setBusy(true);setMessage('');
    try {
      const result=await terminalLocalRequest(AI_TERMINAL_PREFIX+'/accounts',r);
      if(generation.current!==epoch)return;
      if(!Array.isArray(result.accounts))throw Error('계정 관리 결과를 확인하지 못했습니다.');
      const next=result.accounts.map(normalizeCliAccountSummary);setItems(next);
      const current=await request({operation:'accounts',accountAction:'list',targetId,agent});
      if(generation.current!==epoch)return;
      if(current.accounts)setSelection(current.accounts);
      if(r.operation==='create'){setLabel('');setMessage('계정을 추가했습니다. 공식 로그인을 완료한 뒤 선택하세요.');}
      if(r.operation==='login')setMessage('호스트 PC의 공식 로그인 화면에서 원하는 계정으로 로그인하세요.');
      if(r.operation==='archive')setMessage('목록에서 제외했습니다. 로그인 파일은 호스트 PC에 보존됩니다.');
    } catch(error){if(generation.current===epoch)setMessage(error instanceof Error?error.message:'계정 관리 결과를 확인하지 못했습니다. 다시 실행하기 전에 목록을 확인하세요.');}
    finally{if(generation.current===epoch)setBusy(false);}
  };
  if(!supported||!targetId)return null;
  if(onlyWhenChoice&&(!selection||selection.items.length<2))return null;
  return <div className="cli-account-picker" data-testid="cli-account-picker">
    <div className="cli-account-choice">
      <label><span className="ai-terminal-label">새 작업의 계정</span><select aria-label="새 작업의 CLI 계정" className="ai-terminal-select" disabled={busy||!selection} value={selection?.selectedAccountId??''} onChange={e=>void select(e.target.value)}>
        {!selection&&<option value="">계정 선택 확인 필요</option>}{selection?.items.map(s=><option key={s.id} value={s.id}>{s.label}{s.id==='host-default'?'':` · ${authLabel(s.authState)}`}</option>)}
      </select></label>
      {!remote&&<button type="button" className="ai-terminal-btn" aria-expanded={manageOpen} onClick={()=>setManageOpen(v=>!v)}>계정 관리</button>}
      <button type="button" className="ai-terminal-btn" disabled={busy} onClick={()=>{const epoch=generation.current;void request({operation:'accounts',accountAction:'list',targetId,agent}).then(r=>{if(generation.current===epoch&&r.accounts){setSelection(r.accounts);setItems(r.accounts.items);setMessage('');}},e=>{if(generation.current===epoch)setMessage(String(e));});}}>계정 새로고침</button>
    </div>
    {message&&<p role="status" className="ai-terminal-hint">{message}</p>}
    {!remote&&manageOpen&&<div className="cli-account-manager" data-testid="cli-account-manager">
      <p className="ai-terminal-hint">추가 계정은 각각 로그인합니다. 기존 작업은 시작한 계정을 유지합니다. 데스크톱 앱의 로그인은 별도로 관리됩니다.</p>
      <form onSubmit={e=>{e.preventDefault();if(label.trim()&&cliAccountAgent(agent))void manage({operation:'create',agent,label:label.trim(),requestId:requestId()});}}>
        <label><span className="ai-terminal-label">계정 이름</span><input aria-label="추가할 CLI 계정 이름" className="ai-terminal-select" value={label} maxLength={64} disabled={busy} placeholder="예: 업무용 계정" onChange={e=>setLabel(e.target.value)}/></label>
        <button type="submit" className="ai-terminal-btn" disabled={busy||!label.trim()}>계정 추가</button>
      </form>
      {items.filter(s=>s.id!=='host-default').map(s=><div key={s.id} className="cli-account-row">
        <span><strong>{s.label}</strong> · {s.loginState==='authenticating'?'로그인 진행 중':s.loginState==='failed'?'로그인 완료 확인 필요':authLabel(s.authState)}</span>
        <button type="button" className="ai-terminal-btn" disabled={busy} onClick={()=>void manage({operation:s.loginState==='authenticating'?'cancel-login':'login',accountId:s.id,requestId:requestId()})}>{s.loginState==='authenticating'?'로그인 취소':'공식 로그인'}</button>
        <button type="button" className="ai-terminal-btn" disabled={busy||s.loginState==='authenticating'} onClick={()=>void manage({operation:'check',accountId:s.id,requestId:requestId()})}>상태 확인</button>
        <button type="button" className="ai-terminal-btn" disabled={busy||s.loginState==='authenticating'} onClick={()=>void manage({operation:'archive',accountId:s.id,requestId:requestId()})}>목록에서 제외</button>
      </div>)}
    </div>}
  </div>;
}
