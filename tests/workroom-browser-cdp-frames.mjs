// P1 observation and manipulation on a real Chrome page: same- and cross-origin iframes, open and closed shadow roots,
// select, scroll, bounded wait and a returned-only screenshot. Local fixture servers only; a disposable profile.
import assert from 'node:assert/strict';
const html=(body,extra={})=>new Response(body,{headers:{'Content-Type':'text/html; charset=utf-8',...extra}});
/** The fixture page: a cross-origin frame (localhost vs 127.0.0.1 is another site, so Chrome runs it out of process). */
export function frameFixture(crossPort){
 return {
  '/frames':()=>html(`<!doctype html><meta charset="utf-8"><title>Frames fixture</title><style>body{margin:0}.top{min-height:1200px;background:#ff0000}.bottom{height:1200px;background:#0000ff}</style>
<div class="top"><h1>Frames main</h1><select id="size" aria-label="Size"><option value="s">Small</option><option value="l">Large</option></select><output id="size-out">size:none</output>
<open-panel></open-panel><closed-panel></closed-panel>
<iframe id="same" src="/same-frame" width="320" height="140"></iframe><iframe id="cross" src="http://localhost:${crossPort}/cross-frame" width="320" height="140"></iframe>
<button id="later-btn">Show later</button></div><div class="bottom"><p>Bottom region</p></div>
<script>
customElements.define('open-panel',class extends HTMLElement{constructor(){super();const r=this.attachShadow({mode:'open'});r.innerHTML='<p>Open shadow text</p><input id="shadow-field" aria-label="Shadow field"><output id="shadow-out">shadow:none</output>';r.querySelector('input').oninput=e=>{r.querySelector('output').textContent='shadow:'+e.target.value;};}});
customElements.define('closed-panel',class extends HTMLElement{constructor(){super();this.attachShadow({mode:'closed'}).innerHTML='<p>Closed shadow secret</p><button>Hidden</button>';}});
document.getElementById('size').onchange=e=>{document.getElementById('size-out').textContent='size:'+e.target.value;};
document.getElementById('later-btn').onclick=()=>setTimeout(()=>{const p=document.createElement('p');p.id='later';p.textContent='Arrived later';document.querySelector('.top').append(p);},600);
</script>`,{'Content-Security-Policy':`default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self' http://localhost:${crossPort}`}),
  '/same-frame':()=>html(`<!doctype html><meta charset="utf-8"><p>Same frame text</p><button id="same-btn">Same</button><output id="same-out">same:none</output><script>document.getElementById('same-btn').onclick=()=>{document.getElementById('same-out').textContent='same:clicked';};</script>`),
  // Values an observation never shows (a password, a hidden token, an undisplayed element) and lists longer than it shows.
  '/form':()=>html(`<!doctype html><meta charset="utf-8"><title>Form fixture</title><h1>Form</h1>
<input type="password" id="pw" class="secret" value="hunter2" aria-label="Password"><input type="hidden" id="csrf" name="csrf" value="tok123"><input id="name" class="field" aria-label="Name">
<p id="ghost" class="note" hidden>Ghost</p>
<select id="country" aria-label="Country">${Array.from({length:15},(_,i)=>`<option value="c${i+1}">Country ${i+1}</option>`).join('')}</select><output id="country-out">country:none</output>
<select id="plan" aria-label="Plan"><option value="short">Short plan</option><option value="${LONG_VALUE}">${LONG_LABEL}</option></select><output id="plan-out">plan:none</output>
<select id="tier" aria-label="Tier"><option value="none">No tier</option><option value="${'q'.repeat(60)}">Tier A</option><option value="${'q'.repeat(62)}">Tier B</option></select>
<button id="reveal">Reveal</button>
<script>
document.getElementById('country').onchange=e=>{document.getElementById('country-out').textContent='country:'+e.target.value;};
document.getElementById('plan').onchange=e=>{document.getElementById('plan-out').textContent='plan:'+e.target.value.length;};
document.getElementById('reveal').onclick=()=>setTimeout(()=>{const p=document.createElement('p');p.id='shown';p.className='note';p.textContent='Now shown';document.body.append(p);},300);
</script>`,{'Content-Security-Policy':"default-src 'self'; script-src 'unsafe-inline'"}),
 };
}
const LONG_VALUE='p'.repeat(70),LONG_LABEL='A plan whose label is far longer than the sixty characters an observation shows';
export const crossFrameFixture=()=>html(`<!doctype html><meta charset="utf-8"><title>Cross frame</title><style>body{margin:0;background:#00ff00;height:140px}</style><p>Cross frame text</p><input id="cross-field" aria-label="Cross field"><output id="cross-out">cross:none</output><script>document.getElementById('cross-field').oninput=e=>{document.getElementById('cross-out').textContent='cross:'+e.target.value;};</script>`);
/** Center-right pixel of a JPEG, decoded by Chrome itself on a blank page with no CSP. */
async function pixel(raw,data){
 const {targetId}=await raw.send('Target.createTarget',{url:'about:blank'});
 try{const {sessionId}=await raw.send('Target.attachToTarget',{targetId,flatten:true});
  const r=await raw.send('Runtime.evaluate',{expression:`new Promise((ok,no)=>{const i=new Image();i.onload=()=>{const c=document.createElement('canvas');c.width=i.width;c.height=i.height;const g=c.getContext('2d');g.drawImage(i,0,0);ok([...g.getImageData(i.width-6,Math.floor(i.height/2),1,1).data.slice(0,3),i.width,i.height]);};i.onerror=()=>no(Error('decode'));i.src='data:image/jpeg;base64,'+${JSON.stringify(data)};})`,awaitPromise:true,returnByValue:true},sessionId);
  return r.result.value;}finally{await raw.send('Target.closeTarget',{targetId});}
}
export async function runFrameChecks({host,raw,profile,url}){
 const checks=[];
 const {targetId:pageId}=await raw.send('Target.createTarget',{url});
 let workspaceId;
 try{
  for(let i=0;i<100;i++){const t=(await raw.send('Target.getTargets')).targetInfos;if(t.some(x=>x.type==='iframe'&&x.url.includes('/cross-frame'))&&t.some(x=>x.targetId===pageId&&x.url===url))break;await Bun.sleep(50);}
  let r=await host.perform({operation:'connect',sessionId:'session_frames',targetId:'project_test',profileId:profile.id});workspaceId=r.workspace.id;
  await host.perform({operation:'select',workspaceId,pageId,confirmProfile:true});
  r=await host.perform({operation:'resume',workspaceId});let o=r.workspace.observation;
  const g=await host.perform({operation:'grant',workspaceId}),access={workspaceId,grant:g.grant,epoch:r.workspace.epoch};
  const same=o.frames?.find(f=>f.text.includes('Same frame text')),cross=o.frames?.find(f=>f.text.includes('Cross frame text'));
  assert(same&&!same.crossOrigin,'same-origin frame observed in its own world');assert(cross&&cross.crossOrigin&&cross.url.startsWith('http://localhost:'),'cross-origin frame observed through its own iframe target');
  assert(o.elements.some(e=>e.selector==='#same-btn'&&e.frame===same.ref));assert(o.elements.some(e=>e.selector==='#cross-field'&&e.frame===cross.ref));
  const shadowField=o.elements.find(e=>e.shadow&&e.selector.endsWith('>>> #shadow-field'));assert(shadowField&&!shadowField.frame,'open shadow element observed with a piercing reference');
  assert(o.text.includes('Open shadow text'));assert(!JSON.stringify(o).includes('Closed shadow secret'),'closed shadow content is never read');
  assert(o.unobservable?.some(u=>u.kind==='closed-shadow-root'&&u.frame==='main'&&u.selector.endsWith('>closed-panel:nth-of-type(1)')),'closed shadow root is reported as not observable');
  checks.push('real Chrome observes same- and cross-origin frames and open shadow roots by reference and reports a closed shadow root as not observable');
  r=await host.agent({...access,operation:'fill',selector:'#cross-field',frame:cross.ref,text:'교차 frame',requestId:'frames_fill_cross',observationId:o.id});o=r.workspace.observation;
  assert(o.frames.find(f=>f.crossOrigin).text.includes('cross:교차 frame'),'fill reached the cross-origin frame');
  r=await host.agent({...access,operation:'click',selector:'#same-btn',frame:o.frames.find(f=>!f.crossOrigin).ref,requestId:'frames_click_same',observationId:o.id});o=r.workspace.observation;
  assert(o.frames.find(f=>!f.crossOrigin).text.includes('same:clicked'));
  r=await host.agent({...access,operation:'fill',selector:o.elements.find(e=>e.shadow).selector,text:'그림자',requestId:'frames_fill_shadow',observationId:o.id});o=r.workspace.observation;assert(o.text.includes('shadow:그림자'));
  r=await host.agent({...access,operation:'select',selector:'#size',value:'Large',requestId:'frames_select_size',observationId:o.id});o=r.workspace.observation;
  assert(o.text.includes('size:l'));assert.deepEqual(o.elements.find(e=>e.selector==='#size').options.map(x=>[x.value,!!x.selected]),[['s',false],['l',true]]);
  assert.equal(r.workspace.receipt.state,'completed');
  checks.push('fill in a cross-origin frame, click in a same-origin frame, fill inside an open shadow root and select an option each reach the real renderer with a completed receipt');
  const top=await host.agent({...access,operation:'screenshot'});assert.equal(top.screenshot.mimeType,'image/jpeg');assert(top.screenshot.data.length<=360000);
  const [tr,tg,tb]=await pixel(raw,top.screenshot.data);assert(tr>200&&tg<60&&tb<60,`top screenshot shows the red top region (${tr},${tg},${tb})`);
  r=await host.agent({...access,operation:'scroll',to:'bottom'});assert(r.workspace.observation.scroll.y>0);
  const bottom=await host.agent({...access,operation:'screenshot'});const [br,bg,bb,w,h]=await pixel(raw,bottom.screenshot.data);assert(bb>200&&br<60&&bg<60,`after scrolling the screenshot shows the blue bottom region (${br},${bg},${bb})`);
  assert(w<=1280&&h<=1280&&w===bottom.screenshot.width&&h===bottom.screenshot.height);
  const status=await host.perform({operation:'status',workspaceId});assert(!JSON.stringify(status).includes(bottom.screenshot.data.slice(0,200)),'the screenshot is kept in no workspace state');
  r=await host.agent({...access,operation:'scroll',to:'top'});assert.equal(r.workspace.observation.scroll.y,0);
  checks.push('scroll moves the real viewport without a receipt; screenshots are the visible viewport, bounded, returned once and kept in no state');
  o=r.workspace.observation;r=await host.agent({...access,operation:'click',selector:'#later-btn',requestId:'frames_click_later',observationId:o.id});
  const unmet=await host.agent({...access,operation:'wait',until:'text',text:'Never shown',timeoutMs:300});assert.equal(unmet.waited.satisfied,false);
  const met=await host.agent({...access,operation:'wait',until:'selector',selector:'#later',timeoutMs:4000});assert.equal(met.waited.satisfied,true);assert(met.workspace.observation.text.includes('Arrived later'));
  checks.push('a bounded wait reports an unmet condition after its timeout and returns a fresh observation once a delayed element appears');
  // Trusted human input inside the cross-origin frame never reaches the parent document; the frame's own listener revokes.
  const {sessionId:pageSession}=await raw.send('Target.attachToTarget',{targetId:pageId,flatten:true});
  const box=(await raw.send('Runtime.evaluate',{expression:'(()=>{const r=document.getElementById("cross").getBoundingClientRect();return [r.left+20,r.top+20];})()',returnByValue:true},pageSession)).result.value;
  for(const type of ['mousePressed','mouseReleased'])await raw.send('Input.dispatchMouseEvent',{type,x:box[0],y:box[1],button:'left',clickCount:1},pageSession);
  for(let i=0;i<40;i++){const s=await host.perform({operation:'status',workspaceId});if(s.workspace.owner==='human')break;await Bun.sleep(50);}
  await assert.rejects(host.agent({...access,operation:'observe'}),/revoked|Stale/);
  await raw.send('Target.detachFromTarget',{sessionId:pageSession});
  checks.push('trusted human input inside a cross-origin frame revokes agent access');
 }finally{if(workspaceId)await host.perform({operation:'detach',workspaceId}).catch(()=>{});await raw.send('Target.closeTarget',{targetId:pageId}).catch(()=>{});}
 return checks;
}
/** A wait selector cannot read what an observation leaves out, and a long list says what it cut yet reaches every option. */
export async function runFormChecks({host,raw,profile,url}){
 const checks=[];const {targetId:pageId}=await raw.send('Target.createTarget',{url});let workspaceId;
 try{
  for(let i=0;i<100;i++){if((await raw.send('Target.getTargets')).targetInfos.some(x=>x.targetId===pageId&&x.url===url&&x.title==='Form fixture'))break;await Bun.sleep(50);}
  let r=await host.perform({operation:'connect',sessionId:'session_form',targetId:'project_test',profileId:profile.id});workspaceId=r.workspace.id;
  await host.perform({operation:'select',workspaceId,pageId,confirmProfile:true});r=await host.perform({operation:'resume',workspaceId});let o=r.workspace.observation;
  const g=await host.perform({operation:'grant',workspaceId}),access={workspaceId,grant:g.grant,epoch:r.workspace.epoch};
  assert(!JSON.stringify(o).includes('hunter2')&&!JSON.stringify(o).includes('tok123')&&!o.elements.some(e=>['#pw','#csrf'].includes(e.selector)),'the observation shows neither field');
  for(const selector of ['input[type=password][value^="h"]','input[name=csrf][value^="tok1"]','#pw:not([value=""])','body:has(#pw)'])await assert.rejects(host.agent({...access,operation:'wait',until:'selector',selector,timeoutMs:200}),/tag, #id and \.class/);
  const wait=async selector=>(await host.agent({...access,operation:'wait',until:'selector',selector,timeoutMs:300})).waited.satisfied;
  for(const selector of ['#pw','input.secret','#csrf','input#csrf','#ghost','p.note'])assert.equal(await wait(selector),false,`${selector} is not something an observation shows`);
  assert.equal(await wait('input.field'),true,'a displayed field is found');
  o=(await host.agent({...access,operation:'observe'})).workspace.observation;
  await host.agent({...access,operation:'click',selector:'#reveal',requestId:'form_click_reveal',observationId:o.id});
  const met=await host.agent({...access,operation:'wait',until:'selector',selector:'p.note',timeoutMs:4000});assert.equal(met.waited.satisfied,true);assert(met.workspace.observation.text.includes('Now shown'));
  checks.push('real Chrome: a wait selector with an attribute or state test is refused, and password, hidden and undisplayed elements never satisfy one');
  o=met.workspace.observation;const country=o.elements.find(e=>e.selector==='#country'),plan=o.elements.find(e=>e.selector==='#plan');
  assert.equal(country.options.length,12);assert.equal(country.moreOptions,3);assert.equal(plan.moreOptions,undefined);
  const long=plan.options[1];assert.equal(long.truncated,true);assert.equal(long.value,'p'.repeat(60));assert.equal(long.label.length,60);
  r=await host.agent({...access,operation:'select',selector:'#country',value:'Country 14',requestId:'form_select_country',observationId:o.id});o=r.workspace.observation;
  assert(o.text.includes('country:c14'),'an option past the shown twelve is chosen by its exact label');assert.equal(r.workspace.receipt.state,'completed');
  r=await host.agent({...access,operation:'select',selector:'#plan',value:long.value,requestId:'form_select_plan',observationId:o.id});o=r.workspace.observation;
  assert(o.text.includes('plan:70'),'a cut option is chosen by the value shown');
  r=await host.agent({...access,operation:'select',selector:'#plan',value:long.label,requestId:'form_select_plan_label',observationId:o.id});assert(r.workspace.observation.text.includes('plan:70'));
  checks.push('real Chrome: a long list counts the options it leaves out and marks a cut option; select reaches an option past the twelve shown and a cut one by its shown text');
  // Tier A's whole value is exactly the text shown for the cut Tier B: that text names neither option.
  o=r.workspace.observation;const tier=o.elements.find(e=>e.selector==='#tier');assert.equal(tier.options[1].truncated,undefined);assert.equal(tier.options[2].truncated,true);assert.equal(tier.options[2].value,tier.options[1].value);
  await assert.rejects(host.agent({...access,operation:'select',selector:'#tier',value:tier.options[2].value,requestId:'form_select_tier',observationId:o.id}),/Page action failed/);
  checks.push('real Chrome: the shown text of a cut option that is also another option\'s whole value names neither and is refused');
 }finally{if(workspaceId)await host.perform({operation:'detach',workspaceId}).catch(()=>{});await raw.send('Target.closeTarget',{targetId:pageId}).catch(()=>{});}
 return checks;
}
