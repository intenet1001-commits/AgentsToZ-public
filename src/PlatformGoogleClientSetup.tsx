import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {terminalLocalRequest} from './aiTerminalClient';
import {PLATFORM_CLI_PATH} from './platformCliProtocol';
import type {PlatformGoogleClientStatus} from './platformGoogleOAuthClient';
import {isTauri} from './lib/env';
import {registerWorkroomDropZone} from './workroomDropRouter';

type ClientFile=Pick<File,'name'|'size'|'text'>;

export function PlatformGoogleClientSetup({ko,disabled,onReady}:{ko:boolean;disabled:boolean;onReady:(ready:boolean)=>void}) {
  const [status,setStatus]=useState<PlatformGoogleClientStatus|null>(null),[busy,setBusy]=useState(true),[message,setMessage]=useState('');
  const epoch=useRef(0);
  const zone=useRef<HTMLDivElement>(null),uploading=useRef(false);
  const [dragging,setDragging]=useState(false);
  const live=useRef({disabled:disabled||busy,acceptFiles:(files:ClientFile[])=>{},acceptPaths:(paths:string[],total:number)=>{}});
  useLayoutEffect(()=>{
    const current=++epoch.current;onReady(false);setBusy(true);
    void terminalLocalRequest(PLATFORM_CLI_PATH,{operation:'google-client-status'}).then(r=>{
      if(epoch.current!==current)return;setStatus(r.googleClient);onReady(r.googleClient.ready);
    }).catch(()=>{if(epoch.current===current)setMessage(ko?'준비 상태를 읽지 못했습니다. 클라이언트 JSON을 다시 첨부하세요.':'Could not read client setup. Attach the client JSON again.');}).finally(()=>{if(epoch.current===current)setBusy(false);});
    return()=>{epoch.current++;};
  },[onReady,ko]);
  async function attach(file:ClientFile) {
    if(disabled||busy||uploading.current)return;
    const current=++epoch.current;setMessage('');
    if(!/\.json$/i.test(file.name)){setMessage(ko?'Google 클라이언트 JSON 파일을 선택하세요.':'Choose a Google client JSON file.');return;}
    if(file.size>16_384){setMessage(ko?'16KB 이하의 Google 클라이언트 JSON을 선택하세요.':'Choose a Google client JSON below 16 KB.');return;}
    uploading.current=true;
    setBusy(true);
    try{
      const clientJson=await file.text();if(epoch.current!==current)return;
      const r=await terminalLocalRequest(PLATFORM_CLI_PATH,{operation:'google-client-save',clientJson});
      if(epoch.current!==current)return;setStatus(r.googleClient);onReady(r.googleClient.ready);
      setMessage(ko?'클라이언트 파일을 준비했습니다. 아래에서 이메일을 입력하고 Google 로그인을 완료하세요.':'Client file is ready. Enter an email below and complete Google sign-in.');
    }catch(error){if(epoch.current===current)setMessage(error instanceof Error?error.message:(ko?'파일을 준비하지 못했습니다. 다시 첨부하세요.':'Could not prepare the file. Attach it again.'));}
    finally{uploading.current=false;if(epoch.current===current)setBusy(false);}
  }
  function acceptFiles(files:ClientFile[]) {
    if(disabled||busy||uploading.current)return;
    if(files.length!==1){setMessage(ko?'JSON 파일을 한 번에 하나만 넣어 주세요.':'Add one JSON file at a time.');return;}
    void attach(files[0]!);
  }
  function acceptPaths(paths:string[],total:number) {
    if(disabled||busy||uploading.current)return;
    if(total!==1||paths.length!==1){setMessage(ko?'JSON 파일을 한 번에 하나만 넣어 주세요.':'Add one JSON file at a time.');return;}
    const path=paths[0]!,name=path.split(/[/\\]/).at(-1)??'';
    void attach({name,size:0,text:async()=>{
      // Only read the OS-provided drop path through Tauri's existing scoped filesystem permission.
      const {stat,readTextFile}=await import('@tauri-apps/plugin-fs');
      let info;try{info=await stat(path);}catch{throw Error(ko?'드롭한 파일을 읽지 못했습니다. 파일 선택 버튼으로 첨부하세요.':'Could not read the dropped file. Use the file picker.');}
      if(!info.isFile)throw Error(ko?'폴더 대신 JSON 파일을 넣어 주세요.':'Drop a JSON file, not a folder.');
      if(info.size>16_384)throw Error(ko?'16KB 이하의 Google 클라이언트 JSON을 선택하세요.':'Choose a Google client JSON below 16 KB.');
      try{return await readTextFile(path);}catch{throw Error(ko?'드롭한 파일을 읽지 못했습니다. 파일 선택 버튼으로 첨부하세요.':'Could not read the dropped file. Use the file picker.');}
    }});
  }
  live.current={disabled:disabled||busy,acceptFiles,acceptPaths};
  useEffect(()=>{
    if(!isTauri()||!zone.current)return;
    // Use the single app drop arbiter: a JSON dropped here must not also attach to a Workroom or add a project.
    return registerWorkroomDropZone(zone.current,event=>{
      if(event.type==='leave'){setDragging(false);return;}
      if(event.type==='over'){setDragging(!live.current.disabled);return;}
      setDragging(false);if(!live.current.disabled)live.current.acceptPaths(event.paths,event.total);
    });
  },[]);
  return <section className="space-y-2 rounded-lg border border-[var(--line)] p-3" aria-label={ko?'Google 클라이언트 준비':'Google client setup'}>
    <h4 className="text-sm font-semibold">{ko?'1. Google 클라이언트 JSON 첨부':'1. Attach Google client JSON'}</h4>
    <p className="text-xs leading-5">{ko?'Google Cloud Console에서 받은 데스크톱 앱 OAuth 클라이언트 JSON을 선택하세요. 파일은 이 기기의 OS 자격 증명 저장소에 보관합니다. 파일 첨부만으로 계정이 연결되지는 않습니다.':'Choose the Desktop app OAuth client JSON downloaded from Google Cloud Console. It is stored in this device’s OS credential store. Attaching a file does not connect an account.'}</p>
    <div ref={zone} role="group" aria-label={ko?'Google JSON 파일 첨부 영역':'Google JSON attachment area'} aria-busy={busy} aria-disabled={disabled||busy}
      className={'rounded-lg border-2 border-dashed p-4 '+(dragging?'border-[var(--accent)] bg-[var(--accent-soft)]':'border-[var(--line)]')}
      onDragOver={e=>{e.preventDefault();e.stopPropagation();if(isTauri())return;const files=Array.from(e.dataTransfer.types).includes('Files');e.dataTransfer.dropEffect=files&&!disabled&&!busy?'copy':'none';setDragging(files&&!disabled&&!busy);}}
      onDragLeave={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node|null))setDragging(false);}}
      onDrop={e=>{e.preventDefault();e.stopPropagation();setDragging(false);if(!isTauri())acceptFiles(Array.from(e.dataTransfer.files));}}>
      <p className="mb-2 text-sm">{ko?'JSON 파일을 여기에 끌어 놓거나 아래에서 선택하세요.':'Drop a JSON file here or choose one below.'}</p>
      <label className="block text-xs">{ko?'Google Console 클라이언트 JSON':'Google Console client JSON'}<input type="file" accept=".json,application/json" className="mt-2 block max-w-full min-h-[44px] text-xs" disabled={disabled||busy} onChange={e=>{const files=Array.from(e.target.files??[]);e.target.value='';if(files.length)acceptFiles(files);}}/></label>
    </div>
    <p className="text-xs" role="status">{busy?(ko?'클라이언트 준비 확인 중':'Checking client setup'):status?.ready?(ko?'클라이언트 준비됨 · 계정 로그인은 별도':'Client ready · account sign-in is separate'):(ko?'클라이언트 파일 필요':'Client file required')}{status?.ready&&status.projectId?' · '+status.projectId:''}{status?.source==='existing-cli'?(ko?' · 기존 gws 설정 사용':' · Using existing gws setup'):''}</p>
    <details className="text-xs leading-5"><summary className="cursor-pointer">{ko?'Google Console에서 파일 받는 방법':'How to get the file from Google Console'}</summary>
      <ol className="mt-2 list-decimal space-y-2 pl-5">
        <li><a className="underline" href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noreferrer">{ko?'프로젝트 선택 후 Google Drive API 사용 설정':'Select a project and enable the Google Drive API'}</a></li>
        <li><a className="underline" href="https://console.cloud.google.com/auth/audience" target="_blank" rel="noreferrer">{ko?'OAuth 동의 화면 설정':'Configure the OAuth consent screen'}</a>{ko?' · 테스트 중인 외부 앱이면 연결할 이메일을 각각 테스트 사용자에 추가하세요.':' · For an external app in testing, add every account you want to connect as a test user.'}</li>
        <li><a className="underline" href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">{ko?'OAuth 클라이언트 ID 만들기':'Create an OAuth client ID'}</a>{ko?' → 유형: 데스크톱 앱 → JSON 다운로드 → 위에 첨부':' → Type: Desktop app → Download JSON → Attach above'}</li>
      </ol>
    </details>
    <p className="text-xs leading-5">{ko?'같은 클라이언트 파일로 여러 계정을 연결할 수 있습니다. 계정마다 해당 브라우저 프로필에서 Google 승인을 완료하세요. 파일 교체는 이후 로그인에 적용되며 기존에 연결한 계정을 바꾸지 않습니다.':'You can connect multiple accounts with the same client file. Complete Google approval in each account’s browser profile. Replacing the file applies to future sign-ins and keeps connected accounts unchanged.'}</p>
    {message&&<p className="break-words text-xs leading-5" role="status">{message}</p>}
  </section>;
}
