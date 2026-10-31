import {useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {PlatformCliSettings} from '../../src/PlatformCliSettings';
import {pushWithPlatformAccount} from '../../src/PlatformGithubPushDialog';
import {useAppLanguage} from '../../src/useAppLanguage';
import {mockIPC,mockWindows} from '@tauri-apps/api/mocks';
import {emit} from '@tauri-apps/api/event';
import {workroomOwnsDropAt} from '../../src/workroomDropRouter';
import {FirstSetupWizard} from '../../src/SetupWizard';
if(new URLSearchParams(location.search).has('native-drop')){
  const files:Record<string,{text?:string;size?:number;isFile?:boolean}>={},reads:string[]=[];
  mockWindows('main');
  mockIPC(async(command,args:any)=>{
    if(command==='list_browser_profiles')return [];
    if(command==='agent_runtime_request'){
      const r=await fetch(args.path,{method:args.method,headers:{'Content-Type':'application/json'},body:JSON.stringify(args.body)});
      return {status:r.status,body:await r.json()};
    }
    if(command==='plugin:window|inner_size')return {width:innerWidth,height:innerHeight};
    if(command==='plugin:window|scale_factor')return 1;
    if(command==='plugin:fs|stat'){
      const file=files[args.path];if(!file)throw Error('synthetic access denied');
      return {isFile:file.isFile!==false,isDirectory:file.isFile===false,isSymlink:false,size:file.size??new TextEncoder().encode(file.text??'').length,mtime:null,atime:null,birthtime:null};
    }
    if(command==='plugin:fs|read_text_file'){
      const file=files[args.path];if(!file)throw Error('synthetic access denied');reads.push(args.path);return new TextEncoder().encode(file.text??'');
    }
    throw Error('Unexpected synthetic command: '+command);
  },{shouldMockEvents:true});
  (window as any).__nativeGoogleDrop={files,reads,emit,owns:workroomOwnsDropAt};
}
function App(){const [message,setMessage]=useState(''),[language,setLanguage]=useAppLanguage();if(new URLSearchParams(location.search).has('first-wizard'))return <main className="fixture"><FirstSetupWizard onComplete={v=>setMessage(JSON.stringify(v))} onBack={()=>{}} onAdvanced={()=>{}}/><p data-testid="setup-result">{message}</p></main>;return <main className="fixture"><h1>프로젝트 CLI 연결</h1><button onClick={()=>setLanguage('en')}>English</button><PlatformCliSettings language={language} projects={[{id:'project-one',name:'회사 프로젝트'},{id:'project-two',name:'개인 프로젝트'}]}/><button onClick={()=>void pushWithPlatformAccount('project-one','FIXTURE').then(setMessage,e=>setMessage(e.message))}>프로젝트 푸시</button><p role="status" data-testid="push-result">{message}</p></main>;}
function ModalFixture(){const ref=useRef<HTMLDialogElement>(null);useEffect(()=>{ref.current?.showModal();},[]);return <dialog ref={ref}><App/></dialog>;}
createRoot(document.getElementById('root')!).render(new URLSearchParams(location.search).has('native-modal')?<ModalFixture/>:<App/>);
