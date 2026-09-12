import {createProjectCreationIntentStore,projectCreationIntentFingerprint} from './projectLaunchIntent';
import appearanceTokens from './appearanceTokens.css' with {type:'text'};
import {LAN_XTERM_JS,LAN_XTERM_CSS} from './lanTerminalAssets';
import { REMOTE_CONTROL_PROTOCOL_VERSION } from './remoteControlCore';

export const REMOTE_CONTROL_MOBILE_HTML = `<!doctype html>
<html lang="ko" data-app-theme="gray">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
    <meta name="theme-color" content="#07111f" />
    <meta name="referrer" content="no-referrer" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <link rel="manifest" href="/remote/manifest.webmanifest" />
    <link rel="icon" href="/remote/icon.svg" />
    <link rel="stylesheet" href="/remote/styles.css" /><link rel="stylesheet" href="/remote/xterm.css" />
    <title>AgentsToZ 원격 제어</title>
  </head>
  <body>
    <main>
      <header>
        <div class="brand-mark">AZ</div>
        <div>
          <p class="eyebrow">SAME-LAN CONTROL</p>
          <h1 id="host-name">AgentsToZ 원격 제어</h1>
        </div>
        <span id="connection" class="status waiting">연결 중</span>
      </header>
      <nav class="workspace-tabs" aria-label="작업 공간">
        <button data-workspace-tab="projects" aria-pressed="true">프로젝트</button>
        <button data-workspace-tab="workroom" aria-pressed="false">워크룸</button>
      </nav>
      <section id="intro" class="panel intro">
        <h2>이 Mac과 같은 신뢰 가능한 Wi-Fi에서만 사용하세요</h2>
        <p id="intro-message">QR 연결 정보를 확인하고 있습니다.</p>
      </section>
      <section class="toolbar" hidden id="toolbar">
        <button type="button" class="secondary" id="refresh">상태 새로고침</button>
        <span id="session-expiry"></span><button class="secondary" data-workspace-disconnect>연결 해제</button>
      </section>
      <section class="panel" id="project-create" hidden>
        <h2>새 프로젝트</h2>
        <label for="create-root">Mac의 작업 루트</label><select id="create-root"></select>
        <label for="create-name">프로젝트 이름</label><input id="create-name" maxlength="120" autocomplete="off" placeholder="프로젝트 이름" />
        <button id="create-project">프로젝트 만들기</button>
        <p>Mac에 폴더와 Git·장기기억을 준비한 뒤 워크룸에서 바로 작업할 수 있습니다.</p>
      </section>
      <section class="filter" hidden id="filter">
        <label for="project-search">프로젝트 또는 워크트리 검색</label>
        <input id="project-search" type="search" inputmode="search" autocomplete="off"
          placeholder="이름 · 별명 · 브랜치로 검색" />
        <label for="workspace-root-filter">로컬 작업 루트</label>
        <select id="workspace-root-filter">
          <option value="">모든 작업 루트</option>
        </select>
        <span id="project-count"></span>
      </section>
      <section class="errors" hidden id="error-log" aria-live="assertive">
        <div class="errors-head">
          <h2>실패한 요청</h2>
          <button type="button" class="secondary" id="error-clear">지우기</button>
        </div>
        <ol id="error-items"></ol>
      </section>
      <section id="projects" class="project-list" aria-live="polite"></section>
      <section class="panel" id="terminal-panel" hidden>
        <h2>워크룸</h2><p>Mac에서 이 연결의 터미널 접근을 허용한 뒤 사용하세요.</p>
        <select id="terminal-project" aria-label="터미널 프로젝트"></select>
        <select id="terminal-agent" aria-label="터미널 AI"><option value="codex">Codex CLI</option><option value="claude">Claude Code</option><option value="hermes">Hermes</option><option value="agy">Antigravity</option></select>
        <button id="terminal-start">새 터미널</button><button id="terminal-refresh">세션 새로고침</button>
        <select id="terminal-session" aria-label="터미널 세션"><option value="">세션 선택</option></select>
        <button id="terminal-remember" disabled>세션 기억하기…</button>
        <p id="terminal-memory-guide" hidden>선택한 세션의 프로젝트와 입력 내용을 확인한 뒤 전송하세요. AI에 저장을 요청하며 완료 여부는 터미널 응답에서 확인합니다.</p>
        <p id="terminal-error" role="alert"></p><div id="terminal-screen" class="terminal-screen"></div>
        <input id="terminal-line" placeholder="명령 또는 요청 입력" autocomplete="off" maxlength="32768"/><button id="terminal-send">전송</button>
        <button id="terminal-enter">Enter</button><button id="terminal-escape">Esc</button><button id="terminal-interrupt">Ctrl+C</button><button id="terminal-close">세션 종료</button>
      </section>
      <div id="toast" role="status" aria-live="polite"></div>
    </main>
    <script src="/remote/xterm.js"></script><script type="module" src="/remote/app.js"></script>
  </body>
</html>`;

