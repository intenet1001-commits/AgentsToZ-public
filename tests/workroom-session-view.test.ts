import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {
 WORKROOM_SESSION_FULLSCREEN_QUERY,WORKROOM_SESSION_VIEW_STATE_KEY,isOwnWorkroomSessionViewState,isStaleWorkroomSessionViewState,
 isWorkroomSessionViewState,newWorkroomSessionViewToken,sessionViewEscapeCloses,sessionViewVoiceCall,visualKeyboardOpen,
 withWorkroomSessionView,withoutWorkroomSessionView,
} from '../src/workroomSessionView';

// The phone's full-screen Workroom session view (w7). Browser behaviour is checked by tests/remote-phone-layout.e2e.mjs and
// tests/workroom-usability.e2e.mjs; these pin the pure parts and the wiring the browser checks rely on.

test('a phone in either orientation and touch tablets: the phone layout query, not a new one', () => {
 expect(WORKROOM_SESSION_FULLSCREEN_QUERY).toBe('(max-width: 640px), (pointer: coarse)');
});

test('the view entry keeps the page state (its tab) and marks it with the panel token', () => {
 const entry=withWorkroomSessionView({workspaceTab:'workroom'},'wsv-a');
 expect(entry).toEqual({workspaceTab:'workroom',[WORKROOM_SESSION_VIEW_STATE_KEY]:'wsv-a'});
 expect(isWorkroomSessionViewState(entry)).toBe(true);
 expect(isOwnWorkroomSessionViewState(entry,'wsv-a')).toBe(true);
 expect(isOwnWorkroomSessionViewState(entry,'wsv-b')).toBe(false);
 // null/odd states are a page without a view entry
 for(const state of [null,undefined,'x',42,[],{workspaceTab:'home'}]){
  expect(isWorkroomSessionViewState(state)).toBe(false);
  expect(isOwnWorkroomSessionViewState(state,'wsv-a')).toBe(false);
 }
 expect(withWorkroomSessionView(null,'wsv-a')).toEqual({[WORKROOM_SESSION_VIEW_STATE_KEY]:'wsv-a'});
});

test('a tab entry pushed from the view does not carry the view marker', () => {
 const entry=withWorkroomSessionView({workspaceTab:'workroom',other:1},'wsv-a');
 expect(withoutWorkroomSessionView(entry)).toEqual({workspaceTab:'workroom',other:1});
 expect(isWorkroomSessionViewState(withoutWorkroomSessionView(entry))).toBe(false);
 expect(withoutWorkroomSessionView(null)).toEqual({});
});

test('Escape closes the view except while typing or inside the terminal and menus', () => {
 const key=(extra={})=>({key:'Escape',defaultPrevented:false,isComposing:false,...extra});
 const el=(tagName:string,inside:string|null=null)=>({tagName,closest:(selector:string)=>inside&&selector.split(',').map(part=>part.trim()).includes(inside)?{}:null});
 expect(sessionViewEscapeCloses(key(),el('DIV'))).toBe(true);
 expect(sessionViewEscapeCloses(key(),el('BUTTON'))).toBe(true);
 expect(sessionViewEscapeCloses(key(),null)).toBe(true);
 expect(sessionViewEscapeCloses(key(),el('TEXTAREA'))).toBe(false);
 expect(sessionViewEscapeCloses(key(),el('INPUT'))).toBe(false);
 expect(sessionViewEscapeCloses(key(),el('SELECT'))).toBe(false);
 expect(sessionViewEscapeCloses(key(),el('DIV','.xterm'))).toBe(false);
 expect(sessionViewEscapeCloses(key(),el('BUTTON','[role="listbox"]'))).toBe(false);
 expect(sessionViewEscapeCloses(key({defaultPrevented:true}),el('DIV'))).toBe(false);
 expect(sessionViewEscapeCloses(key({isComposing:true}),el('DIV'))).toBe(false);
 expect(sessionViewEscapeCloses({key:'Enter',defaultPrevented:false},el('DIV'))).toBe(false);
});

// w7 review: a hardware keyboard's Escape in a dialog opened from the view (「세션 종료」) closes that dialog only. The view
// itself is a dialog, so only a dialog other than the view counts.
test('Escape inside a dialog opened from the view does not close the view', () => {
 const key={key:'Escape',defaultPrevented:false,isComposing:false};
 const view={tag:'view'},exitDialog={tag:'exit'};
 const inside=(dialog:object|null)=>({tagName:'BUTTON',closest:(selector:string)=>selector.includes('dialog')?dialog:null});
 expect(sessionViewEscapeCloses(key,inside(exitDialog),view)).toBe(false);
 expect(sessionViewEscapeCloses(key,inside(view),view)).toBe(true);
 expect(sessionViewEscapeCloses(key,inside(null),view)).toBe(true);
 // the selector names native and ARIA dialogs
 let asked='';sessionViewEscapeCloses(key,{tagName:'BUTTON',closest:(selector:string)=>{if(selector.includes('dialog'))asked=selector;return null;}},view);
 expect(asked).toBe('dialog, [role="dialog"], [role="alertdialog"]');
});

