import {expect,test} from 'bun:test';
import {nativePortalCallback,nativePortalOAuthResult,signInWithNativePortalOAuth} from '../src/nativePortalOAuth';
import {createPortalGoogleOAuthUrl} from '../src/portalAuth';
const state='s'.repeat(43),origin='https://fixture.supabase.co';
function fixture(callback:(target:EventTarget,message:{state:string;authorizeURL:string})=>void){
  const exchanged:string[]=[];
  const target=Object.assign(new EventTarget(),{agentstozNativeOAuth:true,webkit:{messageHandlers:{agentstozOAuth:{postMessage(message:{state:string;authorizeURL:string}){callback(target,message);}}}}});
  const client={auth:{
    async signInWithOAuth(input:{options:{redirectTo:string}}){const u=new URL('/auth/v1/authorize',origin);for(const [key,value]of Object.entries({provider:'google',redirect_to:input.options.redirectTo,prompt:'select_account',code_challenge_method:'s256',code_challenge:'x'.repeat(43)}))u.searchParams.set(key,value);return {data:{url:u.toString()},error:null};},
    async exchangeCodeForSession(code:string){exchanged.push(code);return {error:null};},
  }};
  return {client,target:target as unknown as Window,exchanged};
}
test('native callback accepts only fixed scheme and a full random-state encoding',()=>{
  expect(nativePortalCallback(state)).toBe('agentstoz-mobile://auth/callback?state='+state);
  expect(()=>nativePortalCallback('weak')).toThrow();
});
test('web OAuth still refuses custom callbacks without explicit native-state binding',async()=>{
  const f=fixture(()=>{});
  await expect(createPortalGoogleOAuthUrl({client:f.client,supabaseUrl:origin,redirectTo:nativePortalCallback(state)})).rejects.toThrow();
  await expect(createPortalGoogleOAuthUrl({client:f.client,supabaseUrl:origin,redirectTo:'attacker://auth/callback?state='+state,nativeState:state})).rejects.toThrow();
});
test('native callback rejects foreign state, credentials, duplicate semantics and malformed code',()=>{
  expect(nativePortalOAuthResult({state:'foreign',code:'code'},state)).toBeNull();
  for(const input of [{state,code:'code',access_token:'secret'},{state,code:'code',error:'cancel'},{state,code:'code#token'},{state,code:''}])expect(()=>nativePortalOAuthResult(input,state)).toThrow();
});
test('native OAuth exchanges exactly one matching code and leaves controller storage untouched',async()=>{
  const f=fixture((target,message)=>{
    expect(new URL(message.authorizeURL).searchParams.get('redirect_to')).toBe(nativePortalCallback(message.state));
    target.dispatchEvent(new CustomEvent('agentstoz-oauth-result',{detail:{state:'foreign',code:'wrong'}}));
    target.dispatchEvent(new CustomEvent('agentstoz-oauth-result',{detail:{state:message.state,code:'one-use-code'}}));
    target.dispatchEvent(new CustomEvent('agentstoz-oauth-result',{detail:{state:message.state,code:'duplicate'}}));
  });
  await signInWithNativePortalOAuth({client:f.client,supabaseUrl:origin,target:f.target});
  expect(f.exchanged).toEqual(['one-use-code']);
});
test('native cancellation never exchanges a code',async()=>{
  const f=fixture((target,message)=>target.dispatchEvent(new CustomEvent('agentstoz-oauth-result',{detail:{state:message.state,error:'cancelled'}})));
  await expect(signInWithNativePortalOAuth({client:f.client,supabaseUrl:origin,target:f.target})).rejects.toThrow('취소');
  expect(f.exchanged).toEqual([]);
});
