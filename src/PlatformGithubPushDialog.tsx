import {platformCliAccountOptions} from './platformCliAccountOptions';
import {useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {terminalLocalRequest} from './aiTerminalClient';
import {PLATFORM_CLI_PATH,type PlatformCliAccount} from './platformCliProtocol';
import type {GithubPushPlan} from './platformGithubPush';
import {useAppLanguage} from './useAppLanguage';
interface Options {projectLabel:string;accounts:PlatformCliAccount[];defaultAccountId:string;defaultRemote:string|null;binding:{accountId:string;resourceId:string}|null;remotes:{name:string;repository:string}[]}
function PushDialog({targetId,folderPath,finish}:{targetId:string;folderPath:string;finish:(error:Error|null,output?:string)=>void}) {
  const [language]=useAppLanguage(),ko=language==='ko',copy=(korean:string,english:string)=>ko?korean:english;
  const dialog=useRef<HTMLDialogElement>(null),requestId=useRef(crypto.randomUUID());
  const [options,setOptions]=useState<Options|null>(null),[accountId,setAccountId]=useState(''),[remote,setRemote]=useState('');
  const [plan,setPlan]=useState<GithubPushPlan|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[uncertain,setUncertain]=useState(false);
  useEffect(()=>{
    let current=true;dialog.current?.showModal();
    void terminalLocalRequest(PLATFORM_CLI_PATH,{operation:'push-options',targetId,folderPath}).then(r=>{
      if(!current)return;const v=r.options as Options;setOptions(v);
      setAccountId(v.defaultAccountId);setRemote(v.defaultRemote??'');
    }).catch(e=>{if(current)setMessage(e instanceof Error?e.message:'푸시 대상을 확인하지 못했습니다.');});
    return()=>{current=false;};
  },[targetId,folderPath]);
  async function submit() {
    if(busy)return;setBusy(true);setMessage('');
    try {
      if(!plan){const r=await terminalLocalRequest(PLATFORM_CLI_PATH,{operation:'prepare-push',targetId,folderPath,accountId,remote});if(!r.plan)throw Error('계정과 저장소를 선택하세요.');setPlan(r.plan);}
      else{
        // Reuse this request ID even after a timeout; the host returns the original receipt.
        setUncertain(true);
        const r=await terminalLocalRequest(PLATFORM_CLI_PATH,{operation:'execute-push',targetId,planId:plan.id,requestId:requestId.current});
        if(r.receipt?.state==='completed'){finish(null,`${plan.identity} → ${plan.repository} · ${plan.branch}`);return;}
        setMessage(r.receipt?.state==='executing'?'푸시 결과가 미확정입니다. 원격 저장소의 커밋을 확인하세요. 자동으로 다시 전송하지 않습니다.':'푸시가 완료되지 않았습니다. 권한과 원격 브랜치 상태를 확인하세요.');
      }
    }catch(error){setMessage(error instanceof Error?error.message:'결과를 확인하지 못했습니다. 같은 요청으로 상태를 확인하세요.');}
    finally{setBusy(false);}
  }
  return <dialog ref={dialog} onCancel={e=>{e.preventDefault();if(!busy)finish(new Error('푸시를 취소했습니다.'));}} aria-labelledby="platform-github-push-title" className="w-[min(480px,calc(100vw-32px))] max-h-[calc(100dvh-32px)] overflow-y-auto rounded-2xl border border-[var(--line)] bg-[var(--bg-card)] p-6 text-[var(--ink)] shadow-xl backdrop:bg-black/60">
    <h2 id="platform-github-push-title" className="text-lg font-semibold">{copy('GitHub 푸시','GitHub push')}</h2><p className="mt-1 text-sm text-[var(--ink-3)]">{options?.projectLabel??copy('대상 확인 중','Loading project')}</p>
    {options&&!plan&&<div className="my-5 space-y-3">
      <label className="block text-sm">{copy('GitHub 계정','GitHub account')}<select aria-label={copy('GitHub 계정','GitHub account')} className="mt-1 w-full rounded-lg border border-[var(--line)] bg-[var(--bg-input)] p-2" value={accountId} disabled={busy} onChange={e=>setAccountId(e.target.value)}><option value="">{copy('사용할 계정 선택','Choose an account')}</option>{platformCliAccountOptions(options.accounts,'github',accountId).map(a=><option key={a.id} value={a.id}>{a.source==='default'?a.label+(a.state==='login-required'?copy(' · 로그인 필요',' · Sign-in required'):''):a.source==='native'?a.identity+' · '+copy('기존 로그인','Existing login'):a.label}{a.identity&&a.source!=='native'?' · '+a.identity:''}</option>)}</select></label>
      <label className="block text-sm">{copy('전송할 저장소','Destination repository')}<select aria-label={copy('전송할 저장소','Destination repository')} className="mt-1 w-full rounded-lg border border-[var(--line)] bg-[var(--bg-input)] p-2" value={remote} disabled={busy} onChange={e=>setRemote(e.target.value)}><option value="">{copy('저장소 선택','Choose a repository')}</option>{options.remotes.map(r=><option key={r.name} value={r.name}>{r.name} · {r.repository}</option>)}</select></label>
      <p className="text-xs">{copy('프로젝트 지정 계정이 기기 기본값보다 우선합니다. 저장소와 실제 인증 계정은 전송 전에 확인합니다.','Project overrides take priority over device defaults. Review the destination and authenticated account before sending.')}</p>
      {!options.remotes.length&&<p className="text-xs">{copy('푸시할 GitHub 원격을 확인하지 못했습니다. 저장소 설정을 확인하세요.','No GitHub remote was found. Check the project repository settings.')}</p>}
    </div>}
    {plan&&<dl className="my-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 break-all rounded-xl border border-[var(--line)] p-4 text-sm"><dt>{copy('계정','Account')}</dt><dd>{plan.accountId.startsWith('pcli_gh_')?copy('기존 로그인','Existing login'):plan.accountId==='pcli_environment'?copy('현재 CLI 로그인','Current CLI login'):plan.accountLabel} · {plan.identity}</dd><dt>{copy('저장소','Repository')}</dt><dd>{plan.repository}</dd><dt>{copy('브랜치','Branch')}</dt><dd>{plan.branch}</dd><dt>{copy('커밋','Commit')}</dt><dd>{plan.head.slice(0,12)}</dd></dl>}
    {message&&<p role="status" className="my-3 text-sm leading-6">{message}</p>}
    <div className="mt-4 flex flex-wrap justify-end gap-2"><button type="button" className="min-h-[44px] rounded-lg border border-[var(--line)] px-4 py-2" disabled={busy} onClick={()=>finish(new Error(copy('푸시를 취소했습니다.','Push cancelled.')))}>{copy('닫기','Close')}</button>
      <button type="button" className="min-h-[44px] rounded-lg bg-[var(--accent)] px-4 py-2 text-[var(--on-accent)] disabled:opacity-50" disabled={busy||!plan&&(!accountId||!remote)} onClick={()=>void submit()}>{busy?copy('확인 중…','Checking…'):uncertain?copy('같은 요청의 결과 확인','Check the same request'):plan?copy('이 계정으로 푸시','Push with this account'):copy('대상 확인','Review destination')}</button></div>
  </dialog>;
}
export function pushWithPlatformAccount(targetId:string,folderPath:string):Promise<string> {
  return new Promise((resolve,reject)=>{
    const element=document.createElement('div');document.body.append(element);const root=createRoot(element);let done=false;
    const finish=(error:Error|null,output?:string)=>{if(done)return;done=true;queueMicrotask(()=>{root.unmount();element.remove();});if(error)reject(error);else resolve(output??'');};
    root.render(<PushDialog targetId={targetId} folderPath={folderPath} finish={finish}/>);
  });
}