test('an on-screen keyboard is a visual viewport markedly shorter than the layout one', () => {
 expect(visualKeyboardOpen(844,844-355)).toBe(true);   // iPhone portrait with suggestions
 expect(visualKeyboardOpen(428,428-210)).toBe(true);   // landscape
 expect(visualKeyboardOpen(568,568-261)).toBe(true);   // the 320pt SE
 expect(visualKeyboardOpen(844,844-80)).toBe(false);   // a browser bar collapsing
 expect(visualKeyboardOpen(844,844)).toBe(false);
 expect(visualKeyboardOpen(844,422,2)).toBe(false);    // pinch zoom ×2: the same screen at twice the size
 expect(visualKeyboardOpen(844,250,2)).toBe(true);     // zoomed in and a keyboard
 expect(visualKeyboardOpen(0,400)).toBe(false);expect(visualKeyboardOpen(844,0)).toBe(false);expect(visualKeyboardOpen(Number.NaN,400)).toBe(false);
});

test('a live voice call under the view names who answers; an idle or ended one is nothing', () => {
 const target={kind:'workroom',label:'블로그',targetId:'t',sessionId:'s',agent:'codex'};
 expect(sessionViewVoiceCall({phase:'listening',session:{activeTarget:target}})).toEqual({partner:'블로그 · Codex'});
 expect(sessionViewVoiceCall({phase:'review',session:{activeTarget:{kind:'ops',label:'AgentsToZ OPS'}}})).toEqual({partner:'총괄'});
 expect(sessionViewVoiceCall({phase:'preparing',session:null})).toEqual({partner:'총괄'});
 for(const phase of ['idle','ended','failed'])expect(sessionViewVoiceCall({phase,session:{activeTarget:target}})).toBeNull();
});

test('a view entry this page did not make is stale; one it made is not', () => {
 const token=newWorkroomSessionViewToken();
 expect(token).toMatch(/^wsv-/);
 expect(isStaleWorkroomSessionViewState(withWorkroomSessionView({workspaceTab:'workroom'},token))).toBe(false);
 // an earlier load of the page (a reload) gave its panel another token
 expect(isStaleWorkroomSessionViewState(withWorkroomSessionView({workspaceTab:'workroom'},'wsv-from-before-the-reload'))).toBe(true);
 for(const state of [null,undefined,{workspaceTab:'workroom'},'x'])expect(isStaleWorkroomSessionViewState(state)).toBe(false);
 expect(newWorkroomSessionViewToken()).not.toBe(token);
});

test('the portal opts in on a phone and keeps its tab history from stacking on the view entry', () => {
 const portal=readFileSync(new URL('../src/remote-control-portal-main.tsx',import.meta.url),'utf8');
 expect(portal).toContain('const sessionFullscreen=useWorkroomSessionFullscreen();');
 // both phone Workroom panels (this Mac and a community device)
 expect(portal.match(/<AiTerminalPanel[^>]*sessionFullscreen=\{sessionFullscreen\}/g)?.length).toBe(2);
 // both say when the Workroom is on screen apart from loading (an automatic project sweep hides the panel, not the pane)
 expect(portal.match(/onScreen=\{visible\}/g)?.length).toBe(2);
 expect(portal).toContain('visible={visible&&!loadingAll} onScreen={visible}');
 expect(portal).toMatch(/if \(isWorkroomSessionViewState\(history\.state\) \|\| isWorkroomNewTaskState\(history\.state\)\) history\.replaceState\(next, ''\); else history\.pushState\(next, ''\);/);
 // the signed-in cleanup keeps the tab in the entry (an entry without one reads as 홈 on back)
 expect(portal).not.toContain("window.history.replaceState(null, '', '/remote/');\n        return;");
});

test('only the phone portal sets it: the Mac app, its popout and the Mac driving another device do not', () => {
 for(const file of ['../src/WorkroomDeviceSwitch.tsx','../src/WorkroomPopoutApp.tsx','../src/App.tsx']){
  const source=readFileSync(new URL(file,import.meta.url),'utf8');
  expect(source.includes('sessionFullscreen')).toBe(false);
 }
 const panel=readFileSync(new URL('../src/AiTerminalPanel.tsx',import.meta.url),'utf8');
 // the layout is remote-only, and terminal reads wait for an open view
 expect(panel).toContain('const fullscreen=remote&&sessionFullscreen;');
 expect(panel).toContain('if(!visible||!activeSession||!sessionShown)return;');
});

// w11 review: the 「새 작업」 sheet has one history entry of its own, told apart like the view's.
import {isStaleWorkroomNewTaskState,isWorkroomNewTaskState,withWorkroomNewTask,withoutWorkroomNewTask} from '../src/workroomSessionView';
test('the 새 작업 sheet entry: marked, stale across loads, stripped by the tab navigation', () => {
 const token=newWorkroomSessionViewToken();
 const entry=withWorkroomNewTask({workspaceTab:'workroom'},token);
 expect(isWorkroomNewTaskState(entry)).toBe(true);
 expect(isStaleWorkroomNewTaskState(entry)).toBe(false);
 expect(isStaleWorkroomNewTaskState({workroomNewTask:'wsv-from-an-earlier-load'})).toBe(true);
 expect(withoutWorkroomNewTask(entry)).toEqual({workspaceTab:'workroom'});
 expect(withoutWorkroomSessionView({...entry,workroomSessionView:token})).toEqual({workspaceTab:'workroom'});
 expect(isWorkroomSessionViewState(entry)).toBe(false);
});
