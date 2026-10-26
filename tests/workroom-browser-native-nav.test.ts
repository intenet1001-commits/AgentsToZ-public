import {expect,test} from 'bun:test';
import {nativeNav,pageStateFrom,canRunNav,canReplaceLoadingRequest,canStopNav,type NativeNavOperation,type NativeNavStatus} from '../src/workroomBrowserNativeNav';
import {BROWSER_AGENT_OPERATIONS,parseBrowserAgentRequest,type BrowserOwner} from '../src/workroomBrowserProtocol';
import type {WorkroomBrowserPhase} from '../src/WorkroomBrowserFrameToolbar';
import {browserShortcut} from '../src/workroomBrowserShortcuts';

const ops:NativeNavOperation[]=['back','forward','reload','stop'];
const oldNative={available:true,sessionId:'session_nav',tab:'main',human:true,url:'https://example.test/old',loading:true,targetId:'target_old',port:50001} satisfies NativeNavStatus;
const newNative={...oldNative,title:'Example page',canGoBack:true,canGoForward:false,progress:0.4,loadError:{code:-102,text:'ERR_CONNECTION_REFUSED',url:'http://localhost:50002/'},blockedInputs:3,focused:true,consoleErrors:2} satisfies NativeNavStatus;

/** Exercise the actual Tauri invoke boundary without replacing the module or leaking a global mock. */
async function withNative(reply:(command:string,args:unknown)=>Promise<unknown>,run:()=>Promise<void>){
 const original=Object.getOwnPropertyDescriptor(globalThis,'window');
 Object.defineProperty(globalThis,'window',{configurable:true,value:{__TAURI_INTERNALS__:{invoke:reply}}});
 try{await run();}finally{if(original)Object.defineProperty(globalThis,'window',original);else Reflect.deleteProperty(globalThis,'window');}
}

test('v1263 has loading and a URL but no navigation support',()=>{
 expect(pageStateFrom(oldNative)).toEqual({supported:false,canBack:false,canForward:false,loading:true,progress:null,title:'',url:oldNative.url,loadError:null,blockedInputs:0,focused:false});
});

test('C2b page state projects history, progress, title, load error and native input state',()=>{
 expect(pageStateFrom(newNative)).toEqual({supported:true,canBack:true,canForward:false,loading:true,progress:0.4,title:'Example page',url:oldNative.url,loadError:newNative.loadError,blockedInputs:3,focused:true});
 // History support does not depend on having history entries, a title, progress, or optional diagnostics.
 expect(pageStateFrom({canGoBack:false,canGoForward:false})).toEqual({supported:true,canBack:false,canForward:false,loading:false,progress:null,title:'',url:'',loadError:null,blockedInputs:0,focused:false});
 for(const progress of [0,1])expect(pageStateFrom({...newNative,progress}).progress).toBe(progress);
 expect(pageStateFrom({...newNative,loading:false,loadError:null}).loadError).toBeNull();
});

test('absent and malformed page state is treated as absent without coercion',()=>{
 const empty=pageStateFrom(undefined);
 for(const value of [null,false,1,'status',[],[newNative]])expect(pageStateFrom(value)).toEqual(empty);
 expect(pageStateFrom({title:42,canGoBack:'true',canGoForward:1,loading:'true',progress:'0.5',loadError:[],url:123,blockedInputs:'3',focused:'false',consoleErrors:[] })).toEqual(empty);
 for(const value of [null,1,'false',[],{}]){
  expect(pageStateFrom({canGoBack:value,canGoForward:false}).supported).toBe(false);
  expect(pageStateFrom({canGoBack:false,canGoForward:value}).supported).toBe(false);
 }
 for(const progress of [null,NaN,Infinity,-Infinity,-0.1,1.1,{},[]])expect(pageStateFrom({...newNative,progress}).progress).toBeNull();
 for(const blockedInputs of [-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])expect(pageStateFrom({...newNative,blockedInputs}).blockedInputs).toBe(0);
 for(const loadError of [null,{},[],{code:'-102',text:'error',url:'http://localhost/'},{code:NaN,text:'error',url:'http://localhost/'},{code:-1.5,text:'error',url:'http://localhost/'},{code:-102,text:3,url:'http://localhost/'},{code:-102,text:'error',url:false}])expect(pageStateFrom({...newNative,loadError}).loadError).toBeNull();
});

