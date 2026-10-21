import {useEffect,useRef,useState} from 'react';
import {Copy,FolderOpen,RefreshCw} from 'lucide-react';
import {isTauri} from './lib/env';
import {normalizeSdkFolderDirectory,type SdkFolderDirectory,type SdkFolderRow} from './sdkProjectFolderContract';
import './SdkProjectFolders.css';

const endpoint=(operation:string)=>`${isTauri()?'http://127.0.0.1:3001':''}/api/sdk-project/${operation}`;
async function request(operation:string,body:unknown,signal?:AbortSignal){
  const response=await fetch(endpoint(operation),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:signal??AbortSignal.timeout(15_000)});
  const result=await response.json();if(!response.ok||result?.success!==true)throw new Error(result?.error||'SDK 하위 폴더를 확인하지 못했습니다.');return result;
}

/** SDK registration owns this view. Mounting lists direct children and never prepares or opens anything. */
export function SdkProjectFolders({projectId,projectName}:{projectId:string;projectName:string}){
  const [directory,setDirectory]=useState<SdkFolderDirectory|null>(null);
  const [loading,setLoading]=useState(true),[error,setError]=useState(''),[message,setMessage]=useState('');
  const [refresh,setRefresh]=useState(0),[opening,setOpening]=useState('');
  const generation=useRef(0),openFlight=useRef(false);
  useEffect(()=>{
    const current=++generation.current,controller=new AbortController();setLoading(true);setError('');setMessage('');setDirectory(null);setOpening('');openFlight.current=false;
    void request('folders',{portId:projectId},controller.signal).then(result=>{
      if(generation.current!==current)return;const next=normalizeSdkFolderDirectory(result.directory);if(next.projectId!==projectId)throw new Error('선택한 SDK 프로젝트의 목록을 다시 확인하세요.');setDirectory(next);
    }).catch(reason=>{if(!controller.signal.aborted&&generation.current===current)setError(reason instanceof Error?reason.message:'SDK 하위 폴더를 확인하지 못했습니다.');})
      .finally(()=>{if(generation.current===current)setLoading(false);});
    return()=>{controller.abort();generation.current++;};
  },[projectId,refresh]);
  const openFolder=async(folder:SdkFolderRow)=>{
    if(!folder.id||openFlight.current)return;const current=generation.current;openFlight.current=true;setOpening(folder.id);setError('');setMessage('');
    try{const result=await request('open-folder',{portId:projectId,folderId:folder.id});if(generation.current!==current)return;if(result.opened!==true||result.folderId!==folder.id)throw new Error('폴더 열기 응답을 확인하지 못했습니다.');setMessage(`${folder.name} 폴더 열기를 요청했습니다.`);}
    catch(reason){if(generation.current===current)setError(reason instanceof Error?reason.message:'폴더를 열지 못했습니다.');}
    finally{if(generation.current===current){openFlight.current=false;setOpening('');}}
  };
  const copy=async(folder:SdkFolderRow)=>{
    if(!folder.mention)return;const current=generation.current;setError('');setMessage('');
    try{await navigator.clipboard.writeText(folder.mention);if(generation.current===current)setMessage(`${folder.name} 참고 멘션을 복사했습니다.`);}
    catch{if(generation.current===current)setError('클립보드에 복사하지 못했습니다. 아래 참고 문구를 직접 복사해 주세요.');}
  };
  return <section className="sdk-project-folders" data-testid="sdk-project-folders" aria-label="SDK 모듈과 하위 폴더">
    <header><div><h3>SDK 모듈·하위 폴더</h3><p>{directory?.projectName??projectName}에서 필요한 SDK의 폴더를 열거나 참고 멘션을 복사하세요.</p></div><button type="button" aria-label="SDK 하위 폴더 새로고침" disabled={loading||!!opening} onClick={()=>setRefresh(value=>value+1)}><RefreshCw size={14}/></button></header>
    {loading&&<p role="status">하위 폴더를 확인하고 있습니다…</p>}
    {error&&<p className="sdk-folder-error" role="alert">{error}</p>}
    {message&&<p role="status" data-testid="sdk-folder-message">{message}</p>}
    {directory&&<>
      <p className="sdk-folder-count">이 Mac의 폴더 {directory.folders.filter(folder=>folder.state==='present').length}개{directory.limited?' · 일부만 확인함':''}</p>
      <div className="sdk-folder-list" role="region" aria-label="SDK 폴더 목록" tabIndex={0}><ul>{directory.folders.map(folder=><li key={folder.relativePath} data-testid="sdk-folder-row" data-folder-state={folder.state}>
        <div><strong>{folder.name}</strong><p>{folder.description}</p>{folder.moduleId&&<small>모듈 {folder.moduleId}</small>}{folder.state==='missing'&&<small>이 Mac에 폴더 없음</small>}</div>
        <div className="sdk-folder-actions"><button type="button" disabled={!folder.id||!!opening} onClick={()=>void openFolder(folder)}><FolderOpen size={14}/>{opening===folder.id?'확인 중…':'폴더 열기'}</button><button type="button" disabled={!folder.mention} onClick={()=>void copy(folder)}><Copy size={14}/>멘션 복사</button></div>
        {folder.mention&&<details className="sdk-folder-reference"><summary>참고 문구</summary><p>{folder.mention}</p></details>}
      </li>)}</ul></div>
      {!directory.folders.length&&<p>표시할 SDK 하위 폴더가 없습니다.</p>}
      {directory.limited&&<p>폴더가 많아 확인 범위가 제한되었습니다. 표시된 폴더만 열 수 있습니다.</p>}
      {directory.ignoredSymlinks>0&&<p>연결 폴더 {directory.ignoredSymlinks}개는 제외했습니다.</p>}
    </>}
  </section>;
}
