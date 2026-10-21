import {PlatformCliError,platformCliEmail,type PlatformCliProvider} from './platformCliProtocol';
/** Fixed HTTPS provider APIs only. Never use the app's Supabase client or native/global login. */
export async function platformCliJson(url:string,token:string):Promise<any> {
  const u=new URL(url);
  if(u.protocol!=='https:'||!['api.github.com','api.vercel.com','api.supabase.com'].includes(u.hostname)||u.username||u.password)throw new PlatformCliError('공식 서비스 주소를 확인하세요.');
  const r=await fetch(u,{headers:{Authorization:'Bearer '+token,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(15_000)});
  if(!r.ok)throw new PlatformCliError('선택한 계정의 이메일·대상 권한을 확인하지 못했습니다.');
  const value=await r.text();if(value.length>256*1024)throw new PlatformCliError('계정 확인 응답 한도를 초과했습니다.');return JSON.parse(value);
}
export type PlatformCliJson=typeof platformCliJson;
export async function platformCliVerifiedEmail(provider:PlatformCliProvider,secret:string,expected:string,json:PlatformCliJson=platformCliJson):Promise<string> {
  const email=platformCliEmail(expected);let actual:unknown;
  if(provider==='github'){
    const values=await json('https://api.github.com/user/emails?per_page=100',secret);
    if(Array.isArray(values))actual=values.find(v=>v.verified===true&&typeof v.email==='string'&&v.email.toLowerCase()===email)?.email;
  }
  if(provider==='vercel')actual=(await json('https://api.vercel.com/v2/user',secret.startsWith('{')?JSON.parse(secret).token:secret)).user?.email;
  if(provider==='supabase')actual=(await json('https://api.supabase.com/v1/profile',secret)).primary_email;
  if(typeof actual!=='string'||platformCliEmail(actual)!==email)throw new PlatformCliError('승인한 계정의 이메일이 요청한 이메일과 일치하지 않습니다. 다른 계정으로 연결하지 않았습니다.');
  return email;
}