test('page titles are untrusted text with control characters removed and a 300 character cap',()=>{
 const title='\u0000\t\n\r\u001b\u007f\u0085\u009f<title>한글 & text</title>'+'x'.repeat(400);
 expect(pageStateFrom({...newNative,title}).title).toBe(('<title>한글 & text</title>'+'x'.repeat(400)).slice(0,300));
 expect(pageStateFrom({...newNative,title:'\u0000\n'}).title).toBe('');
});

test('each navigation op uses the existing native command and exact session/tab, once',async()=>{
 const calls:unknown[]=[];
 await withNative(async(command,args)=>{calls.push({command,args});return newNative;},async()=>{
  for(const op of ops){
   const status=await nativeNav('session_nav','t2',op);
   expect(pageStateFrom(status)).toEqual(pageStateFrom(newNative));
   expect(status.consoleErrors).toBe(2);
  }
 });
 expect(calls).toEqual(ops.map(operation=>({command:'workroom_browser_native',args:{sessionId:'session_nav',operation,tab:'t2'}})));
});

test('optional native result fields are validated, including the console-error counter',async()=>{
 await withNative(async()=>({...newNative,title:'\u0000Title\n',canGoBack:'true',canGoForward:1,progress:Infinity,loadError:{code:'bad'},blockedInputs:-1,focused:1,consoleErrors:'2'}),async()=>{
  const status=await nativeNav('session_nav','main','reload');
  expect(status.title).toBe('Title');
  for(const key of ['canGoBack','canGoForward','progress','loadError','blockedInputs','focused','consoleErrors'] as const)expect(status[key]).toBeUndefined();
  expect(status.url).toBe(oldNative.url);
 });
 for(const consoleErrors of [0,2,Number.MAX_SAFE_INTEGER,-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,null]){
  await withNative(async()=>({...oldNative,consoleErrors}),async()=>{
   expect((await nativeNav('session_nav','main','stop')).consoleErrors).toBe(typeof consoleErrors==='number'&&Number.isSafeInteger(consoleErrors)&&consoleErrors>=0?consoleErrors:undefined);
  });
 }
});

test('only a human with no request phase can send navigation',async()=>{
 let sent=0;
 await withNative(async()=>{sent++;return oldNative;},async()=>{
  for(const owner of ['observing','agent','taking','disconnected',null,undefined] as const){
   expect(canRunNav(owner,null)).toBe(false);
   for(const op of ops)if(canRunNav(owner,null))await nativeNav('session_nav','main',op);
  }
  const phases:WorkroomBrowserPhase[]=['profile','navigating','target','loading','connecting','closing'];
  for(const phase of phases){
   expect(canRunNav('human',phase)).toBe(false);
   for(const op of ops)if(canRunNav('human',phase))await nativeNav('session_nav','main',op);
  }
  expect(canRunNav('human','' as WorkroomBrowserPhase)).toBe(false);
  expect(canRunNav('unknown' as BrowserOwner,null)).toBe(false);
  expect(sent).toBe(0);
  expect(canRunNav('human',null)).toBe(true);
  expect(canRunNav('human')).toBe(true);
 });
});

test('native refusals and unknown outcomes propagate without replaying a navigation',async()=>{
 for(const failure of [new Error('Take control before navigating.'),'reload-would-resubmit',new Error('Native response lost.')]){
  let sent=0;
  await withNative(async()=>{sent++;throw failure;},async()=>{
   for(const op of ops){
    let received:unknown;
    try{await nativeNav('session_nav','main',op);}catch(error){received=error;}
    expect(received).toBe(failure);
   }
  });
  expect(sent).toBe(ops.length);
 }
});

test('only the human may replace or stop an accepted target/document wait, never admission or connection',()=>{
 for(const owner of ['human','observing','agent','taking','disconnected',null,undefined] as const){
  for(const phase of [null,'profile','navigating','target','loading','connecting','closing'] as const){
   expect(canReplaceLoadingRequest(owner,phase)).toBe(owner==='human'&&(phase==='target'||phase==='loading'));
   expect(canStopNav(owner,phase)).toBe(owner==='human'&&(phase===null||phase==='target'||phase==='loading'));
  }
 }
 expect(canReplaceLoadingRequest('human','' as WorkroomBrowserPhase)).toBe(false);
 expect(canStopNav('human','' as WorkroomBrowserPhase)).toBe(false);
});

test('navigation operations are excluded from both the agent allowlist and its parser',()=>{
 for(const operation of ops){
  expect((BROWSER_AGENT_OPERATIONS as readonly string[]).includes(operation)).toBe(false);
  expect(()=>parseBrowserAgentRequest({workspaceId:'workspace_nav',grant:'grant',epoch:1,operation})).toThrow();
 }
});

