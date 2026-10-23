import { existsSync } from 'node:fs';
import type { Browser, BrowserContext, Page } from 'playwright';
import { BROWSER_CONTEXT_LIMITS as limits, BrowserContextError, fetchBrowserDocument, resolveBrowserUrl } from './browserContextPolicy';

type SessionInfo = {sessionId:string;url:string;title:string;createdAt:string;expiresAt:string};
type Session = {info:SessionInfo;context:BrowserContext;page:Page;busy:boolean;timer:ReturnType<typeof setTimeout>};
export class BrowserContextHost {
  private browser: Browser | null = null;
  private sessions = new Map<string,Session>();
  private opening = false;
  private reads=new Map<string,Promise<void>>();
  private closing=new Map<string,Promise<void>>();
  private disposed = false;
  private openingDone:Promise<void> = Promise.resolve();
  private shutdownAbort=new AbortController();
  constructor(private options: {packaged:boolean;registeredPorts:()=>Promise<number[]>;openTimeoutMs?:number;readTimeoutMs?:number}) {}
  private async runtime() {
    if (this.options.packaged) throw new BrowserContextError('browser_context_unavailable','설치 앱에는 격리 Chromium 런타임이 아직 포함되지 않았습니다. 개발 환경에서만 사용할 수 있습니다.',503);
    try {
      // Variable import keeps this optional development dependency out of compiled sidecars.
      const moduleName = 'playwright';
      const module = await import(moduleName) as typeof import('playwright');
      if (!existsSync(module.chromium.executablePath())) throw Error('missing browser');
      return module.chromium;
    } catch {throw new BrowserContextError('browser_context_unavailable','이 환경에서 Playwright/Chromium을 찾지 못했습니다. 브라우저를 자동 설치하지 않습니다.',503);}
  }
  private async close(id:string) {
    const pending=this.closing.get(id);if(pending)return pending;
    const session=this.sessions.get(id);if(!session)return;
    this.sessions.delete(id);clearTimeout(session.timer);
    const work=(async()=>{try{
      await session.context.close().catch(()=>{});
      if(!this.sessions.size&&!this.opening){const browser=this.browser;this.browser=null;await browser?.close().catch(()=>{});}
    }finally{this.closing.delete(id);}})();
    this.closing.set(id,work);return work;
  }
  async dispose(){this.disposed=true;this.shutdownAbort.abort();await this.openingDone;await Promise.all([...this.sessions.keys()].map(id=>this.close(id)));await Promise.all(this.reads.values());await Promise.all(this.closing.values());const browser=this.browser;this.browser=null;await browser?.close().catch(()=>{});}
  async perform(body:Record<string,unknown>):Promise<Record<string,unknown>> {
    if(this.disposed)throw new BrowserContextError('browser_context_unavailable','브라우저 런타임이 종료 중입니다.',503);
    const operation=body.operation;
    const keys=operation==='status'?['operation']:operation==='open'?['operation','url']:operation==='read'?['operation','sessionId','screenshot']:operation==='close'?['operation','sessionId']:[];
    if(!keys.length||Object.keys(body).some(key=>!keys.includes(key)))throw new BrowserContextError('browser_context_invalid_request','허용되지 않은 브라우저 요청입니다.');
    if(operation==='status') {
      try {await this.runtime();return {success:true,available:true,runtime:'isolated-chromium',reason:null,limits,sessions:[...this.sessions.values()].map(s=>s.info)};}
      catch(error){return {success:true,available:false,runtime:'isolated-chromium',reason:(error as Error).message,limits,sessions:[]};}
    }
    if(operation==='open') {
      if(this.opening||new Set([...this.sessions.keys(),...this.reads.keys(),...this.closing.keys()]).size>=limits.maxSessions)throw new BrowserContextError('browser_context_busy','브라우저 작업 중이거나 세션 한도에 도달했습니다. 기존 세션을 닫고 다시 시도하세요.',409);
      this.opening=true;let finishOpening!:()=>void;this.openingDone=new Promise<void>(resolve=>{finishOpening=resolve;});let context:BrowserContext|undefined;
      const openAbort=new AbortController();
      const deadlineAt=Date.now()+Math.min(15_000,this.options.openTimeoutMs??15_000);
      const signal=AbortSignal.any([this.shutdownAbort.signal,openAbort.signal]);
      const check=()=>{if(signal.aborted||Date.now()>=deadlineAt)throw new BrowserContextError('browser_context_open_timeout','페이지 열기 시간이 초과되었거나 취소됐습니다. 다시 시도하세요.',408);};
      const timeout=()=>Math.max(1,Math.min(7000,deadlineAt-Date.now()));
      let deadlineReject!:(error:BrowserContextError)=>void;
      const deadlineResult=new Promise<never>((_,reject)=>{deadlineReject=reject;});
      const openTimer=setTimeout(()=>{
        deadlineReject(new BrowserContextError('browser_context_open_timeout','페이지 열기 시간이 초과됐습니다. 다시 시도하세요.',408));
        openAbort.abort();
        if(context)void context.close().catch(()=>{});
        else if(this.browser){
          // A stuck newContext has no context handle yet. Close this owned browser,
          // invalidating its old sessions, rather than let a protocol wait outlive admission.
          const browser=this.browser;this.browser=null;
          for(const session of this.sessions.values())clearTimeout(session.timer);
          this.sessions.clear();void browser.close().catch(()=>{});
        }
      },Math.max(1,deadlineAt-Date.now()));
      const work=(async()=>{try {
        const chromium=await this.runtime();check();
        const target=await resolveBrowserUrl(body.url,await this.options.registeredPorts());check();
        const html=await fetchBrowserDocument(target,signal);
        check();if(!this.browser)this.browser=await chromium.launch({headless:true,chromiumSandbox:true,timeout:timeout()});check();
        context=await this.browser.newContext({javaScriptEnabled:false,serviceWorkers:'block',acceptDownloads:false,viewport:{width:1100,height:760},permissions:[]});check();
        const page=await context.newPage();check();page.setDefaultTimeout(timeout());
        let served=false;
        await context.route('**/*',async route=>{
          if(!served && route.request().isNavigationRequest() && route.request().frame()===page.mainFrame() && route.request().url()===target.url.href && route.request().method()==='GET') {
            served=true;await route.fulfill({status:200,contentType:'text/html; charset=utf-8',headers:{'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'",'Cache-Control':'no-store'},body:html});
          } else await route.abort();
        });
        context.on('page',popup=>{if(popup!==page)void popup.close();});
        await page.goto(target.url.href,{waitUntil:'domcontentloaded',timeout:timeout()});
        // Remove editable/user-account fields from both text and screenshot. No page-owned script runs.
        await page.evaluate(()=>{
          document.querySelectorAll('script,noscript,iframe,frame,object,embed,form,input,textarea,select,button,[contenteditable],meta[http-equiv],link,base').forEach(e=>e.remove());
          document.querySelectorAll('[hidden],[aria-hidden="true"]').forEach(e=>e.remove());
        });
        const title=(await page.title()).slice(0,256);check();
        if(this.disposed)throw new BrowserContextError('browser_context_unavailable','브라우저 런타임이 종료 중입니다.',503);
        const id=crypto.randomUUID(),now=Date.now();
        const info:SessionInfo={sessionId:id,url:target.url.href,title,createdAt:new Date(now).toISOString(),expiresAt:new Date(now+limits.ttlMs).toISOString()};
        const timer=setTimeout(()=>{void this.close(id);},limits.ttlMs);timer.unref?.();
        this.sessions.set(id,{info,context,page,busy:false,timer});return {success:true,session:info};
      } catch(error){await context?.close().catch(()=>{});if(!this.sessions.size){const browser=this.browser;this.browser=null;await browser?.close().catch(()=>{});}throw error instanceof BrowserContextError?error:new BrowserContextError('browser_context_open_failed','격리 브라우저를 열지 못했습니다. 런타임과 페이지 상태를 확인하세요.',503);}
      finally{clearTimeout(openTimer);this.opening=false;finishOpening();}
      })();
      // A deadline may answer the caller, but admission stays held until work's real finalizer.
      return await Promise.race([work,deadlineResult]);
    }
    if(typeof body.sessionId!=='string'||!/^[0-9a-f-]{36}$/.test(body.sessionId))throw new BrowserContextError('browser_context_invalid_request','세션 ID를 확인하세요.');
    if(operation==='close'&&this.closing.has(body.sessionId)){await this.close(body.sessionId);return {success:true};}
    const session=this.sessions.get(body.sessionId);
    if(!session)throw new BrowserContextError('browser_context_session_missing','세션이 만료되었거나 닫혔습니다. 페이지를 다시 여세요.',404);
    if(operation==='close'){await this.close(body.sessionId);return {success:true};}
    if(body.screenshot!==undefined&&typeof body.screenshot!=='boolean')throw new BrowserContextError('browser_context_invalid_request','미리보기 선택을 확인하세요.');
    if(session.busy)throw new BrowserContextError('browser_context_busy','페이지를 읽고 있습니다.',409);
    session.busy=true;
    const id=session.info.sessionId;let finishRead!:()=>void;
    this.reads.set(id,new Promise<void>(resolve=>{finishRead=resolve;}));
    let expired=false,cleanup:Promise<void>|undefined;
    let deadlineReject!:(error:BrowserContextError)=>void;
    const deadline=new Promise<never>((_,reject)=>{deadlineReject=reject;});
    const readTimer=setTimeout(()=>{
      expired=true;deadlineReject(new BrowserContextError('browser_context_read_timeout','페이지 읽기 시간이 초과됐습니다. 다시 열어 주세요.',408));
      cleanup=this.close(id);
    },Math.min(8000,this.options.readTimeoutMs??8000));
    const check=()=>{if(expired||!this.sessions.has(id))throw new BrowserContextError('browser_context_read_failed','페이지가 닫혔습니다. 다시 열어 주세요.',409);};
    const work=(async()=>{try {
      const data=await session.page.evaluate(({textChars,maxLinks})=>{
        const text=document.body?.innerText??'';
        const links=Array.from(document.querySelectorAll('a[href]')).slice(0,200).flatMap(a=>{try{const u=new URL((a as HTMLAnchorElement).href);return ['http:','https:'].includes(u.protocol)&&!u.search&&!u.hash&&!u.username&&!u.password?[{text:(a.textContent??'').trim().slice(0,200),url:u.href.slice(0,2048)}]:[];}catch{return [];}}).slice(0,maxLinks);
        return {text:text.slice(0,textChars),truncated:text.length>textChars,links};
      },{textChars:limits.textChars,maxLinks:limits.links});
      check();let screenshotDataUrl:string|null=null;
      if(body.screenshot){const bytes=await session.page.screenshot({type:'jpeg',quality:55,fullPage:false,timeout:5000});if(bytes.length<=350_000)screenshotDataUrl=`data:image/jpeg;base64,${bytes.toString('base64')}`;}
      check();return {success:true,snapshot:{sessionId:session.info.sessionId,url:session.info.url,title:session.info.title,...data,capturedAt:new Date().toISOString(),untrusted:true,screenshotDataUrl}};
    }catch{throw new BrowserContextError('browser_context_read_failed','페이지를 읽지 못했습니다. 다시 열어 주세요.',409);}finally{clearTimeout(readTimer);await cleanup;session.busy=false;this.reads.delete(id);finishRead();}
    })();
    return await Promise.race([work,deadline]);
  }
}
