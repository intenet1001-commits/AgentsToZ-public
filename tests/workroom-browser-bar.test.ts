import {expect,test} from 'bun:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {browserCloseDisabled,handleBrowserAddressKey,WorkroomBrowserFrameToolbar,type WorkroomBrowserToolbarProps} from '../src/WorkroomBrowserFrameToolbar';
import {WorkroomBrowserFrameTabStrip,type WorkroomBrowserTabStripProps} from '../src/WorkroomBrowserFrameTabStrip';

const noop=()=>{};
const toolbar=(extra:Partial<WorkroomBrowserToolbarProps>={})=>renderToStaticMarkup(createElement(WorkroomBrowserFrameToolbar,{
 lang:'ko',url:'https://example.com/',pageUrl:'https://example.com/',onUrlChange:noop,onSubmit:noop,
 disabled:false,readOnly:false,phase:null,
 nav:{supported:true,canBack:true,canForward:true,loading:false,onBack:noop,onForward:noop,onReload:noop,onStop:noop},
 ...extra}));
const tabs=(extra:Partial<WorkroomBrowserTabStripProps>={})=>renderToStaticMarkup(createElement(WorkroomBrowserFrameTabStrip,{
 lang:'ko',source:'owned',tabs:[{key:'first',title:'First',host:'example.com',url:'https://example.com/'}],
 activeKey:'first',controlsId:'browser-page',onSelect:noop,onClose:noop,onAdd:noop,...extra}));
const tag=(html:string,testId:string)=>{
 const match=html.match(new RegExp(`<[^>]*data-testid="${testId}"[^>]*>`));
 expect(match).not.toBeNull();
 return match![0];
};

test('navigation respects ownership and an in-flight phase even when the optional nav flag is omitted',()=>{
 for(const extra of [{readOnly:true},{disabled:true},{phase:'connecting' as const}]){
  const html=toolbar(extra);
  for(const id of ['workroom-browser-back','workroom-browser-forward','workroom-browser-reload'])expect(tag(html,id)).toContain('disabled=""');
  expect(tag(html,'owned-browser-address')).not.toContain('disabled=');
  const dirty=toolbar({...extra,url:'https://example.com/new'});
  if('readOnly' in extra)expect(dirty).not.toContain('data-testid="owned-browser-open"');
  else expect(tag(dirty,'owned-browser-open')).toContain('disabled=""');
 }
 for(const id of ['workroom-browser-back','workroom-browser-forward','workroom-browser-reload'])expect(tag(toolbar(),id)).not.toContain('disabled=');
 expect(tag(toolbar({readOnly:true}),'owned-browser-address')).toContain('aria-readonly="true"');
});

test('closing cancels a page request even while its address and navigation stay locked',()=>{
 for(const phase of ['navigating','target','loading','connecting'] as const){
  for(const disabled of [false,true])expect(browserCloseDisabled({phase,disabled,readOnly:false,closeDisabled:false})).toBe(false);
  // The production owned caller supplies both phase and disabled=!!phase. Only closing is cancellable.
  const html=toolbar({phase,disabled:true,url:'https://example.com/new'});
  expect(tag(html,'owned-browser-address')).toContain('aria-readonly="true"');
  for(const id of ['workroom-browser-back','workroom-browser-forward','workroom-browser-reload','owned-browser-open'])expect(tag(html,id)).toContain('disabled=""');
 }
});

test('closing still refuses profile admission, another close, AI ownership and explicit external action locks',()=>{
 for(const phase of ['profile','closing'] as const){
  for(const disabled of [false,true])expect(browserCloseDisabled({phase,disabled,readOnly:false})).toBe(true);
 }
 for(const phase of [null,'navigating','target','loading','connecting'] as const){
  expect(browserCloseDisabled({phase,disabled:false,readOnly:true})).toBe(true);
  expect(browserCloseDisabled({phase,disabled:false,readOnly:false,closeDisabled:true})).toBe(true);
  expect(browserCloseDisabled({phase,disabled:true,readOnly:false,closeDisabled:true})).toBe(true);
 }
 expect(browserCloseDisabled({phase:null,disabled:true,readOnly:false})).toBe(true);
 expect(browserCloseDisabled({phase:null,disabled:false,readOnly:false})).toBe(false);
});

