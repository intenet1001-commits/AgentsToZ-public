import {createPortalGoogleOAuthUrl, type PortalOAuthClient} from './portalAuth';

export const NATIVE_PORTAL_CALLBACK = 'agentstoz-mobile://auth/callback';
export const NATIVE_PORTAL_AUTH_TIMEOUT_MS = 5 * 60_000;
export function nativePortalCallback(state:string):string {
  if(!/^[A-Za-z0-9_-]{43}$/.test(state))throw new Error('NATIVE_AUTH_INVALID_STATE');
  return `${NATIVE_PORTAL_CALLBACK}?state=${state}`;
}
export function nativePortalOAuthResult(value:unknown,state:string):{code:string}|{error:string}|null {
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const result=value as Record<string,unknown>;
  if(result.state!==state)return null;
  if(Object.keys(result).some(key=>!['state','code','error'].includes(key)))throw new Error('NATIVE_AUTH_INVALID_CALLBACK');
  if(typeof result.error==='string'&&!result.code)return {error:'iPhone의 로그인 창이 취소되었거나 완료되지 않았습니다.'};
  if(typeof result.code!=='string'||!result.code||result.code.length>2048||/[\s#]/.test(result.code)||result.error)throw new Error('NATIVE_AUTH_INVALID_CALLBACK');
  return {code:result.code};
}
type NativeWindow = Window & {agentstozNativeOAuth?:boolean;webkit?:{messageHandlers?:{agentstozOAuth?:{postMessage(value:{authorizeURL:string;state:string}):void}}}};
export function nativePortalOAuthAvailable(target:Window=window):boolean {
  const native=target as NativeWindow;
  return native.agentstozNativeOAuth===true&&typeof native.webkit?.messageHandlers?.agentstozOAuth?.postMessage==='function';
}
/** Only a one-use authorization code crosses the bridge. The SDK's verifier
 * and the controller's E2EE keys remain in their original WK data store. */
export async function signInWithNativePortalOAuth(options:{
  client:PortalOAuthClient & {auth:{exchangeCodeForSession(code:string):PromiseLike<{error:unknown}>}};
  supabaseUrl:string; target?:Window;
}):Promise<void> {
  const target=options.target??window;
  if(!nativePortalOAuthAvailable(target))throw new Error('NATIVE_AUTH_UNAVAILABLE');
  const bytes=crypto.getRandomValues(new Uint8Array(32));
  const state=btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const authorizeURL=await createPortalGoogleOAuthUrl({client:options.client,supabaseUrl:options.supabaseUrl,redirectTo:nativePortalCallback(state),nativeState:state});
  const code=await new Promise<string>((resolve,reject)=>{
    let timer:ReturnType<typeof setTimeout>;
    const clear=()=>{clearTimeout(timer);target.removeEventListener('agentstoz-oauth-result',receive);};
    const receive=(event:Event)=>{
      try{const result=nativePortalOAuthResult((event as CustomEvent).detail,state);if(!result)return;clear();if('error'in result)reject(new Error(result.error));else resolve(result.code);}
      catch(error){clear();reject(error);}
    };
    target.addEventListener('agentstoz-oauth-result',receive);
    timer=setTimeout(()=>{clear();reject(new Error('로그인 시간이 만료되었습니다. 연결 정보는 유지됩니다. 다시 로그인하세요.'));},NATIVE_PORTAL_AUTH_TIMEOUT_MS);
    try{(target as NativeWindow).webkit!.messageHandlers!.agentstozOAuth!.postMessage({authorizeURL,state});}
    catch(error){clear();reject(error);}
  });
  const result=await options.client.auth.exchangeCodeForSession(code);
  if(result.error)throw result.error;
}