// Keep the fragment handling as the first executable operation. The one-time
// QR secret must leave the address bar before DOM work or network activity.
export const REMOTE_CONTROL_MOBILE_JS = `let initialPairFragment = location.hash.slice(1);
history.replaceState(null, "", location.pathname + location.search);
let pairToken = new URLSearchParams(initialPairFragment).get("pair") || "";
initialPairFragment = "";

const PROTOCOL_VERSION = ${JSON.stringify(REMOTE_CONTROL_PROTOCOL_VERSION)};
const connection = document.querySelector("#connection");
const hostName = document.querySelector("#host-name");
const intro = document.querySelector("#intro");
const introMessage = document.querySelector("#intro-message");
const projectsNode = document.querySelector("#projects");
const toolbar = document.querySelector("#toolbar");
const filterBar = document.querySelector("#filter");
const searchInput = document.querySelector("#project-search");
const workspaceRootFilter = document.querySelector("#workspace-root-filter");
const projectCount = document.querySelector("#project-count");
const refreshButton = document.querySelector("#refresh");
const sessionExpiry = document.querySelector("#session-expiry");
const toast = document.querySelector("#toast");
const errorLog = document.querySelector("#error-log");
const errorItems = document.querySelector("#error-items");
const errorClear = document.querySelector("#error-clear");
let socket = null;
let sessionToken = "";
const terminalWaiters=new Map();
let terminalInstance=null,terminalSelected="",terminalCursor=0,terminalTimer=null,terminalGeneration=0,terminalConnectionGeneration=0;
let terminalStarting=false,terminalPending='',terminalInputTimer=null,terminalInputSession='',terminalInputReceipt=null;
let terminalLineSending=false,terminalLineGeneration=0;
const terminalRequests=new Set(),terminalClosing=new Set();
const TERMINAL_MAX_PENDING=128,TERMINAL_MAX_INPUT_BYTES=32768;
const terminalError=document.querySelector('#terminal-error');
// One bounded choice per origin. It shares the existing credential's lifetime,
// but never stores a second credential, prompt, output, command or local path.
const TERMINAL_SELECTION_STORAGE_KEY='agentstoz-terminal-selection-v1';
let terminalSelectionOwner='',terminalChoice={targetId:'',agent:'codex',sessionId:''},terminalRestoreGeneration=-1;
let terminalSessionSummaries=[];
function terminalForgetSelection(){
  try{localStorage.removeItem(TERMINAL_SELECTION_STORAGE_KEY);}catch{}
  terminalChoice={targetId:'',agent:'codex',sessionId:''};terminalSelectionOwner='';terminalRestoreGeneration=-1;
}
function terminalBindSelection(){
  if(terminalSelectionOwner===sessionToken)return;
  const samePairing=!terminalSelectionOwner&&typeof loadSavedSession==='function'&&loadSavedSession()===sessionToken;
  if(!samePairing)terminalForgetSelection();
  terminalSelectionOwner=sessionToken;terminalSelected='';
  if(samePairing)try{
    const raw=localStorage.getItem(TERMINAL_SELECTION_STORAGE_KEY);
    const saved=raw&&raw.length<=1024?JSON.parse(raw):null;
    if(saved&&Object.keys(saved).sort().join(',')==='agent,sessionId,targetId,version'&&saved.version===1
      &&['codex','claude','hermes','agy'].includes(saved.agent)
      &&[saved.targetId,saved.sessionId].every(id=>typeof id==='string'&&id.length<=128&&/^[A-Za-z0-9_-]*$/.test(id))){
      terminalChoice={targetId:saved.targetId,agent:saved.agent,sessionId:saved.sessionId};
    }
  }catch{}
}
function terminalRememberSelection(){
  if(!sessionToken||terminalSelectionOwner!==sessionToken)return;
  terminalChoice={targetId:document.querySelector('#terminal-project').value,agent:document.querySelector('#terminal-agent').value,sessionId:terminalSelected};
  try{localStorage.setItem(TERMINAL_SELECTION_STORAGE_KEY,JSON.stringify({version:1,...terminalChoice}));}catch{}
}
function terminalReply(message){const waiter=terminalWaiters.get(message.requestId);if(!waiter)return;terminalWaiters.delete(message.requestId);clearTimeout(waiter.timer);message.ok?waiter.resolve(message.body):waiter.reject(new Error(message.error));}
function terminalWireRequest(request){return new Promise((resolve,reject)=>{if(!sessionToken||!socket||socket.readyState!==WebSocket.OPEN){reject(new Error('원격 연결을 먼저 완료하세요.'));return;}const requestId=nextActionId();const timer=setTimeout(()=>{terminalWaiters.delete(requestId);reject(new Error('응답을 확인하지 못했습니다. 입력이 전달되었을 수 있으므로 화면을 확인하세요.'));},15000);terminalWaiters.set(requestId,{resolve,reject,timer});try{socket.send(JSON.stringify({type:'terminal.request',sessionToken,request:{...request,requestId}}));}catch(error){terminalWaiters.delete(requestId);clearTimeout(timer);reject(error);}});}
let terminalWire=Promise.resolve(),terminalAdmission=Promise.resolve(),terminalNextAt=0;
function terminalCancelled(){const error=new Error('전송 전 터미널 요청을 취소했습니다.');error.cancelled=true;return error;}
function terminalRequest(request){
  if(request.operation!=='close'&&terminalRequests.size>=TERMINAL_MAX_PENDING)return Promise.reject(new Error('터미널 입력 대기열이 가득 찼습니다. 화면을 확인한 뒤 다시 입력하세요.'));
  if(request.sessionId&&terminalClosing.has(request.sessionId)&&request.operation!=='close')return Promise.reject(terminalCancelled());
  const ticket={request,cancelled:false,sent:false};terminalRequests.add(ticket);
  const send=async()=>{
    if(ticket.cancelled)throw terminalCancelled();
    // Reserve starts independently of response latency so close is not trapped
    // behind a stalled read. The same 180 ms wire spacing still applies.
    const slot=terminalAdmission.catch(()=>{}).then(async()=>{const delay=terminalNextAt-performance.now();if(delay>0)await new Promise(resolve=>setTimeout(resolve,delay));if(ticket.cancelled)throw terminalCancelled();terminalNextAt=performance.now()+180;});
    terminalAdmission=slot;await slot;if(ticket.cancelled)throw terminalCancelled();ticket.sent=true;return terminalWireRequest(request);
  };
  const result=request.operation==='close'?send():terminalWire.catch(()=>{}).then(send);
  if(request.operation!=='close')terminalWire=result;
  return result.finally(()=>terminalRequests.delete(ticket));
}
function terminalQueue(request){return terminalRequest(request).catch(e=>{if(!e.cancelled)terminalError.textContent=e.message;});}
function terminalCancelUnsent(sessionId){
  let cancelled=false;
  if(!sessionId||terminalInputSession===sessionId){cancelled=!!terminalPending;clearTimeout(terminalInputTimer);terminalInputTimer=null;terminalPending='';terminalInputSession='';const receipt=terminalInputReceipt;terminalInputReceipt=null;if(receipt)receipt(false);}
  for(const ticket of terminalRequests)if(!ticket.sent&&(!sessionId||ticket.request.sessionId===sessionId)&&ticket.request.operation!=='close'){ticket.cancelled=true;cancelled=true;}
  return cancelled;
}
function terminalDisconnected(){
  terminalCancelUnsent();clearTimeout(terminalTimer);terminalGeneration++;terminalConnectionGeneration++;
  document.querySelector('#terminal-remember').disabled=true;
  // Even a priority close waiting for its wire slot belongs to the old socket.
  for(const ticket of terminalRequests)if(!ticket.sent)ticket.cancelled=true;
  for(const waiter of terminalWaiters.values()){clearTimeout(waiter.timer);waiter.reject(new Error('연결이 끊겨 결과를 확인하지 못했습니다. 세션 목록과 화면을 확인하세요.'));}terminalWaiters.clear();
}
async function terminalPoll(){const selected=terminalSelected,generation=terminalGeneration;if(!selected||!socket||socket.readyState!==WebSocket.OPEN)return;try{const r=await terminalRequest({operation:'read',sessionId:selected,after:terminalCursor});if(generation!==terminalGeneration)return;if(r.truncated){terminalInstance.reset();terminalError.textContent='이전 출력 일부가 보관 범위를 넘었습니다.';}for(const c of r.chunks||[]){if(c.seq>terminalCursor){terminalInstance.write(c.text);terminalCursor=c.seq;}}if(r.session?.state==='exited'&&!r.hasMore)return;}catch(e){if(generation===terminalGeneration&&!e.cancelled)terminalError.textContent=e.message;}if(generation===terminalGeneration)terminalTimer=setTimeout(terminalPoll,700);}
function terminalSelect(id){
  const cancelled=terminalCancelUnsent(terminalSelected);clearTimeout(terminalTimer);terminalGeneration++;terminalSelected=id;
  document.querySelector('#terminal-remember').disabled=!id;terminalCursor=0;terminalInstance.reset();terminalRememberSelection();
  if(cancelled)terminalError.textContent='세션이 바뀌어 아직 보내지 않은 입력을 취소했습니다. 각 세션 화면을 확인하세요.';
  if(id)void terminalPoll();
}
async function terminalList(){
  const generation=terminalConnectionGeneration;
  try{
    const r=await terminalRequest({operation:'list'});if(generation!==terminalConnectionGeneration)return;
    const list=document.querySelector('#terminal-session');list.replaceChildren(new Option('세션 선택',''));
    terminalSessionSummaries=r.sessions||[];
    for(const session of terminalSessionSummaries)list.add(new Option(session.agent+' · '+session.state,session.id));
    const wanted=terminalSelected||terminalChoice.sessionId;
    const found=terminalSessionSummaries.find(session=>session.id===wanted&&session.targetId===document.querySelector('#terminal-project').value);
    if(wanted&&!found){terminalSelect('');list.value='';terminalError.textContent='이전 세션이 종료되었거나 현재 프로젝트에서 확인되지 않습니다. 새 작업은 직접 시작하세요.';}
    else if(found){
      document.querySelector('#terminal-agent').value=found.agent;list.value=found.id;terminalError.textContent='';
      if(terminalSelected!==found.id)terminalSelect(found.id);
      else{document.querySelector('#terminal-remember').disabled=false;clearTimeout(terminalTimer);void terminalPoll();terminalRememberSelection();}
    }else{list.value='';terminalError.textContent='';}
  }catch(e){if(generation===terminalConnectionGeneration&&!e.cancelled)terminalError.textContent=e.message;}
}
function terminalReady(projects){
  terminalBindSelection();
  const panel=document.querySelector('#terminal-panel');panel.hidden=false;
  const select=document.querySelector('#terminal-project'),current=select.value||terminalChoice.targetId;
  select.replaceChildren();for(const project of projects)select.add(new Option(project.name,project.controlId));
  if(current&&!projects.some(project=>project.controlId===current)){
    select.add(new Option('이전 프로젝트를 확인할 수 없습니다 · 직접 선택',''));select.value='';
    terminalError.textContent='이전 프로젝트를 현재 목록에서 확인할 수 없습니다. 다른 프로젝트를 자동으로 선택하지 않습니다.';
  }else if(current)select.value=current;
  if(terminalChoice.agent)document.querySelector('#terminal-agent').value=terminalChoice.agent;
  if(!terminalInstance){terminalInstance=new window.Terminal({cols:Math.max(20,Math.min(100,Math.floor(panel.clientWidth/8))),rows:24,fontSize:12,theme:{background:'#111315',foreground:'#e5e7eb'},scrollback:1500});terminalInstance.open(document.querySelector('#terminal-screen'));terminalInstance.onData(terminalInput);new ResizeObserver(()=>{const cols=Math.max(20,Math.min(100,Math.floor((panel.clientWidth-40)/7.3)));if(cols!==terminalInstance.cols){terminalInstance.resize(cols,24);if(terminalSelected)void terminalQueue({operation:'resize',sessionId:terminalSelected,cols,rows:24});}}).observe(panel);}
  if(terminalChoice.sessionId&&select.value&&terminalRestoreGeneration!==terminalConnectionGeneration){terminalRestoreGeneration=terminalConnectionGeneration;void terminalList();}
}
document.querySelector('#terminal-refresh').onclick=terminalList;
document.querySelector('#terminal-project').onchange=()=>{terminalSelect('');document.querySelector('#terminal-session').value='';};
document.querySelector('#terminal-agent').onchange=()=>{terminalSelect('');document.querySelector('#terminal-session').value='';};
document.querySelector('#terminal-session').onchange=e=>{
  const selected=terminalSessionSummaries.find(session=>session.id===e.target.value);
  if(selected){document.querySelector('#terminal-project').value=selected.targetId;document.querySelector('#terminal-agent').value=selected.agent;}
  if(selected&&!document.querySelector('#terminal-project').value){terminalError.textContent='세션의 프로젝트를 현재 목록에서 확인할 수 없습니다.';return;}
  terminalSelect(e.target.value);
};
document.querySelector('#terminal-start').onclick=async()=>{
  if(terminalStarting||!terminalInstance)return;
  const targetId=document.querySelector('#terminal-project').value;
  if(!targetId){terminalError.textContent='작업할 프로젝트를 직접 선택하세요.';return;}
  terminalRememberSelection();terminalStarting=true;
  const generation=terminalConnectionGeneration,selection=terminalGeneration,button=document.querySelector('#terminal-start');button.disabled=true;
  try{
    const r=await terminalRequest({operation:'start',targetId,agent:document.querySelector('#terminal-agent').value,cols:terminalInstance.cols,rows:terminalInstance.rows});
    if(generation!==terminalConnectionGeneration)return;await terminalList();if(generation!==terminalConnectionGeneration||selection!==terminalGeneration)return;
    document.querySelector('#terminal-session').value=r.session.id;terminalSelect(r.session.id);
  }catch(e){if(generation===terminalConnectionGeneration&&selection===terminalGeneration&&!e.cancelled)terminalError.textContent=e.message;}
  finally{terminalStarting=false;button.disabled=false;}
};
document.querySelector('#terminal-close').onclick=async()=>{
  const sessionId=terminalSelected,generation=terminalConnectionGeneration;if(!sessionId||terminalClosing.has(sessionId))return;
  terminalClosing.add(sessionId);terminalCancelUnsent(sessionId);clearTimeout(terminalTimer);terminalGeneration++;
  try{await terminalRequest({operation:'close',sessionId});if(generation!==terminalConnectionGeneration)return;if(terminalSelected===sessionId)terminalSelect('');await terminalList();}
  catch(e){if(generation===terminalConnectionGeneration&&!e.cancelled)terminalError.textContent=e.message;}
  finally{terminalClosing.delete(sessionId);if(generation===terminalConnectionGeneration&&terminalSelected===sessionId)void terminalPoll();}
};
function terminalInput(data,receipt){
  if(!terminalSelected||terminalClosing.has(terminalSelected))return false;
  if(typeof data!=='string'||terminalPending.length+data.length>TERMINAL_MAX_INPUT_BYTES||new TextEncoder().encode(terminalPending+data).length>TERMINAL_MAX_INPUT_BYTES){terminalError.textContent='한 번에 보낼 입력이 너무 큽니다. 내용을 나누어 입력하세요.';return false;}
  // A batch owns one session from its first character until dispatch. Selection
  // changes cancel unsent input instead of moving it to another conversation.
  if(terminalInputSession&&terminalInputSession!==terminalSelected)terminalCancelUnsent(terminalInputSession);
  terminalInputSession=terminalSelected;terminalPending+=data;if(receipt)terminalInputReceipt=receipt;if(terminalInputTimer)return true;
  terminalInputTimer=setTimeout(()=>{
    terminalInputTimer=null;const sessionId=terminalInputSession,data=terminalPending,receipt=terminalInputReceipt;terminalPending='';terminalInputSession='';terminalInputReceipt=null;
    if(!sessionId||sessionId!==terminalSelected||terminalClosing.has(sessionId)){if(receipt)receipt(false);return;}
    const parts=[];let part='',size=0,encoded=0;const encoder=new TextEncoder();
    for(const char of data){const n=encoder.encode(char).length,e=encoder.encode(JSON.stringify(char)).length-2;if(size+n>4096||encoded+e>7500){parts.push(part);part='';size=0;encoded=0;}part+=char;size+=n;encoded+=e;}if(part)parts.push(part);
    if(terminalRequests.size+parts.length>TERMINAL_MAX_PENDING){terminalError.textContent='터미널 입력 대기열이 가득 찼습니다. 이번 입력은 보내지 않았습니다. 화면을 확인하세요.';if(receipt)receipt(false);return;}
    for(const data of parts)void terminalQueue({operation:'input',sessionId,data});
    if(receipt)receipt(true);
  },180);return true;
}
for(const [id,data] of [['terminal-enter','\\r'],['terminal-escape','\\x1b'],['terminal-interrupt','\\x03']])document.getElementById(id).onclick=()=>terminalInput(data);
document.querySelector('#terminal-line').oninput=()=>{terminalLineGeneration++;};
document.querySelector('#terminal-remember').onclick=()=>{
  if(!terminalSelected)return;
  const field=document.querySelector('#terminal-line');
  if(field.value||terminalLineSending){terminalError.textContent='작성 중인 요청을 유지했습니다. 먼저 내용을 전송하거나 비운 뒤 세션 기억 요청을 여세요.';return;}
  field.value='이 프로젝트의 remember-session 스킬을 실행해 완료된 작업과 검증된 결정을 장기기억에 저장하세요. 실제 저장소와 기존 기억을 먼저 확인하고, 진행 중인 작업이나 잠금 또는 미확정 저장이 있으면 강제로 해제하거나 덮어쓰거나 재실행하지 말고 현재 상태를 설명하세요.';
  terminalLineGeneration++;document.querySelector('#terminal-memory-guide').hidden=false;field.focus?.();
};
document.querySelector('#terminal-send').onclick=()=>{
  const field=document.querySelector('#terminal-line'),button=document.querySelector('#terminal-send');if(terminalLineSending||!field.value)return;
  const value=field.value,draft=terminalLineGeneration,selection=terminalGeneration;terminalLineSending=true;button.disabled=true;
  // Keep one bounded line receipt until the batch has room in the queue. A
  // later receipt must not clear a new draft or a different selected session.
  const complete=admitted=>{terminalLineSending=false;button.disabled=false;if(admitted&&draft===terminalLineGeneration&&selection===terminalGeneration&&field.value===value)field.value='';};
  if(!terminalInput(value+'\\r',complete))complete(false);
};

let actionSequence = 0;
const WORKSPACE_TAB_STORAGE_KEY='agentstoz-workspace-tab';
let workspaceTab='projects';
try{workspaceTab=localStorage.getItem(WORKSPACE_TAB_STORAGE_KEY)==='workroom'?'workroom':'projects';}catch{}
function showWorkspaceTab(tab){
  workspaceTab=tab==='workroom'?'workroom':'projects';document.body.dataset.workspaceTab=workspaceTab;
  try{localStorage.setItem(WORKSPACE_TAB_STORAGE_KEY,workspaceTab);}catch{}
  for(const button of document.querySelectorAll('[data-workspace-tab]'))button.setAttribute('aria-pressed',String(button.dataset.workspaceTab===workspaceTab));
  if(workspaceTab==='workroom'&&terminalInstance){requestAnimationFrame(()=>{terminalInstance.refresh(0,terminalInstance.rows-1);});}
}
for(const button of document.querySelectorAll('[data-workspace-tab]'))button.onclick=()=>showWorkspaceTab(button.dataset.workspaceTab);
showWorkspaceTab(workspaceTab);
let disconnectInFlight=null;
window.agentstozDisconnect=()=>{
  if(disconnectInFlight)return disconnectInFlight;
  intentionalClose=true;cancelReconnect();
  const closingSocket=socket,closingToken=sessionToken;
  clearSavedSession();sessionToken='';terminalDisconnected();setStatus('연결 해제됨','offline');
  intro.hidden=false;introMessage.textContent='이 기기의 연결을 해제했습니다. 다시 사용하려면 Mac의 QR로 연결하세요.';
  disconnectInFlight=new Promise(resolve=>{
    if(!closingSocket||closingSocket.readyState!==WebSocket.OPEN||!closingToken){resolve(false);return;}
    let timer;
    const finish=confirmed=>{clearTimeout(timer);closingSocket.removeEventListener('message',ack);closingSocket.removeEventListener('close',closed);closingSocket.close(1000);resolve(confirmed);};
    const ack=event=>{try{if(JSON.parse(String(event.data)).type==='session.closed')finish(true);}catch{}};
    const closed=()=>finish(false);
    closingSocket.addEventListener('message',ack);closingSocket.addEventListener('close',closed);
    timer=setTimeout(()=>finish(false),3000);
    closingSocket.send(JSON.stringify({type:'session.end',protocolVersion:PROTOCOL_VERSION,sessionToken:closingToken}));
  });
  return disconnectInFlight;
};
document.querySelector('[data-workspace-disconnect]').onclick=()=>void window.agentstozDisconnect();
let inFlight = false;
let inFlightTimer = null;
/** Long enough for a slow git or a cold PTY, short enough that the phone is never permanently inert. */
const ACTION_RESPONSE_TIMEOUT_MS = 90000;
/** One host rate window plus a margin, so the resumed page is not refused for the same reason. */
const RATE_LIMIT_RETRY_MS = 11000;
/** A held action lock is transient; re-look soon rather than waiting out another whole window. */
const RATE_LIMIT_BUSY_RECHECK_MS = 1000;
let enumerationRetryTimer = null;
/** Bumped whenever a new enumeration starts, so an older walk's timer retires itself. */
let enumerationGeneration = 0;
/** The page the in-flight projects.list actually asked for, which is what a refusal must retry. */
let lastRequestedPage = null;
let projects = [];
let nextProjectPage = null;
let totalProjectCount = 0;
let projectQuery = "";
let selectedWorkspaceRoot = "";
let workspaceRootNames = [];
let workspaceRoots = [];
let workspaceRootsRequested = false;
const UNASSIGNED_WORKSPACE_ROOT = "__unassigned__";
const WORKSPACE_ROOT_FILTER_PREFIX = "root:";
// Name of the action currently in flight, so a result can say what succeeded
// or failed instead of a generic "요청을 처리했습니다".
const projectIntentFingerprint = ${projectCreationIntentFingerprint.toString()};
const projectIntentFactory = ${createProjectCreationIntentStore.toString()};
let currentProjectCreateIntent = null;
function projectIntentStore() { return projectIntentFactory(localStorage, () => 'pc-' + Array.from(crypto.getRandomValues(new Uint8Array(16)), byte=>byte.toString(16).padStart(2,'0')).join(''), projectIntentFingerprint); }
let lastActionName = "";
let lastActionCode = "";

// --- Persistent failure log ---
// A toast disappears in under three seconds. Two refused worktree creations on
// 9월1일테스트 therefore read as "nothing happened", and the user retried the
// same blocked action instead of committing the two files that blocked it.
// Failures stay on screen until explicitly dismissed.
const MAX_ERROR_ENTRIES = 20;

// Next-step guidance keyed by the host's error code. The refusal alone does not
// tell the user what to do about it.
const ERROR_NEXT_STEPS = {
  GIT_WORKTREE_DIRTY: "이 프로젝트 카드의 Commit 버튼으로 먼저 커밋한 뒤 다시 시도하세요.",
  WORKTREE_SOURCE_DIRTY: "이 프로젝트 카드의 Commit 버튼으로 먼저 커밋한 뒤 다시 시도하세요.",
  DETACHED_HEAD: "Mac에서 브랜치를 체크아웃한 뒤 다시 시도하세요.",
  ACTION_IN_PROGRESS: "진행 중인 작업이 끝난 뒤 다시 시도하세요.",
  RATE_LIMITED: "잠시 뒤 자동으로 다시 시도합니다. 목록이 짧아 보이면 상태 새로고침을 누르세요.",
  SESSION_DISCONNECTED: "요청 도중 연결이 끊겨 실행하지 않았습니다. 상태를 새로고침한 뒤 다시 누르세요.",
  PROJECT_NOT_FOUND: "Mac의 AgentsToZ 앱에서 이 프로젝트가 등록되어 있는지 확인하세요.",
  ORCA_WORKTREE_CREATE_NOT_VERIFIED: "Mac에서 Orca 상태를 확인한 뒤 다시 시도하세요.",
  CODEX_PROJECT_SESSION_NOT_FOUND: "위의 새 Codex 대화 만들기를 사용하세요.",
  HERMES_PROJECT_SESSION_NOT_FOUND: "아래 Orca에서 열기의 Hermes 버튼으로 새 세션을 시작하세요.",
};

function clearErrors() {
  if (!errorItems || !errorLog) return;
  errorItems.replaceChildren();
  errorLog.hidden = true;
}

function recordError(context, error) {
  if (!errorItems || !errorLog) return;
  const code = (error && error.code) || "UNKNOWN";
  const message = (error && error.message) || "요청을 처리하지 못했습니다.";
  const item = document.createElement("li");

  const head = document.createElement("p");
  head.className = "error-head";
  head.textContent = new Date().toLocaleTimeString(undefined, {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }) + " · " + (context || "요청");
  item.append(head);

  const body = document.createElement("p");
  body.className = "error-message";
  body.textContent = message;
  item.append(body);

  const codeLine = document.createElement("p");
  codeLine.className = "error-code";
  codeLine.textContent = code;
  item.append(codeLine);

  // The host sends repository-relative paths for a dirty-tree refusal. Showing
  // them is the difference between "commit first" and knowing what to commit.
  const paths = error && Array.isArray(error.changedPaths) ? error.changedPaths : [];
  if (paths.length > 0) {
    const list = document.createElement("ul");
    list.className = "error-paths";
    for (const path of paths.slice(0, 12)) {
      const entry = document.createElement("li");
      entry.textContent = path;
      list.append(entry);
    }
    item.append(list);
  }

  const nextStep = ERROR_NEXT_STEPS[code];
  if (nextStep) {
    const hint = document.createElement("p");
    hint.className = "error-hint";
    hint.textContent = nextStep;
    item.append(hint);
  }

  errorItems.prepend(item);
  while (errorItems.childElementCount > MAX_ERROR_ENTRIES) {
    errorItems.lastElementChild?.remove();
  }
  errorLog.hidden = false;
}

// --- Reconnection state ---
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;
let reconnectAttempts = 0;
let reconnectTimer = null;
let intentionalClose = false;
let lastCloseCode = 0;

// Session persistence key — scoped to this host so multiple QR connections
// from the same browser don't collide.
const SESSION_STORAGE_KEY = "agentstoz-remote-session-" + location.host;

// The whole point of a resumable session is that a phone paired tonight works in the morning, and
// sessionStorage cannot deliver that: it dies with the tab, and iOS discards backgrounded tabs on
// its own. The Mac restoring the session was useless while the phone had already forgotten its
// half. The token is a bearer credential either way — it lived in web storage before this — and it
// still expires on the host's own idle/absolute deadlines and can be revoked from the Mac.
function saveSession() {
  if (!sessionToken) return;
  try { localStorage.setItem(SESSION_STORAGE_KEY, sessionToken); } catch {}
  // Kept in step so a tab open across the change does not read a stale copy back.
  try { sessionStorage.setItem(SESSION_STORAGE_KEY, sessionToken); } catch {}
}
function loadSavedSession() {
  try {
    const stored = localStorage.getItem(SESSION_STORAGE_KEY);
    if (stored) return stored;
  } catch {}
  // A session paired before this change still lives in the per-tab store; adopt it once.
  try { return sessionStorage.getItem(SESSION_STORAGE_KEY) || ""; } catch { return ""; }
}
function clearSavedSession() {
  terminalForgetSelection();
  try { localStorage.removeItem(SESSION_STORAGE_KEY); } catch {}
  try { sessionStorage.removeItem(SESSION_STORAGE_KEY); } catch {}
}

function reconnectDelay() {
  // Exponential backoff: 1s, 2s, 4s, 8s, 16s, capped at 30s
  return Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectAttempts));
}

function cancelReconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}

function scheduleReconnect() {
  cancelReconnect();
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    setStatus("연결 실패", "offline");
    introMessage.textContent = "여러 번 재연결을 시도했지만 Mac에 연결할 수 없습니다. QR을 다시 스캔하세요.";
    intro.hidden = false;
    clearSavedSession();
    return;
  }
  const delay = reconnectDelay();
  const seconds = Math.ceil(delay / 1000);
  setStatus("재연결 중 (" + (reconnectAttempts + 1) + "/" + MAX_RECONNECT_ATTEMPTS + ")", "waiting");
  notify(seconds + "초 후 재연결을 시도합니다.");
  reconnectTimer = setTimeout(() => {
    reconnectAttempts += 1;
    attemptReconnect();
  }, delay);
}

function closeReasonMessage(code) {
  // WebSocket close codes: https://developer.mozilla.org/en-US/docs/Web/API/CloseEvent/code
  if (code === 1000) return "정상 종료";
  if (code === 1001) return "Mac에서 원격 제어를 껐습니다.";
  if (code === 1006) return "네트워크 연결이 끊어졌습니다.";
  if (code === 1008) return "세션이 만료되었습니다.";
  if (code === 1011) return "서버 오류가 발생했습니다.";
  return "연결이 끊어졌습니다 (코드 " + code + ")";
}

// ⚠️ Keep in step with src/RemoteControlProjectCard.tsx (the Internet
// controller). When the Git and worktree actions were added, only the portal
// card learned them, so on the same-Wi-Fi QR page Merge/Commit/Pull/Push and
// both worktree buttons silently did not exist — the host offered them and the
// page simply never rendered a button. A label missing here removes the
// feature from this surface with no error anywhere.
const ACTION_LABELS = {
  start: "실행", stop: "중지", restart: "재실행",
  "folder.open": "Finder", "localhost.open": "브라우저", "orca.open": "Orca 탭",
  "agent.claude": "Orca · Claude", "agent.codex": "Orca · Codex", "agent.agy": "Orca · AGY", "agent.hermes": "Orca · Hermes",
  "app.codex": "최근 Codex 대화 다시 열기", "app.hermes": "최근 Hermes 대화 열기 요청",
  "claude.thread.start": "Claude Code 원격 대화",
  "codex.thread.start": "Mac의 Codex 앱에서 열기",
  "git.commit": "Commit", "git.pull": "Pull", "git.push": "Push",
  "git.merge": "기본 브랜치에 Merge",
  "worktree.add": "+ 표준 Git 워크트리", "worktree.add.orca": "+ Orca 등록 워크트리",
};

const ACTION_GROUPS = [
  { heading: "프로세스", className: "process", actions: ["start", "stop", "restart"] },
  {
    heading: "새 대화",
    className: "first",
    help: "처음 연결이면 프로젝트 연결용 대화를 준비하고 Mac의 Codex 앱에 열기를 요청합니다. 실제 작업은 Mac에서 이어서 진행하세요.",
    actions: ["codex.thread.start"],
  },
  {
    heading: "최근 대화 다시 열기",
    className: "reopen",
    help: "정확히 연결된 최근 대화만 요청합니다. Hermes는 Desktop 실행과 딥링크 전달까지만 확인하며, 실제 대화 선택은 Mac의 앱에서 확인해야 합니다.",
    actions: ["app.codex", "app.hermes"],
  },
  { heading: "폴더 · localhost", className: "utility", actions: ["folder.open", "localhost.open", "orca.open"] },
  {
    heading: "Orca에서 열기",
    className: "orca",
    help: "최초 로그인·약관 동의·폴더 신뢰 확인은 Mac의 Orca 화면에서 사용자가 한 번 직접 완료해야 합니다.",
    actions: ["agent.claude", "agent.codex", "agent.agy", "agent.hermes"],
  },
  {
    heading: "Git · 워크트리",
    className: "git",
    help: "두 생성 버튼은 같은 Git 방식을 쓰지만, Orca 등록만 사이드바 카드도 추가합니다. 한 종류만 선택하세요.",
    actions: ["git.commit", "git.pull", "git.push", "git.merge", "worktree.add", "worktree.add.orca"],
  },
];

// Actions for which the host requires a one-line input value.
const ACTION_PROMPTS = {
  "git.commit": "커밋 메시지를 입력하세요. 변경 파일 전체가 로컬 앱과 같은 제외 규칙으로 커밋됩니다.",
  "worktree.add": "새 표준 Git 워크트리의 브랜치 이름을 입력하세요.",
  "worktree.add.orca": "새 Orca 등록 워크트리의 브랜치 이름을 입력하세요.",
};

const ACTION_CONFIRM_NOTES = {
  "app.codex": "\\n\\n이 프로젝트에 정확히 연결된 가장 최근 Codex 대화만 엽니다. 기록이 없으면 실패합니다.",
  "app.hermes": "\\n\\n이 프로젝트에 정확히 연결된 가장 최근 Hermes 대화 열기를 요청합니다. Desktop 실행은 확인하지만 실제 대화 선택은 Mac의 앱에서 확인해야 합니다.",
  "agent.claude": "\\n\\n최초 동의·로그인 화면은 Mac의 Orca에서 직접 확인해야 합니다.",
  "agent.codex": "\\n\\n최초 동의·로그인 화면은 Mac의 Orca에서 직접 확인해야 합니다.",
  "agent.agy": "\\n\\n최초 동의·로그인 화면은 Mac의 Orca에서 직접 확인해야 합니다.",
  "agent.hermes": "\\n\\n최초 동의·로그인 화면은 Mac의 Orca에서 직접 확인해야 합니다.",
};

function setStatus(text, style) {
  connection.textContent = text;
  connection.className = "status " + style;
}

function notify(message) {
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2600);
}

function nextActionId() {
  actionSequence += 1;
  return "a-" + Date.now().toString(36) + "-" + actionSequence.toString(36);
}

function setBusy(value) {
  inFlight = value;
  // A request the Mac never answers used to leave every button disabled for good while the
  // pill still read "연결됨" — the phone looked connected and was inert. Release the lock and
  // say the outcome is unknown, which is honest: the action may still have run.
  if (inFlightTimer) { clearTimeout(inFlightTimer); inFlightTimer = null; }
  if (value) {
    inFlightTimer = setTimeout(function () {
      inFlightTimer = null;
      if (!inFlight) return;
      const stalled = lastActionName || "요청";
      setBusy(false);
      recordError(stalled, { code: "ACTION_NO_RESPONSE", message: "Mac이 " + Math.round(ACTION_RESPONSE_TIMEOUT_MS / 1000) + "초 안에 응답하지 않았습니다. 요청이 전달되어 실행 중일 수 있으니, 상태를 새로고침해 확인한 뒤 다시 누르세요." });
    }, ACTION_RESPONSE_TIMEOUT_MS);
  }
  for (const button of document.querySelectorAll("button[data-action]")) {
    button.disabled = value || button.dataset.available !== "true";
  }
  refreshButton.disabled = value;
}

function statusLabel(project) {
  if (project.status === "running") return project.port ? "실행 중 · 포트 " + project.port : "실행 중";
  if (project.status === "stopped") return "중지됨";
  return "상태 확인 필요";
}

function actionButton(action, label, project, disabled) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.action = action;
  button.dataset.available = disabled ? "false" : "true";
  button.textContent = label;
  button.disabled = disabled || inFlight;
  button.addEventListener("click", () => sendAction(action, project.controlId, true));
  return button;
}

function appendActionGroup(card, project, group) {
  const available = group.actions.filter(action => project.actions.includes(action));
  if (available.length === 0) return;
  const heading = document.createElement("p");
  heading.className = "action-heading";
  heading.textContent = group.heading;
  card.append(heading);
  const showHelp = group.help
    && (group.className !== "git" || available.some(action => action === "worktree.add" || action === "worktree.add.orca"));
  if (showHelp) {
    const help = document.createElement("p");
    help.className = "action-help";
    help.textContent = group.help;
    card.append(help);
  }
  const actions = document.createElement("div");
  actions.className = "actions actions-" + group.className;
  for (const action of available) {
    actions.append(actionButton(action, ACTION_LABELS[action], project, false));
  }
  card.append(actions);
}

// 데스크톱 검색과 같은 정규화(NFKC). macOS 파일명은 분해형(NFD) 한글이 흔해서
// 이것이 없으면 IME 로 친 완성형 질의가 같은 이름을 찾지 못한다.
function searchKey(value) {
  return String(value == null ? "" : value).normalize("NFKC").toLocaleLowerCase();
}

function matchesFilters(project) {
  const rootMatches = !selectedWorkspaceRoot
    || (selectedWorkspaceRoot === UNASSIGNED_WORKSPACE_ROOT
      ? !project.workspaceRoot
      : project.workspaceRoot === selectedWorkspaceRoot.slice(WORKSPACE_ROOT_FILTER_PREFIX.length));
  if (!rootMatches) return false;
  if (!projectQuery) return true;
  return searchKey(project.name).includes(projectQuery)
    || searchKey(project.alias).includes(projectQuery)
    || searchKey(project.branch).includes(projectQuery);
}

function updateWorkspaceRootOptions() {
  if (!workspaceRootFilter) return;
  const previous = selectedWorkspaceRoot;
  const roots = Array.from(new Set(workspaceRootNames.concat(projects
    .map(project => typeof project.workspaceRoot === "string" ? project.workspaceRoot.trim() : "")
    .filter(Boolean))))
    .sort((left, right) => left.localeCompare(right, "ko-KR", { numeric: true, sensitivity: "base" }));
  workspaceRootFilter.replaceChildren();
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "모든 작업 루트";
  workspaceRootFilter.append(all);
  for (const root of roots) {
    const option = document.createElement("option");
    option.value = WORKSPACE_ROOT_FILTER_PREFIX + root;
    option.textContent = root;
    workspaceRootFilter.append(option);
  }
  if (projects.some(project => !project.workspaceRoot)) {
    const unassigned = document.createElement("option");
    unassigned.value = UNASSIGNED_WORKSPACE_ROOT;
    unassigned.textContent = "작업 루트 없음";
    workspaceRootFilter.append(unassigned);
  }
  const stillAvailable = Array.from(workspaceRootFilter.options).some(option => option.value === previous);
  selectedWorkspaceRoot = stillAvailable ? previous : "";
  workspaceRootFilter.value = selectedWorkspaceRoot;
}

function projectCard(project) {
  const card = document.createElement("article");
  card.className = "project-card";
  const title = document.createElement("h2");
  title.textContent = project.name;
  const status = document.createElement("p");
  status.className = project.status === "running" ? "running" : "stopped";
  status.textContent = statusLabel(project);
  card.append(title);
  if (typeof project.alias === "string" && project.alias) {
    const alias = document.createElement("p");
    alias.className = "alias";
    alias.textContent = "\uBCC4\uBA85 \u00B7 " + project.alias;
    card.append(alias);
  }
  if (typeof project.workspaceRoot === "string" && project.workspaceRoot) {
    const root = document.createElement("p");
    root.className = "workspace-root";
    root.textContent = "작업 루트 · " + project.workspaceRoot;
    card.append(root);
  }
  if (typeof project.branch === "string" && project.branch) {
    const branch = document.createElement("p");
    branch.className = "branch";
    branch.textContent = (project.kind === "worktree" ? "\uC6CC\uD06C\uD2B8\uB9AC \uBE0C\uB79C\uCE58" : "\uBA54\uC778\uD2B8\uB9AC \uBE0C\uB79C\uCE58") + " \u00B7 " + project.branch;
    card.append(branch);
  }
  card.append(status);
  const workroomButton=document.createElement('button');workroomButton.className='workroom-open';workroomButton.textContent='워크룸에서 작업';
  workroomButton.onclick=()=>{terminalReady(projects);document.querySelector('#terminal-project').value=project.controlId;document.querySelector('#terminal-project').dispatchEvent(new Event('change'));showWorkspaceTab('workroom');};card.append(workroomButton);
  for (const group of ACTION_GROUPS) appendActionGroup(card, project, group);
  return card;
}

// 호스트가 워크트리 카드를 부모 바로 뒤에 놓아 보내므로, 연속한 워크트리 구간을
// 부모 밑으로 묶는다. 규칙 정본은 src/remoteControlWorktreeGrouping.ts 이고
// 인터넷 포털(RemoteControlProjectCard.tsx)도 같은 규칙을 쓴다 — 한쪽에만 넣으면
// 그 화면에서는 워크트리 보기가 조용히 없는 것이 된다.
function worktreeGroup(parent, cards) {
  const group = document.createElement("section");
  group.className = "worktree-group";
  const heading = document.createElement("p");
  heading.className = "worktree-group-title";
  heading.textContent = (parent ? parent.name + " \u00B7 " : "")
    + "\uC6CC\uD06C\uD2B8\uB9AC " + cards.length + "\uAC1C";
  group.append(heading);
  for (const card of cards) group.append(projectCard(card));
  return group;
}

function renderProjects() {
  terminalReady(projects);
  projectsNode.replaceChildren();
  updateWorkspaceRootOptions();
  const visible = projects.filter(matchesFilters);
  let index = 0;
  while (index < visible.length) {
    const project = visible[index];
    if (project.kind !== "worktree") {
      projectsNode.append(projectCard(project));
      index += 1;
      const run = [];
      while (index < visible.length && visible[index].kind === "worktree") { run.push(visible[index]); index += 1; }
      if (run.length > 0) projectsNode.append(worktreeGroup(project, run));
      continue;
    }
    // 부모가 검색에 걸러졌거나 목록 맨 앞인 워크트리 — 버리지 않는다.
    const orphans = [];
    while (index < visible.length && visible[index].kind === "worktree") { orphans.push(visible[index]); index += 1; }
    projectsNode.append(worktreeGroup(null, orphans));
  }
  if (projectCount) {
    const filtering = Boolean(projectQuery || selectedWorkspaceRoot);
    projectCount.textContent = totalProjectCount === 0 ? ""
      : filtering ? visible.length + " / " + totalProjectCount + "\uAC1C"
      : projects.length + " / " + totalProjectCount + "\uAC1C";
  }
  if (visible.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = nextProjectPage !== null
      ? "전체 프로젝트 목록을 불러오는 중입니다."
      : projects.length === 0
      ? "원격 제어 가능한 등록 프로젝트가 없습니다."
      : "검색·필터 결과가 없습니다.";
    projectsNode.append(empty);
  }
}

function updateProject(project) {
  if (!project) return;
  const index = projects.findIndex((candidate) => candidate.controlId === project.controlId);
  if (index >= 0) projects[index] = project;
  else projects.push(project);
  renderProjects();
}

function projectCreateDraftChanged(){
  if(!currentProjectCreateIntent)return;
  try{projectIntentStore().discardChangedIntent(currentProjectCreateIntent);currentProjectCreateIntent=null;}catch(error){recordError('생성 요청 변경',error);}
}
document.querySelector('#create-name').addEventListener('input',projectCreateDraftChanged);
document.querySelector('#create-root').addEventListener('change',projectCreateDraftChanged);
document.querySelector('#create-project').onclick=()=>{
  if(!socket||socket.readyState!==WebSocket.OPEN||!sessionToken||inFlight)return;
  const input=document.querySelector('#create-name').value.trim(),workspaceRootId=document.querySelector('#create-root').value;
  if(!input||input.length>120||!workspaceRoots.some(root=>root.controlId===workspaceRootId)){notify('프로젝트 이름과 작업 루트를 선택하세요.');return;}
  try {
    // The opaque root control is HMAC-bound to this host pairing; no bearer is written to intent storage.
    currentProjectCreateIntent=projectIntentStore().reserve({hostId:location.host,controllerId:workspaceRootId,workspaceRootId,projectName:input});
    lastActionCode='project.create';lastActionName='프로젝트 생성';setBusy(true);
    socket.send(JSON.stringify({type:'action.request',protocolVersion:PROTOCOL_VERSION,sessionToken,actionId:currentProjectCreateIntent.actionId,action:'project.create',input,workspaceRootId,remoteConfirmed:true}));
  } catch(error) {setBusy(false);recordError('프로젝트 생성',error);notify(error.message);}
};
function sendAction(action, controlId, remoteConfirmed, page) {
  if (!socket || socket.readyState !== WebSocket.OPEN || !sessionToken || inFlight) return;
  if (remoteConfirmed && !confirm(hostName.textContent + "\\n‘" + projectName(controlId) + "’\\n\\n" + ACTION_LABELS[action] + " 기능을 실행할까요?" + (ACTION_CONFIRM_NOTES[action] || ""))) return;
  let input;
  if (ACTION_PROMPTS[action]) {
    const answer = prompt(projectName(controlId) + "\\n" + ACTION_PROMPTS[action]);
    if (answer === null) return;
    input = answer.trim();
    // The host rejects anything outside 1~120 characters with a bare error;
    // catching it here keeps a length slip from costing a round trip.
    if (!input || input.length > 120) {
      notify("한 줄 1~120자로 입력하세요.");
      return;
    }
  }
  const message = {
    type: "action.request",
    protocolVersion: PROTOCOL_VERSION,
    sessionToken,
    actionId: nextActionId(),
    action,
  };
  if (controlId) message.controlId = controlId;
  if (remoteConfirmed) message.remoteConfirmed = true;
  if (input !== undefined) message.input = input;
  if (action === "projects.list" && Number.isInteger(page)) message.page = page;
  lastActionName = ACTION_LABELS[action] || action;
  lastActionCode = action;
  lastRequestedPage = action === "projects.list" && Number.isInteger(page) ? page : null;
  setBusy(true);
  socket.send(JSON.stringify(message));
}

function handleActionResult(message) {
  setBusy(false);
  const context = lastActionName || "요청";
  if (message.ok) {
    if (Array.isArray(message.workspaceRoots)) {
      workspaceRoots=message.workspaceRoots;
      const createRoot=document.querySelector('#create-root'),previousRoot=createRoot.value;createRoot.replaceChildren();
      for(const root of workspaceRoots)createRoot.add(new Option(root.name,root.controlId));
      if(workspaceRoots.some(root=>root.controlId===previousRoot))createRoot.value=previousRoot;
      document.querySelector('#project-create').hidden=workspaceRoots.length===0;
      workspaceRootNames = message.workspaceRoots
        .map(root => typeof root.name === "string" ? root.name.trim() : "")
        .filter(Boolean);
      workspaceRootsRequested = true;
      renderProjects();
      return;
    }
    if (Array.isArray(message.projects)) {
      const knownBefore = new Set(projects.map(project => project.controlId));
      projects = message.page === 0
        ? message.projects
        : projects.concat(message.projects.filter(project => !projects.some(current => current.controlId === project.controlId)));
      nextProjectPage = Number.isInteger(message.nextPage) ? message.nextPage : null;
      totalProjectCount = Number.isInteger(message.projectCount) ? message.projectCount : projects.length;
      renderProjects();
      // A created worktree arrives inside a project page, so without naming it
      // the only feedback was a generic success toast and the user could not
      // tell the new card from the rest of the list.
      const created = message.projects.filter(project => !knownBefore.has(project.controlId));
      if (created.length > 0 && (context.indexOf("워크트리") >= 0)) {
        notify("워크트리 생성됨 · " + created[0].name);
      } else {
        notify(context + " 완료");
      }
      if (nextProjectPage !== null) {
        setTimeout(() => sendAction("projects.list", "", false, nextProjectPage), 0);
      } else if (!workspaceRootsRequested) {
        workspaceRootsRequested = true;
        setTimeout(() => sendAction("workspace-roots.list", "", false), 0);
      }
      return;
    }
    updateProject(message.project);
    if(lastActionCode==='project.create'&&message.project){
      if(currentProjectCreateIntent&&message.actionId===currentProjectCreateIntent.actionId){
        try{projectIntentStore().complete(currentProjectCreateIntent,message.actionId);currentProjectCreateIntent=null;}catch(error){recordError('생성 결과 저장',error);}
      }
      terminalReady(projects);document.querySelector('#terminal-project').value=message.project.controlId;document.querySelector('#terminal-project').dispatchEvent(new Event('change'));showWorkspaceTab('workroom');
    }
    notify(lastActionCode === "app.hermes"
      ? "최근 Hermes 대화 열기 요청을 Mac에 전달했습니다. 실제 대화 선택은 Mac의 Hermes Desktop에서 확인하세요."
      : context + " 완료");
    return;
  }
  // Keep the failure on screen; the toast alone vanished before it was useful.
  recordError(context, message.error);
  notify((message.error && message.error.message) || "요청을 처리하지 못했습니다.");
  // The page walk is not something the user asked for — the host hands out nextPage and the page
  // follows it. Dropping the chain on a refusal leaves a silently short list that reads as
  // "those projects are gone", so a rate refusal waits out the window and resumes instead.
  if (message.error && message.error.code === "RATE_LIMITED"
    && (lastActionCode === "projects.list" || lastActionCode === "workspace-roots.list")) {
    scheduleEnumerationRetry(lastActionCode, lastRequestedPage, RATE_LIMIT_RETRY_MS);
  }
}

/**
 * Resume an enumeration the host refused for rate reasons.
 *
 * Three things this has to get right, each of which was wrong when it was a bare setTimeout:
 *  - retry the page that was actually refused, not wherever the cursor happens to point (a refused
 *    page-zero refresh would otherwise resume the old cursor, or send nothing at all);
 *  - stay pending while another action holds the lock, instead of giving up and leaving a list the
 *    page has already promised to complete;
 *  - belong to one enumeration, so a timer from an abandoned walk cannot wake up after a refresh
 *    or a reconnect and append obsolete cards to the current list.
 */
function cancelEnumerationRetry() {
  if (enumerationRetryTimer) clearTimeout(enumerationRetryTimer);
  enumerationRetryTimer = null;
}

function scheduleEnumerationRetry(resume, page, delay) {
  cancelEnumerationRetry();
  const generation = enumerationGeneration;
  enumerationRetryTimer = setTimeout(() => {
    enumerationRetryTimer = null;
    if (generation !== enumerationGeneration) return;
    if (!socket || socket.readyState !== WebSocket.OPEN || !sessionToken) return;
    // The lock is someone else's action, not a reason to abandon the list.
    if (inFlight) { scheduleEnumerationRetry(resume, page, RATE_LIMIT_BUSY_RECHECK_MS); return; }
    if (resume === "workspace-roots.list") {
      workspaceRootsRequested = true;
      sendAction("workspace-roots.list", "", false);
    } else if (Number.isInteger(page)) {
      sendAction("projects.list", "", false, page);
    }
  }, delay);
}

function projectName(controlId) {
  return projects.find(project => project.controlId === controlId)?.name || "등록 프로젝트";
}

function connect() {
  if (!pairToken) {
    // No QR token — try restoring a saved session
    const saved = loadSavedSession();
    if (saved) {
      setStatus("세션 복원 중", "waiting");
      attemptReconnect();
      return;
    }
    setStatus("QR 필요", "offline");
    introMessage.textContent = "Mac의 AgentsToZ 앱에서 새 QR을 만든 뒤 다시 스캔하세요.";
    return;
  }
  intentionalClose = false;
  const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(wsProtocol + "//" + location.host + "/remote/ws");
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({
      type: "controller.pair",
      protocolVersion: PROTOCOL_VERSION,
      token: pairToken,
    }));
    pairToken = "";
  });
  socket.addEventListener("message", (event) => {
    let message;
    try { message = JSON.parse(String(event.data)); }
    catch { setStatus("응답 오류", "offline"); socket.close(); return; }
    if(message.type === "terminal.result"){terminalReply(message);return;}
    if (message.type === "error" && message.code === "PROTOCOL_MISMATCH") {
      setStatus("버전 불일치", "offline");
      introMessage.textContent = "Mac의 AgentsToZ 앱을 업데이트한 뒤 QR을 다시 스캔하세요.";
      intro.hidden = false;
      intentionalClose = true;
      clearSavedSession();
      socket.close();
      return;
    }
    if (message.type === "session.ready" || message.type === "session.restored") {
      sessionToken = message.sessionToken;
      terminalReady(message.projects||[]);
      projects = Array.isArray(message.projects) ? message.projects : [];
      nextProjectPage = Number.isInteger(message.nextPage) ? message.nextPage : null;
      totalProjectCount = Number.isInteger(message.projectCount) ? message.projectCount : projects.length;
      hostName.textContent = message.hostName || "AgentsToZ 원격 제어";
      // Sessions last 30 days, so the label must carry a date. Printing only a
      // clock time made a connection valid for a month read as "expires today".
      sessionExpiry.textContent = message.expiresAt
        ? "최대 " + new Date(message.expiresAt).toLocaleString(undefined, {
            year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
          }) + "까지"
        : "";
      intro.hidden = true;
      toolbar.hidden = false;
      if (filterBar) filterBar.hidden = false;
      setStatus("연결됨", "online");
      reconnectAttempts = 0;
      cancelReconnect();
      saveSession();
      renderProjects();
      void terminalList();
      if (nextProjectPage !== null) {
        setTimeout(() => sendAction("projects.list", "", false, nextProjectPage), 0);
      } else if (!workspaceRootsRequested) {
        workspaceRootsRequested = true;
        setTimeout(() => sendAction("workspace-roots.list", "", false), 0);
      }
      return;
    }
    if (message.type === "action.result") {
      handleActionResult(message);
      return;
    }
    if (message.type === "session.closed" || message.type === "error") {
      terminalDisconnected();
      sessionToken = "";
      setBusy(false);
      setStatus("연결 종료", "offline");
      clearSavedSession();
      notify(message.reason || message.message || "연결이 종료되었습니다.");
      intentionalClose = true;
    }
  });
  socket.addEventListener("close", (event) => {
    terminalDisconnected();
    // A closed socket cannot be resumed on; the reconnect runs its own enumeration.
    cancelEnumerationRetry();
    lastCloseCode = event.code;
    setBusy(false);
    if (intentionalClose || event.code === 1000 || event.code === 1001 || event.code === 1008) {
      // Intentional close or explicit session end — don't reconnect
      sessionToken = "";
      setStatus("연결 종료", "offline");
      clearSavedSession();
      notify(closeReasonMessage(event.code));
      return;
    }
    // Unexpected close — attempt reconnection if we had a session
    if (sessionToken || loadSavedSession()) {
      notify(closeReasonMessage(event.code));
      scheduleReconnect();
    } else {
      sessionToken = "";
      setStatus("연결 종료", "offline");
    }
  });
  socket.addEventListener("error", () => setStatus("연결 오류", "offline"));
}

function attemptReconnect() {
  const saved = loadSavedSession();
  if (!saved) {
    setStatus("QR 필요", "offline");
    introMessage.textContent = "저장된 세션이 없습니다. Mac의 AgentsToZ 앱에서 QR을 스캔하세요.";
    intro.hidden = false;
    return;
  }
  intentionalClose = false;
  const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(wsProtocol + "//" + location.host + "/remote/ws");
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({
      type: "session.restore",
      protocolVersion: PROTOCOL_VERSION,
      sessionToken: saved,
    }));
  });
  socket.addEventListener("message", (event) => {
    let message;
    try { message = JSON.parse(String(event.data)); }
    catch { setStatus("응답 오류", "offline"); socket.close(); return; }
    if(message.type === "terminal.result"){terminalReply(message);return;}
    if (message.type === "error" && message.code === "PROTOCOL_MISMATCH") {
      setStatus("버전 불일치", "offline");
      introMessage.textContent = "Mac의 AgentsToZ 앱을 업데이트한 뒤 QR을 다시 스캔하세요.";
      intro.hidden = false;
      intentionalClose = true;
      clearSavedSession();
      socket.close();
      return;
    }
    if (message.type === "error" && (message.code === "SESSION_EXPIRED" || message.code === "SESSION_INVALID")) {
      setStatus("세션 만료", "offline");
      introMessage.textContent = "이전 세션이 만료되었습니다. Mac의 AgentsToZ 앱에서 QR을 다시 스캔하세요.";
      intro.hidden = false;
      intentionalClose = true;
      clearSavedSession();
      return;
    }
    if (message.type === "session.restored") {
      sessionToken = message.sessionToken;
      terminalReady(message.projects||[]);
      projects = Array.isArray(message.projects) ? message.projects : [];
      nextProjectPage = Number.isInteger(message.nextPage) ? message.nextPage : null;
      totalProjectCount = Number.isInteger(message.projectCount) ? message.projectCount : projects.length;
      hostName.textContent = message.hostName || "AgentsToZ 원격 제어";
      sessionExpiry.textContent = message.expiresAt
        ? "최대 " + new Date(message.expiresAt).toLocaleString(undefined, {
            year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
          }) + "까지"
        : "";
      intro.hidden = true;
      toolbar.hidden = false;
      if (filterBar) filterBar.hidden = false;
      setStatus("연결됨", "online");
      reconnectAttempts = 0;
      cancelReconnect();
      saveSession();
      notify("연결이 복원되었습니다.");
      renderProjects();
      if (nextProjectPage !== null) {
        setTimeout(() => sendAction("projects.list", "", false, nextProjectPage), 0);
      } else if (!workspaceRootsRequested) {
        workspaceRootsRequested = true;
        setTimeout(() => sendAction("workspace-roots.list", "", false), 0);
      }
      return;
    }
    if (message.type === "action.result") {
      handleActionResult(message);
      return;
    }
    if (message.type === "session.closed" || message.type === "error") {
      terminalDisconnected();
      sessionToken = "";
      setBusy(false);
      setStatus("연결 종료", "offline");
      clearSavedSession();
      notify(message.reason || message.message || "연결이 종료되었습니다.");
      intentionalClose = true;
    }
  });
  socket.addEventListener("close", (event) => {
    terminalDisconnected();
    // A closed socket cannot be resumed on; the reconnect runs its own enumeration.
    cancelEnumerationRetry();
    lastCloseCode = event.code;
    setBusy(false);
    if (intentionalClose || event.code === 1000 || event.code === 1001 || event.code === 1008) {
      sessionToken = "";
      setStatus("연결 종료", "offline");
      clearSavedSession();
      return;
    }
    // Unexpected close — schedule another reconnect attempt
    scheduleReconnect();
  });
  socket.addEventListener("error", () => {
    setStatus("연결 오류", "offline");
  });
}

refreshButton.addEventListener("click", () => sendAction("projects.list", "", false, 0));
if (errorClear) errorClear.addEventListener("click", clearErrors);
if (searchInput) {
  // 이 페이지는 모든 페이지를 자동으로 이어 받으므로 검색은 항상 전체 목록 위에서 돈다.
  searchInput.addEventListener("input", () => {
    projectQuery = searchKey(searchInput.value.trim());
    renderProjects();
  });
}
if (workspaceRootFilter) {
  workspaceRootFilter.addEventListener("change", () => {
    selectedWorkspaceRoot = workspaceRootFilter.value;
    renderProjects();
  });
}
connect();
`;

