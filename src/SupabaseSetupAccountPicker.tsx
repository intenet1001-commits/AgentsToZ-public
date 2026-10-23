import {useEffect,useState} from 'react';
import {terminalLocalRequest} from './aiTerminalClient';
import {PLATFORM_CLI_PATH,type PlatformCliAccount} from './platformCliProtocol';
import {PlatformCliSettings} from './PlatformCliSettings';
export function SupabaseSetupAccountPicker({value,onChange}:{value:string;onChange:(id:string)=>void}){
  const [accounts,setAccounts]=useState<PlatformCliAccount[]>([]),[revision,setRevision]=useState(0),[error,setError]=useState('');
  useEffect(()=>{let current=true;setError('');void terminalLocalRequest(PLATFORM_CLI_PATH,{operation:'list',provider:'supabase'}).then(r=>{if(current)setAccounts(r.accounts.filter((a:PlatformCliAccount)=>a.provider==='supabase'&&a.state==='ready'&&a.verifiedEmail));}).catch(()=>{if(current)setError('계정 목록을 확인하지 못했습니다. 기존 CLI 사용 또는 다시 확인을 선택하세요.');});return()=>{current=false;};},[revision]);
  return <section aria-label="아젠투지 동기화용 Supabase 계정" className="space-y-3 rounded-xl border border-[var(--line)] p-4 text-sm">
    <h4 className="font-semibold">아젠투지 데이터를 관리할 Supabase 계정</h4>
    <p className="text-xs leading-5 text-[var(--ink-2)]">동기화·장기기억 백업을 둘 본인 소유 프로젝트의 관리 계정을 선택하세요. 아래 로그인 허용 이메일은 iPhone·웹앱에 접속할 사람이며 관리 계정과 달라도 됩니다. 선택만으로 앱 DB나 CLI 기본값은 바뀌지 않습니다.</p>
    <label className="block text-xs">Supabase 관리 계정<select aria-label="Supabase 관리 계정" value={value} onChange={e=>onChange(e.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-[var(--line)] bg-[var(--bg-input)] p-2"><option value="">현재 Supabase CLI 로그인 · 연결 시 권한 확인</option>{accounts.map(a=><option value={a.id} key={a.id}>{a.label.startsWith(a.verifiedEmail!)?a.label:a.verifiedEmail+' · '+a.label}</option>)}{value&&!accounts.some(a=>a.id===value)&&<option value={value} disabled>선택한 계정 확인 필요</option>}</select></label>
    <button type="button" className="min-h-11 rounded-lg border border-[var(--line)] px-3 text-xs" onClick={()=>setRevision(v=>v+1)}>연결한 계정 다시 읽기</button>
    {error&&<p role="status" className="text-xs">{error}</p>}
    <details><summary className="cursor-pointer text-xs">CLI가 없거나 다른 Supabase 계정을 연결하려면</summary><p className="mt-2 text-xs">아래에서 설치·기존 로그인·브라우저 연결을 진행한 뒤 ‘연결한 계정 다시 읽기’를 누르세요. 계정이 없으면 공식 로그인 화면에서 가입하세요.</p><PlatformCliSettings language="ko" projects={[]} initialProvider="supabase" purpose="app-sync-account"/></details>
  </section>;
}
