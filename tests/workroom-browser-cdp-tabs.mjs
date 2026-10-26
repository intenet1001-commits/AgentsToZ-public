// P1 multiple tabs on a real Chrome: one Workroom's own tab set next to the person's own tab and another Workroom's tab.
// The agent lists and reaches only its own set; trusted input in a background tab of the set revokes; a background
// navigation keeps the lease and its new document is watched again. Local fixture pages only; a disposable profile.
import assert from 'node:assert/strict';
const page=(title,text)=>()=>new Response(`<!doctype html><meta charset="utf-8"><title>${title}</title><h1>${text}</h1><input id="field" aria-label="Field">`,{headers:{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'self'"}});
export const tabRoutes={
 '/tab-one':page('Tab one','Tab one text'),'/tab-two':page('Tab two','Tab two text'),'/tab-two-next':page('Tab two next','Tab two moved on'),
 '/personal':page('Personal mail','PERSONAL SECRET MAIL'),'/other-workroom':page('Other Workroom','OTHER WORKROOM PRIVATE'),
};
const outside=['PERSONAL SECRET','/personal','OTHER WORKROOM PRIVATE','/other-workroom'];
const own=(value,label)=>{const text=JSON.stringify(value);for(const word of outside)assert(!text.includes(word),`${label} leaked ${word}`);};
export async function runTabChecks({host,raw,profile,base}){
 const checks=[],created=[],workspaces=[];
 const open=async path=>{const {targetId}=await raw.send('Target.createTarget',{url:base+path});created.push(targetId);return targetId;};
 const loaded=async(id,path)=>{for(let i=0;i<100;i++){const t=(await raw.send('Target.getTargets')).targetInfos.find(x=>x.targetId===id);if(t?.url===base+path)return;await Bun.sleep(50);}throw new Error(`${path} did not load`);};
 const key=async id=>{const {sessionId}=await raw.send('Target.attachToTarget',{targetId:id,flatten:true});try{await raw.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Shift',code:'ShiftLeft',windowsVirtualKeyCode:16},sessionId);await raw.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Shift',code:'ShiftLeft',windowsVirtualKeyCode:16},sessionId);}finally{await raw.send('Target.detachFromTarget',{sessionId}).catch(()=>{});}};
 const owner=async(id,want)=>{for(let i=0;i<60;i++){const s=await host.perform({operation:'status',workspaceId:id});if(s.workspace.owner===want)return s.workspace;await Bun.sleep(50);}throw new Error(`owner never became ${want}`);};
 try{
  const one=await open('/tab-one'),two=await open('/tab-two'),personal=await open('/personal'),other=await open('/other-workroom');
  for(const [id,path] of [[one,'/tab-one'],[two,'/tab-two'],[personal,'/personal'],[other,'/other-workroom']])await loaded(id,path);
  let r=await host.perform({operation:'connect',sessionId:'session_tabs',targetId:'project_test',profileId:profile.id});const id=r.workspace.id;workspaces.push(id);
  await host.perform({operation:'select',workspaceId:id,pageId:one,confirmProfile:true});
  r=await host.perform({operation:'select',workspaceId:id,pageId:two,confirmProfile:true,add:true});assert.deepEqual(r.workspace.tabs.map(t=>t.id),[one,two]);
  const b=await host.perform({operation:'connect',sessionId:'session_tabs_other',targetId:'project_test',profileId:profile.id});workspaces.push(b.workspace.id);
  await host.perform({operation:'select',workspaceId:b.workspace.id,pageId:other,confirmProfile:true});
  await assert.rejects(host.perform({operation:'select',workspaceId:id,pageId:other,confirmProfile:true,add:true}),/already attached to another Workroom/);
  const hand=async()=>{const ready=await host.perform({operation:'resume',workspaceId:id});const g=await host.perform({operation:'grant',workspaceId:id});return {workspaceId:id,grant:g.grant,epoch:ready.workspace.epoch};};
  let access=await hand();
  r=await host.agent({...access,operation:'tabs'});assert.deepEqual(r.workspace.tabs.map(t=>t.id),[one,two]);assert.equal(r.workspace.page.id,two);own(r,'tabs');
  r=await host.agent({...access,operation:'switch-tab',tab:one});assert.equal(r.workspace.page.id,one);assert(r.workspace.observation.text.includes('Tab one text'));own(r,'switch-tab');
  for(const tab of [personal,other])await assert.rejects(host.agent({...access,operation:'switch-tab',tab}),/not one of this Workroom's tabs/);
  r=await host.agent({...access,operation:'fill',selector:'#field',text:'첫 탭',requestId:'tabs_fill_one',observationId:r.workspace.observation.id});own(r,'fill');
  const typed=await raw.send('Target.attachToTarget',{targetId:one,flatten:true});const value=await raw.send('Runtime.evaluate',{expression:'document.querySelector("#field").value',returnByValue:true},typed.sessionId);await raw.send('Target.detachFromTarget',{sessionId:typed.sessionId});
  assert.equal(value.result.value,'첫 탭');
  checks.push('real Chrome: the agent lists and switches only within its Workroom\'s own two tabs, acts in the active one, and never reads or reaches the person\'s tab or another Workroom\'s tab');
  // Trusted input in the background tab of the set (not the active one) revokes.
  await key(two);await owner(id,'human');await assert.rejects(host.agent({...access,operation:'tabs'}),/revoked|Stale/);
  checks.push('real Chrome: trusted human input in a background tab of the Workroom\'s set revokes agent access');
  // A background tab that navigates keeps the lease; its new document is watched again.
  access=await hand();
  const nav=await raw.send('Target.attachToTarget',{targetId:two,flatten:true});await raw.send('Page.navigate',{url:base+'/tab-two-next'},nav.sessionId);await raw.send('Target.detachFromTarget',{sessionId:nav.sessionId});
  await loaded(two,'/tab-two-next');await Bun.sleep(300);
  r=await host.agent({...access,operation:'tabs'});assert.equal(r.workspace.owner,'agent');assert.equal(r.workspace.tabs.find(t=>t.id===two).url,base+'/tab-two-next');
  await key(two);await owner(id,'human');
  checks.push('real Chrome: a background tab\'s navigation keeps the lease, and its new document still revokes on human input');
  // Release takes a tab out of the set without closing it.
  r=await host.perform({operation:'release',workspaceId:id,pageId:two});assert.deepEqual(r.workspace.tabs.map(t=>t.id),[one]);
  assert((await raw.send('Target.getTargets')).targetInfos.some(t=>t.targetId===two),'release closed the tab');
  access=await hand();await assert.rejects(host.agent({...access,operation:'switch-tab',tab:two}),/not one of this Workroom's tabs/);
  checks.push('real Chrome: releasing a tab takes it out of the Workroom\'s set without closing it');
  // The person closes the active tab in Chrome: only that tab leaves the set; the connection and the other tab stay.
  const three=await open('/tab-two');await loaded(three,'/tab-two');await host.perform({operation:'take',workspaceId:id});
  r=await host.perform({operation:'select',workspaceId:id,pageId:three,confirmProfile:true,add:true});assert.equal(r.workspace.page.id,three);assert.deepEqual(r.workspace.tabs.map(t=>t.id),[one,three]);
  await raw.send('Target.closeTarget',{targetId:three});
  let w;for(let i=0;i<60;i++){w=(await host.perform({operation:'status',workspaceId:id})).workspace;if(!w.tabs?.some(t=>t.id===three))break;await Bun.sleep(50);}
  assert.equal(w.connection,'connected');assert.deepEqual(w.tabs.map(t=>t.id),[one]);assert.equal(w.page.id,one);
  access=await hand();r=await host.agent({...access,operation:'tabs'});assert.deepEqual(r.workspace.tabs.map(t=>t.id),[one]);
  checks.push('real Chrome: closing the active tab of a set drops only that tab; the connection and the other tab stay and are handed over again');
 }finally{
  for(const w of workspaces)await host.perform({operation:'detach',workspaceId:w}).catch(()=>{});
  for(const t of created)await raw.send('Target.closeTarget',{targetId:t}).catch(()=>{});
 }
 return checks;
}