export const REMOTE_CONTROL_MOBILE_CSS = (appearanceTokens as unknown as string).replace(/@import[^;]+;/g, '') + `
[hidden]{display:none!important;}
.workspace-tabs{display:flex;gap:6px;margin-bottom:18px;padding:5px;border:1px solid var(--border);border-radius:14px;background:var(--panel);}
.workspace-tabs button{flex:1;min-height:44px;background:transparent;color:inherit;border:0;border-radius:10px;font:inherit;}
.workspace-tabs button[aria-pressed="true"]{background:var(--mint);color:var(--on-accent);font-weight:750;}
body[data-workspace-tab="projects"] #terminal-panel,body[data-workspace-tab="workroom"] #projects,body[data-workspace-tab="workroom"] #filter,body[data-workspace-tab="workroom"] #project-create{display:none;}
.workroom-open{width:100%;min-height:44px;background:var(--mint);color:var(--on-accent);border:0;border-radius:12px;font:inherit;font-weight:750;}
button:focus-visible{outline:3px solid var(--mint);outline-offset:3px;}
/* iOS focuses the remember draft. Keep editable controls at 16px so focus does
   not zoom/crop the Workroom; do not disable the user's pinch zoom. */
#terminal-panel{min-width:0;padding:16px;border-radius:20px;margin-top:16px;overflow-wrap:anywhere;}
#terminal-panel button,#terminal-panel select,#terminal-panel input{margin:4px 0;max-width:100%;min-height:44px;font-size:16px;}
#terminal-panel select,#terminal-panel input{width:100%;padding:10px;border:1px solid var(--line-2);border-radius:10px;background:var(--bg-input);color:var(--ink);}
#terminal-panel .terminal-screen{height:400px;background:#111315;overflow:hidden;border-radius:8px;}#terminal-panel #terminal-error{color:var(--danger);font-size:12px;}
:root {color-scheme:light;font-family:var(--font-sans);background:var(--bg);color:var(--ink);--mint:var(--accent);--panel:var(--surface);--border:var(--line-2);}
* { box-sizing: border-box; }
body { margin:0;min-height:100dvh;background:var(--bg); }
main { width: min(760px, 100%); margin: 0 auto; padding: max(24px, env(safe-area-inset-top)) 18px calc(44px + env(safe-area-inset-bottom)); }
header { display: grid; grid-template-columns: auto 1fr auto; gap: 12px; align-items: center; margin-bottom: 24px; }
.brand-mark { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 14px; background: var(--mint); color: var(--on-accent); font-weight: 900; }
.eyebrow { margin: 0 0 3px; color: var(--ink-3); font-size: 10px; font-weight: 800; letter-spacing: .16em; }
h1 { margin: 0; font-size: 18px; }
.status { padding: 7px 10px; border-radius: 99px; font-size: 11px; font-weight: 800; }
.status.waiting { background: var(--warn-soft); color: var(--warn); }
.status.online { background: var(--ok-soft); color: var(--ok); }
.status.offline { background: var(--danger-soft); color: var(--danger); }
.panel, .project-card { border: 1px solid var(--border); background: var(--panel); box-shadow:var(--shadow); }
.intro { padding: 22px; border-radius: 22px; }
.intro h2 { margin: 0 0 8px; font-size: 20px; line-height: 1.35; }
.intro p { margin: 0; color: var(--ink-2); line-height: 1.55; }
.toolbar { align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.toolbar:not([hidden]) { display: flex; }
.toolbar span { color: var(--ink-3); font-size: 11px; }
.project-list { display: grid; gap: 13px; }
.project-card { border-radius: 20px; padding: 18px; }
.project-card h2 { margin: 0; font-size: 17px; overflow-wrap: anywhere; }
.project-card p { margin: 7px 0 16px; font-size: 13px; font-weight: 750; }
.project-card p.alias { margin: 4px 0 0; font-size: 11px; font-weight: 700; color: var(--violet); overflow-wrap: anywhere; }
.project-card p.branch { margin: 3px 0 0; font-size: 11px; font-weight: 700; color: var(--accent); overflow-wrap: anywhere; }
.filter { gap: 7px; margin-bottom: 14px; }
.filter:not([hidden]) { display: grid; }
.filter label { color: var(--ink-3); font-size: 10px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
.filter input, .filter select { min-height: 44px; padding: 0 14px; border: 1px solid var(--line-2); border-radius: 14px; background: var(--bg-input); color: var(--ink); font-size: 16px; }
.filter input:focus, .filter select:focus { outline: 2px solid var(--mint); outline-offset: 1px; }
.filter span { color: var(--ink-3); font-size: 11px; font-weight: 700; }
.errors { margin-bottom: 14px; border: 1px solid var(--line-2); border-radius: 16px; background: var(--danger-soft); padding: 12px 14px; }
.errors-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.errors h2 { margin: 0; color: var(--danger); font-size: 11px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; }
.errors ol { margin: 10px 0 0; padding: 0; list-style: none; display: grid; gap: 10px; }
.errors li { border-top: 1px solid var(--line-2); padding-top: 9px; }
.errors li:first-child { border-top: 0; padding-top: 0; }
.error-head { margin: 0; color: var(--danger); font-size: 11px; font-weight: 700; }
.error-message { margin: 3px 0 0; color: var(--danger); font-size: 14px; font-weight: 650; line-height: 1.45; }
.error-code { margin: 4px 0 0; color: var(--danger); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
.error-paths { margin: 6px 0 0; padding-left: 16px; color: var(--danger); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.6; word-break: break-all; }
.error-hint { margin: 6px 0 0; color: var(--accent); font-size: 13px; font-weight: 650; line-height: 1.45; }
/* 워크트리 묶음 — 어느 프로젝트의 워크트리인지 화면에서 읽히게 한다.
   규칙 정본은 src/remoteControlWorktreeGrouping.ts 이고 인터넷 포털도 같은 모양을 쓴다. */
.worktree-group { display: grid; gap: 12px; padding: 12px; border: 1px dashed rgb(var(--accent-rgb) / .22); border-radius: 22px; background: rgb(var(--accent-rgb) / .035); }
.worktree-group-title { margin: 0; color: var(--accent); font-size: 11px; font-weight: 800; overflow-wrap: anywhere; }
.project-card p.running { color: var(--ok); }
.project-card p.stopped { color: var(--ink-2); }
.project-card p.workspace-root { margin: 3px 0 0; color: var(--accent); font-size: 11px; font-weight: 700; overflow-wrap: anywhere; }
.project-card p.action-heading { margin: 14px 0 7px; color: var(--ink-3); font-size: 10px; font-weight: 850; letter-spacing: .04em; }
.project-card p.action-help { margin: -1px 0 8px; color: var(--ink-3); font-size: 11px; font-weight: 500; line-height: 1.55; }
.actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.actions-process { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.actions-first, .actions-reopen { grid-template-columns: minmax(0, 1fr); }
.actions-utility button, .actions-orca button { border: 1px solid var(--line-2); background: var(--bg-input); color: var(--ink); }
.actions-first button { border: 1px solid rgb(var(--accent-rgb) / .34); background: rgb(var(--accent-rgb) / .13); color: var(--accent); }
.actions-reopen button { border: 1px solid rgb(var(--violet-rgb) / .3); background: rgb(var(--violet-rgb) / .1); color: var(--violet); }
.actions-git button { border: 1px solid rgb(var(--accent-rgb) / .24); background: rgb(var(--accent-rgb) / .08); color: var(--accent); }
button { min-height: 44px; border: 0; border-radius: 12px; background: var(--mint); color: var(--on-accent); font-weight: 850; font-size: 13px; cursor: pointer; }
button.secondary { padding: 0 14px; border: 1px solid var(--line-2); background: var(--bg-input); color: var(--ink-2); }
button:disabled { opacity: .38; cursor: not-allowed; }
.empty { padding: 24px; border: 1px dashed var(--line-2); border-radius: 18px; color: var(--ink-2); text-align: center; }
#toast { position: fixed; left: 50%; bottom: calc(22px + env(safe-area-inset-bottom)); transform: translateX(-50%) translateY(24px); width: min(88vw, 420px); border-radius: 14px; background: var(--surface); color: var(--ink); padding: 13px 16px; font-weight: 750; opacity: 0; pointer-events: none; transition: .2s ease; }
#toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
@media (min-width: 620px) { main { padding-inline: 24px; } .project-list { grid-template-columns: repeat(2, minmax(0, 1fr)); } .worktree-group { grid-column: 1 / -1; grid-template-columns: repeat(2, minmax(0, 1fr)); } .worktree-group-title { grid-column: 1 / -1; } }
#project-create{padding:18px;margin-bottom:16px;}
#project-create label{display:block;margin:10px 0 5px;color:var(--ink-2);font-size:13px;}
#project-create input,#project-create select{width:100%;min-height:44px;padding:10px;font:inherit;font-size:16px;color:var(--ink);background:var(--bg-input);border:1px solid var(--line-2);border-radius:10px;}
#project-create button{width:100%;margin-top:12px;}#project-create p{color:var(--ink-2);font-size:13px;line-height:1.6;}
`;