test('a human accepted load keeps the address and Stop usable while other navigation and admission stay locked',()=>{
 const nav={supported:true,canBack:true,canForward:true,loading:true,disabled:true,onBack:noop,onForward:noop,onReload:noop,onStop:noop};
 for(const phase of ['target','loading'] as const){
  const html=toolbar({phase,disabled:true,canReplaceLoad:true,url:'https://example.com/replacement',nav});
  expect(tag(html,'owned-browser-address')).not.toContain('readonly');
  expect(tag(html,'owned-browser-open')).not.toContain('disabled=');
  expect(tag(html,'workroom-browser-stop')).not.toContain('disabled=');
  for(const id of ['workroom-browser-back','workroom-browser-forward'])expect(tag(html,id)).toContain('disabled=""');
  const held=toolbar({phase,disabled:true,canReplaceLoad:true,readOnly:true,nav});
  expect(tag(held,'owned-browser-address')).toContain('aria-readonly="true"');
  expect(tag(held,'workroom-browser-stop')).toContain('disabled=""');
 }
 for(const phase of ['profile','navigating','connecting','closing'] as const){
  const html=toolbar({phase,disabled:true,canReplaceLoad:true,url:'https://example.com/replacement',nav});
  expect(tag(html,'owned-browser-address')).toContain('aria-readonly="true"');
  expect(tag(html,'owned-browser-open')).toContain('disabled=""');
  expect(tag(html,'workroom-browser-stop')).toContain('disabled=""');
 }
 expect(tag(toolbar({phase:'loading',disabled:true,canReplaceLoad:true,nav:{...nav,stopDisabled:true}}),'workroom-browser-stop')).toContain('disabled=""');
});

test('IME Escape stays in the omnibox without cancelling the composition, reverting the edit or moving focus',()=>{
 const calls:string[]=[];
 const event={key:'Escape',nativeEvent:{isComposing:true} as KeyboardEvent,
  preventDefault:()=>calls.push('prevent'),stopPropagation:()=>calls.push('stop'),currentTarget:{blur:()=>{calls.push('blur');}} as HTMLInputElement};
 handleBrowserAddressKey(event,()=>calls.push('revert'));
 expect(calls).toEqual(['stop']);
 // The native dialog cancel guard can still identify the focused field while its IME keeps the default Escape.
 expect(tag(toolbar(),'workroom-browser-omnibox')).toContain('data-workroom-local-escape=');
 calls.length=0;
 handleBrowserAddressKey({...event,nativeEvent:{isComposing:false} as KeyboardEvent},()=>calls.push('revert'));
 expect(calls).toEqual(['stop','prevent','revert','blur']);
 calls.length=0;
 // Ordinary Enter keeps the form's normal submit path; a composing Enter is guarded separately below.
 handleBrowserAddressKey({...event,key:'Enter',nativeEvent:{isComposing:false} as KeyboardEvent},()=>calls.push('revert'));
 expect(calls).toEqual([]);
});

test('IME Enter commits the composition without submitting, including the lifecycle gap and WebKit key code 229',()=>{
 for(const state of [{isComposing:true,keyCode:13,lifecycle:false},{isComposing:false,keyCode:229,lifecycle:false},{isComposing:false,keyCode:13,lifecycle:true}]){
  const calls:string[]=[];
  handleBrowserAddressKey({key:'Enter',keyCode:state.keyCode,nativeEvent:{isComposing:state.isComposing} as KeyboardEvent,
   preventDefault:()=>calls.push('prevent'),stopPropagation:()=>calls.push('stop'),currentTarget:{blur:()=>calls.push('blur')} as unknown as HTMLInputElement},()=>calls.push('revert'),state.lifecycle);
  expect(calls).toEqual(['prevent','stop']);
 }
});

