const invoke = (...args) => window.__TAURI_INTERNALS__.invoke(...args);
let state;
const message = document.querySelector('#message');
async function act(op, args={}) {
  state = await invoke('browser_action', {op, ...args});
  document.querySelector('#state').textContent = JSON.stringify(state, null, 2);
  document.querySelector('#owner').textContent = `${state.control.owner} · revision ${state.control.epoch}`;
  if(op==='open')await layout();
  return state;
}
for(const button of document.querySelectorAll('[data-op]')) button.addEventListener('click', async()=>{
  try {
    const op=button.dataset.op;
    await act(op);
    if(op==='open')await until(s=>s.observations.every(Boolean));
    if(op==='observe'||op==='return')await until(s=>s.control.owner==='agent'||s.control.owner==='human');
    if(op==='take')await until(s=>s.control.owner==='human');
    message.textContent = '완료';
  } catch(error) { message.textContent = String(error); }
});
document.querySelector('#agent-type').addEventListener('click',async()=>{
  try { await act('agent-type',{epoch:state.control.epoch,text:document.querySelector('#agent-draft').value}); message.textContent='작업 공간에 입력했습니다.'; }
  catch(error){message.textContent=String(error);}
});
async function layout(){
 const rects=['personal','task'].map(id=>{const r=document.querySelector('#'+id).getBoundingClientRect();return [r.x,r.y,r.width,r.height];});
 await act('layout',{text:JSON.stringify(rects)});
}
window.addEventListener('resize',()=>{if(state?.views)layout().catch(e=>message.textContent=String(e));});
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate){for(let i=0;i<80;i++){const s=await act('status');if(predicate(s))return s;await delay(50);}throw Error('Chromium observation timed out');}
async function smoke(){
 const checks=[];
 const check=(name,pass)=>{checks.push({name,pass:!!pass});if(!pass)throw Error(name);};
 try{
  await act('open');
  await until(s=>s.observations.every(Boolean)); await act('observe');
  let s=await until(s=>s.control.owner==='agent');
  check('real Chromium renderers',s.observations.every(o=>/Chrome\//.test(o.ua)));
  check('same-origin cookies isolated',s.observations[0].cookie==='account=personal'&&s.observations[1].cookie==='account=task');
  check('same-origin localStorage isolated',s.observations[0].storage==='personal'&&s.observations[1].storage==='task');
  check('untrusted views have no host IPC bridge',s.observations.every(o=>o.hostBridge===false));
  const old=s.control.epoch;
  await act('agent-type',{epoch:old,text:'agent draft 1'});await until(s=>s.observations[1].draft==='agent draft 1');
  check('agent changes only task document',state.observations[0].draft==='personal initial draft');
  await act('take'); await until(s=>s.control.owner==='human');
  let denied=false;try{await act('agent-type',{epoch:old,text:'late write'});}catch{denied=true;}
  check('takeover rejects queued agent revision',denied);
  await act('human-fixture-type',{text:'human corrected draft'});
  await until(s=>s.observations[1].draft==='human corrected draft');
  await act('return');s=await until(s=>s.control.owner==='agent');
  check('return observes human correction',s.observations[1].draft==='human corrected draft'&&s.control.epoch>old);
  denied=false;try{await act('agent-type',{epoch:old,text:'stale after return'});}catch{denied=true;}
  check('old revision remains rejected after return',denied);
  await act('agent-type',{epoch:s.control.epoch,text:'continued from human correction'});
  await until(s=>s.observations[1].draft==='continued from human correction');
  await act('hide');await act('reopen');await act('observe');s=await until(s=>s.observations[1].draft==='continued from human correction');
  check('hide/reopen preserves document and ownership',s.control.owner==='agent'&&s.views===2);
  const before=s.blockedRequests;await act('deny-external');s=await until(s=>s.blockedRequests>before);
  check('external navigation rejected by native handler',s.blockedRequests>before);
  message.textContent=`${checks.length}개 실제 런타임 검사 통과. 키보드·IME·실제 계정 검증은 별도입니다.`;
 }catch(error){message.textContent=String(error);checks.push({name:String(error),pass:false});}
 document.querySelector('#state').textContent=JSON.stringify({checks,state},null,2);
 await invoke('record_smoke',{report:{checks,state}});
}
document.querySelector('#smoke').addEventListener('click',smoke);
act('status').then(s=>{message.textContent='Chromium 준비 완료. 화면 열기를 누르세요.';if(s.smoke)smoke();}).catch(e=>message.textContent=String(e));
