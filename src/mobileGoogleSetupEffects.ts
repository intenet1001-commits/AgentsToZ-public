import type {PlatformCliHost} from './platformCliHost';
import {platformCliManagedId} from './platformCliProtocol';
import type {MobileGoogleAccount,MobileGoogleEffects} from './mobileGoogleSetup';

/** Credentials are resolved inside the host's existing account isolation. No
 * token, provider secret or arbitrary project URL crosses the UI boundary. */
export function createMobileGoogleSetupEffects(host:PlatformCliHost,supabaseUrl:()=>unknown,fetcher:typeof fetch=fetch):MobileGoogleEffects {
  const target=()=>{
    const url=supabaseUrl(),match=typeof url==='string'?/^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/.exec(url):null;
    if(!match)throw Error('이 Mac의 Supabase Cloud 저장소를 먼저 연결하세요. 자체 호스팅은 공식 설정 화면에서 준비하세요.');
    return {ref:match[1]!};
  };
  const account=async(id:string):Promise<MobileGoogleAccount>=>{
    if(!platformCliManagedId(id))throw Error('인증된 Supabase CLI 계정을 선택하세요.');
    const a=host.store.account(id);
    if(a.provider!=='supabase'||a.state!=='ready'||!a.verifiedEmail)throw Error('Supabase CLI 계정 인증을 먼저 완료하세요.');
    return {id:a.id,revision:a.revision,email:a.verifiedEmail};
  };
  const api=async(ref:string,a:MobileGoogleAccount,patch?:Record<string,unknown>)=>{
    if(!/^[a-z0-9]{20}$/.test(ref))throw Error('Supabase 프로젝트를 확인하세요.');
    if(patch!==undefined&&Object.keys(patch).some(k=>!['external_google_enabled','external_google_client_id','external_google_secret','uri_allow_list'].includes(k)))throw Error('검토한 Google 설정만 적용할 수 있습니다.');
    const current=await account(a.id);
    if(current.revision!==a.revision||current.email!==a.email)throw Error('인증한 Supabase 계정이 바뀌었습니다.');
    const stored=host.store.account(a.id);
    try{
      return await host.using(stored,{id:'helpdesk-google-login',cwd:host.store.root,label:'모바일 Google 로그인 준비'},[],async execution=>{
        if(target().ref!==ref||(await account(a.id)).revision!==a.revision)throw Error();
        const token=execution.env.SUPABASE_ACCESS_TOKEN;
        if(!token)throw Error();
        const response=await fetcher(`https://api.supabase.com/v1/projects/${ref}/config/auth`,{
          method:patch===undefined?'GET':'PATCH',redirect:'error',signal:AbortSignal.timeout(20_000),
          headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
          ...(patch===undefined?{}:{body:JSON.stringify(patch)}),
        });
        if(!response.ok){await response.body?.cancel();throw Error();}
        // PATCH responses can contain the complete auth configuration, including
        // SMTP secrets. Discard them; the coordinator performs a bounded GET.
        if(patch!==undefined){await response.body?.cancel();return {};}
        const reader=response.body?.getReader();if(!reader)throw Error();
        const chunks:Uint8Array[]=[];let size=0;
        try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>256_000){await reader.cancel();throw Error();}chunks.push(part.value);}}
        finally{reader.releaseLock();}
        const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if(!value||typeof value!=='object'||Array.isArray(value))throw Error();
        // Only fields used for this reviewed operation leave the API adapter.
        return Object.fromEntries(['external_google_enabled','external_google_client_id','external_google_secret','uri_allow_list','rate_limit_email_sent'].filter(k=>Object.hasOwn(value,k)).map(k=>[k,value[k]]));
      });
    }catch{throw Error(patch===undefined?'Supabase Google 설정을 읽지 못했습니다. 관리 권한과 연결을 확인하세요.':'Supabase 적용 결과가 미확정입니다. 결과 확인만 하며 자동 재실행하지 않습니다.');}
  };
  return {
    target,
    account,read:(ref,a)=>api(ref,a),patch:async(ref,a,value)=>{await api(ref,a,value);},
  };
}