export const REMOTE_CONTROL_MOBILE_MANIFEST = JSON.stringify({
  name: 'AgentsToZ 원격 제어',
  short_name: 'AgentsToZ',
  description: '같은 신뢰 가능한 네트워크에서 AgentsToZ의 등록 프로젝트를 제어합니다.',
  start_url: '/remote/',
  scope: '/remote/',
  display: 'standalone',
  background_color: '#07111f',
  theme_color: '#07111f',
  icons: [{ src: '/remote/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
});

export const REMOTE_CONTROL_MOBILE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="112" fill="#07111f"/>
  <path d="M147 120h218a42 42 0 0 1 42 42v142a42 42 0 0 1-42 42H147a42 42 0 0 1-42-42V162a42 42 0 0 1 42-42Z" fill="#5eead4"/>
  <path d="M198 392h116M256 346v46" stroke="#5eead4" stroke-width="28" stroke-linecap="round"/>
  <circle cx="182" cy="233" r="27" fill="#07111f"/>
  <path d="M302 211v44m-22-22h44" stroke="#07111f" stroke-width="20" stroke-linecap="round"/>
</svg>`;

export type RemoteControlMobileAsset = {
  body: string;
  contentType: string;
};

const REMOTE_CONTROL_ASSETS: Readonly<Record<string, RemoteControlMobileAsset>> = Object.freeze({
  '/remote/': { body: REMOTE_CONTROL_MOBILE_HTML, contentType: 'text/html; charset=utf-8' },
  '/remote/index.html': { body: REMOTE_CONTROL_MOBILE_HTML, contentType: 'text/html; charset=utf-8' },
  '/remote/xterm.js': {body:LAN_XTERM_JS,contentType:'text/javascript; charset=utf-8'},
  '/remote/xterm.css': {body:LAN_XTERM_CSS,contentType:'text/css; charset=utf-8'},
  '/remote/app.js': { body: REMOTE_CONTROL_MOBILE_JS, contentType: 'text/javascript; charset=utf-8' },
  '/remote/styles.css': { body: REMOTE_CONTROL_MOBILE_CSS, contentType: 'text/css; charset=utf-8' },
  '/remote/manifest.webmanifest': { body: REMOTE_CONTROL_MOBILE_MANIFEST, contentType: 'application/manifest+json; charset=utf-8' },
  '/remote/icon.svg': { body: REMOTE_CONTROL_MOBILE_ICON, contentType: 'image/svg+xml; charset=utf-8' },
});

export function remoteControlMobileAsset(pathname: string): RemoteControlMobileAsset | null {
  return REMOTE_CONTROL_ASSETS[pathname] ?? null;
}

export function remoteControlSecurityHeaders(origin: string, contentType = 'application/json; charset=utf-8'): Headers {
  const parsed = new URL(origin);
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('origin must be an exact http(s) origin');
  }
  const websocketOrigin = `${parsed.protocol === 'https:' ? 'wss:' : 'ws:'}//${parsed.host}`;
  const headers = new Headers({
    'Content-Type': contentType,
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache',
    Expires: '0',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Content-Security-Policy': [
      "default-src 'none'",
      "script-src 'self'",
      // xterm generates its font/row/theme stylesheet. Script policy remains self-only.
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self'",
      "manifest-src 'self'",
      `connect-src 'self' ${websocketOrigin}`,
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
      "object-src 'none'",
    ].join('; '),
  });
  return headers;
}