test('the native helper refuses an unknown operation before invoking the bridge',async()=>{
 let sent=0;
 await withNative(async()=>{sent++;return newNative;},async()=>{
  await expect(nativeNav('session_nav','main','navigate' as NativeNavOperation)).rejects.toThrow('Unsupported native navigation operation.');
 });
 expect(sent).toBe(0);
});

async function shortcutHarness(options:{owner?:BrowserOwner;connection?:'connected'|'disconnected';visible?:boolean;opened?:boolean;phase?:WorkroomBrowserPhase;focused?:boolean}={}){
 const source=await Bun.file(new URL('../src/OwnedWorkroomBrowser.tsx',import.meta.url)).text();
 const start=source.indexOf(' const shortcut='),end=source.indexOf(' return <div className="owned-workroom-browser"',start);
 expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
 const actions:string[]=[],listeners=new Map<string,(event:unknown)=>void>();let cleanup=()=>{};
 class Key{
  key='';metaKey=false;ctrlKey=false;altKey=false;shiftKey=false;isComposing=false;defaultPrevented=false;
  target:{closest:(selector:string)=>unknown}|null=null;
  constructor(_type:string,init:Partial<Key>){Object.assign(this,init);}
  preventDefault(){this.defaultPrevented=true;}stopPropagation(){}
 }
 const env={useRef:(value:unknown)=>({current:value}),useEffect:(effect:()=>()=>void)=>{cleanup=effect();},KeyboardEvent:Key,browserShortcut,
  document:{addEventListener:(name:string,listener:(event:unknown)=>void)=>listeners.set(name,listener),removeEventListener:(name:string)=>listeners.delete(name)},
  sessionId:'session_native_shortcut',visible:options.visible??true,opened:options.opened??true,activeRef:{current:'t2'},tabsRef:{current:[{tab:'t2',targetId:'native_target_t2'}]},
  workspace:{owner:options.owner??'human',connection:options.connection??'connected'},phaseRef:{current:options.phase??null},
  nativePage:{focused:options.focused??false,supported:true,canBack:true,canForward:true},shownTabs:[{tab:'main'},{tab:'t2'}],
  focusAddress:()=>actions.push('focus'),addTab:()=>actions.push('add'),showTab:(tab:string)=>actions.push('tab:'+tab),navigate:(operation:string)=>actions.push(operation),
 };
 new Function(...Object.keys(env),new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(start,end)))(...Object.values(env));
 return {actions,send:(detail:unknown)=>listeners.get('agentstoz-native-browser-shortcut')!({detail}),terminal:()=>listeners.get('keydown')!(new Key('keydown',{key:'l',metaKey:true,target:{closest:selector=>selector.includes('workroom-browser-terminal')?{}:null}})),dispose:()=>cleanup(),listeners};
}
const nativeShortcut={source:'cef',sessionId:'session_native_shortcut',tab:'t2',targetId:'native_target_t2',key:'l'};

test('a scoped CEF Cmd-L focuses the omnibox while actual terminal Cmd-L stays with the terminal, even with stale native focus',async()=>{
 for(const focused of [false,true]){
  const h=await shortcutHarness({focused});h.terminal();expect(h.actions).toEqual([]);
  h.send(nativeShortcut);expect(h.actions).toEqual(['focus']);
  h.dispose();expect(h.listeners.size).toBe(0);
 }
});

test('native shortcuts refuse another session, tab, known target, malformed source or key, and hidden browser',async()=>{
 const h=await shortcutHarness();
 for(const detail of [null,[],{...nativeShortcut,source:'terminal'},{...nativeShortcut,sessionId:'other_session'},{...nativeShortcut,tab:'main'},{...nativeShortcut,targetId:'old_target'},{...nativeShortcut,targetId:4},{...nativeShortcut,key:'w'},{...nativeShortcut,key:'ll'}])h.send(detail);
 expect(h.actions).toEqual([]);h.dispose();
 for(const options of [{visible:false},{opened:false}]){const hidden=await shortcutHarness(options);hidden.send(nativeShortcut);expect(hidden.actions).toEqual([]);hidden.dispose();}
});