test('the actual omnibox submit reads the latest DOM text and refuses composition, ownership and request locks',async()=>{
 const source=await Bun.file(new URL('../src/WorkroomBrowserFrameToolbar.tsx',import.meta.url)).text();
 const start=source.indexOf('onSubmit={event=>{'),end=source.indexOf('}}>',start);expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
 const submitSource='const submit='+source.slice(start+'onSubmit={'.length,end+1)+';return submit;';
 const js=new Bun.Transpiler({loader:'ts'}).transformSync(submitSource);
 for(const locked of [true,false])for(const openDisabled of [true,false])for(const activeComposition of [true,false]){
  const submitted:string[]=[],events:string[]=[],composing={current:activeComposition};
  const submit=new Function('locked','openDisabled','composing','input','url','onSubmit',js)(locked,openDisabled,composing,{current:{value:'네이버 지도',blur:()=>events.push('blur')}},'https://previous.example/',(value:string)=>submitted.push(value)) as (event:{preventDefault:()=>void})=>void;
  submit({preventDefault:()=>events.push('prevent')});
  const allowed=!locked&&!openDisabled&&!activeComposition;
  expect(submitted).toEqual(allowed?['네이버 지도']:[]);expect(events).toEqual(allowed?['prevent','blur']:['prevent']);
 }
});

test('older native builds omit navigation and a clean address has no redundant open button',()=>{
 const html=toolbar({nav:{supported:false,canBack:false,canForward:false,loading:false,onBack:noop,onForward:noop,onReload:noop,onStop:noop}});
 expect(html).not.toContain('data-testid="workroom-browser-back"');
 expect(html).not.toContain('data-testid="owned-browser-open"');
 expect(tag(toolbar({url:'https://example.com/new'}),'owned-browser-open')).not.toContain('disabled=');
 expect(toolbar({url:'https://example.com/new',readOnly:true})).not.toContain('data-testid="owned-browser-open"');
});

test('unknown progress never reports a percentage and known progress stays within 0–100',()=>{
 for(const value of [null,NaN,Infinity]){
  const html=toolbar({progress:{active:true,value}});
  expect(html).toContain('role="progressbar"');
  expect(html).not.toContain('aria-valuenow');
 }
 expect(toolbar({progress:{active:true,value:2}})).toContain('aria-valuenow="100"');
 expect(toolbar({progress:{active:true,value:-1}})).toContain('aria-valuenow="0"');
 expect(toolbar({progress:{active:true,value:.42}})).toContain('aria-valuenow="42"');
});

test('all tab actions are disabled together while the AI holds the page',()=>{
 const html=tabs({source:'chrome',disabled:true});
 for(const id of ['workroom-browser-tab-show','workroom-browser-tab-release','workroom-browser-add-tab'])expect(tag(html,id)).toContain('disabled=""');
 expect(tag(html,'workroom-browser-tab-show')).toContain('title="First');
 expect(tag(html,'workroom-browser-tab-show')).toContain('직접 하기를 누르면 바꿀 수 있습니다');
 expect(tag(html,'workroom-browser-add-tab')).toContain('직접 하기를 누르면 바꿀 수 있습니다');
});

test('one built-in tab stays open, but the last Chrome tab can still leave the task',()=>{
 expect(tabs()).not.toContain('data-testid="owned-browser-tab-close"');
 const chrome=tabs({source:'chrome'});
 expect(tag(chrome,'workroom-browser-tab-release')).toContain('aria-label="작업에서 빼기: First"');
 expect(tag(chrome,'workroom-browser-tab-release')).toContain('Chrome 탭은 그대로 열려 있습니다');
 expect(chrome).toContain('aria-controls="browser-page"');
});

test('the six-tab limit disables only addition and an unknown active tab keeps one keyboard entry',()=>{
 const list=Array.from({length:6},(_,i)=>({key:String(i),title:`Page ${i}`,host:'example.com'}));
 const html=tabs({tabs:list,activeKey:'missing'});
 expect(tag(html,'owned-browser-new-tab')).toContain('disabled=""');
 expect((html.match(/tabindex="0"/g)??[]).length).toBe(1);
 expect(html).toContain('role="tablist"');
});