test('CEF shortcuts retain owner and phase gates, while Cmd-L can read the address during loading',async()=>{
 for(const owner of ['agent','observing','taking','disconnected'] as const){
  const h=await shortcutHarness({owner});h.send({...nativeShortcut,key:'r'});expect(h.actions).toEqual([]);h.dispose();
 }
 const loading=await shortcutHarness({phase:'loading'});loading.send({...nativeShortcut,key:'r'});expect(loading.actions).toEqual([]);
 loading.send(nativeShortcut);expect(loading.actions).toEqual(['focus']);loading.dispose();
 const ready=await shortcutHarness();ready.send({...nativeShortcut,key:'r'});expect(ready.actions).toEqual(['reload']);ready.dispose();
});

async function nativeFocusBridge(initialFocus=false){
 const source=await Bun.file(new URL('../native/workroom-browser/src/cocoa.m',import.meta.url)).text();
 const dispatch=source.match(/NSString \*dispatch = \[NSString stringWithFormat:@"([^"\n]+)",json\];/);
 const deferred=source.match(/NSString \*script = focusAddress \? \[NSString stringWithFormat:@"([^"\n]+)",dispatch\] : dispatch;/);
 expect(dispatch).not.toBeNull();expect(deferred).not.toBeNull();
 const delivered:unknown[]=[],windowListeners=new Map<string,()=>void>(),documentListeners=new Map<string,()=>void>(),frames=new Map<number,()=>void>(),timers=new Map<number,()=>void>();
 let focused=initialFocus,time=0,id=0;
 const env={window:{addEventListener:(name:string,listener:()=>void)=>windowListeners.set(name,listener),removeEventListener:(name:string)=>windowListeners.delete(name)},
  document:{hasFocus:()=>focused,addEventListener:(name:string,listener:()=>void)=>documentListeners.set(name,listener),removeEventListener:(name:string)=>documentListeners.delete(name),dispatchEvent:(event:{detail:unknown})=>delivered.push(event.detail)},
  CustomEvent:class{detail:unknown;constructor(_name:string,options:{detail:unknown}){this.detail=options.detail;}},performance:{now:()=>time},
  requestAnimationFrame:(callback:()=>void)=>{frames.set(++id,callback);return id;},cancelAnimationFrame:(key:number)=>frames.delete(key),
  setTimeout:(callback:()=>void,delay:number)=>{expect(delay).toBe(200);timers.set(++id,callback);return id;},clearTimeout:(key:number)=>timers.delete(key)};
 const script=deferred![1]!.replace('%@',dispatch![1]!.replace('%@',JSON.stringify(nativeShortcut)));
 new Function(...Object.keys(env),script)(...Object.values(env));
 return {delivered,setFocus:(value:boolean)=>{focused=value;},emitFocus:()=>windowListeners.get('focus')?.(),blur:()=>windowListeners.get('blur')?.(),input:(name:string)=>documentListeners.get(name)?.(),
  frame:()=>{for(const [key,callback] of [...frames]){frames.delete(key);callback();}},expire:()=>{time=201;for(const callback of [...timers.values()])callback();},
  pending:()=>({listeners:windowListeners.size+documentListeners.size,frames:frames.size,timers:timers.size})};
}

test('native Cmd-L waits for WK document focus and its next frame, dispatches once, and cleans up',async()=>{
 const h=await nativeFocusBridge();expect(h.delivered).toEqual([]);expect(h.pending().frames).toBe(0);
 h.setFocus(true);h.emitFocus();h.emitFocus();expect(h.delivered).toEqual([]);expect(h.pending().frames).toBe(1);
 h.frame();expect(h.delivered).toEqual([nativeShortcut]);expect(h.pending()).toEqual({listeners:0,frames:0,timers:0});
 h.emitFocus();h.frame();expect(h.delivered).toEqual([nativeShortcut]);
 const already=await nativeFocusBridge(true);expect(already.delivered).toEqual([]);already.frame();expect(already.delivered).toEqual([nativeShortcut]);
});

test('native Cmd-L abandons late focus, lost focus, blur or new input without stealing focus later',async()=>{
 for(const cancel of ['timeout','lost-focus','blur','pointerdown','keydown']){
  const h=await nativeFocusBridge();
  if(cancel==='timeout')h.expire();else{h.setFocus(true);h.emitFocus();if(cancel==='lost-focus')h.setFocus(false);else if(cancel==='blur')h.blur();else h.input(cancel);}
  h.frame();h.setFocus(true);h.emitFocus();h.frame();expect(h.delivered).toEqual([]);expect(h.pending()).toEqual({listeners:0,frames:0,timers:0});
 }
});
