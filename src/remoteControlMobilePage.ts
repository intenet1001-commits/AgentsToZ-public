import {LAN_XTERM_JS,LAN_XTERM_CSS} from './lanTerminalAssets';
import { REMOTE_CONTROL_PROTOCOL_VERSION } from './remoteControlCore';

export const REMOTE_CONTROL_MOBILE_HTML = `<!doctype html>
<html lang="ko">
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
      <section id="intro" class="panel intro">
        <h2>이 Mac과 같은 신뢰 가능한 Wi-Fi에서만 사용하세요</h2>
        <p id="intro-message">QR 연결 정보를 확인하고 있습니다.</p>
      </section>
      <section class="toolbar" hidden id="toolbar">
        <button type="button" class="secondary" id="refresh">상태 새로고침</button>
        <span id="session-expiry"></span>
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
        <h2>AI 터미널</h2><p>Mac에서 이 연결의 터미널 접근을 허용한 뒤 사용하세요.</p>
        <select id="terminal-project" aria-label="터미널 프로젝트"></select>
        <select id="terminal-agent" aria-label="터미널 AI"><option value="codex">Codex CLI</option><option value="claude">Claude Code</option><option value="hermes">Hermes</option><option value="agy">Antigravity</option></select>
        <button id="terminal-start">새 터미널</button><button id="terminal-refresh">세션 새로고침</button>
        <select id="terminal-session" aria-label="터미널 세션"><option value="">세션 선택</option></select>
        <p id="terminal-error" role="alert"></p><div id="terminal-screen" class="terminal-screen"></div>
        <input id="terminal-line" placeholder="명령 또는 요청 입력" autocomplete="off"/><button id="terminal-send">전송</button>
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
let terminalInstance=null,terminalSelected="",terminalCursor=0,terminalTimer=null,terminalChain=Promise.resolve();
const terminalError=document.querySelector('#terminal-error');
function terminalReply(message){const waiter=terminalWaiters.get(message.requestId);if(!waiter)return;terminalWaiters.delete(message.requestId);clearTimeout(waiter.timer);message.ok?waiter.resolve(message.body):waiter.reject(new Error(message.error));}
function terminalWireRequest(request){return new Promise((resolve,reject)=>{if(!sessionToken||!socket||socket.readyState!==WebSocket.OPEN){reject(new Error('원격 연결을 먼저 완료하세요.'));return;}const requestId=nextActionId();const timer=setTimeout(()=>{terminalWaiters.delete(requestId);reject(new Error('응답을 확인하지 못했습니다. 입력이 전달되었을 수 있으므로 화면을 확인하세요.'));},15000);terminalWaiters.set(requestId,{resolve,reject,timer});socket.send(JSON.stringify({type:'terminal.request',sessionToken,request:{...request,requestId}}));});}
let terminalWire=Promise.resolve();
function terminalRequest(request){const result=terminalWire.catch(()=>{}).then(()=>new Promise(resolve=>setTimeout(resolve,180))).then(()=>terminalWireRequest(request));terminalWire=result;return result;}
function terminalQueue(request){terminalChain=terminalChain.then(()=>terminalRequest(request)).catch(e=>{terminalError.textContent=e.message;});return terminalChain;}
async function terminalPoll(){const selected=terminalSelected;if(!selected||!socket||socket.readyState!==WebSocket.OPEN)return;try{await terminalChain;const r=await terminalRequest({operation:'read',sessionId:selected,after:terminalCursor});if(selected!==terminalSelected)return;if(r.truncated){terminalInstance.reset();terminalError.textContent='이전 출력 일부가 보관 범위를 넘었습니다.';}for(const c of r.chunks||[]){if(c.seq>terminalCursor){terminalInstance.write(c.text);terminalCursor=c.seq;}}if(r.session?.state==='exited'&&!r.hasMore)return;}catch(e){terminalError.textContent=e.message;}if(selected===terminalSelected)terminalTimer=setTimeout(terminalPoll,700);}
function terminalSelect(id){clearTimeout(terminalTimer);terminalSelected=id;terminalCursor=0;terminalInstance.reset();if(id)void terminalPoll();}
async function terminalList(){try{const r=await terminalRequest({operation:'list'});const list=document.querySelector('#terminal-session');list.replaceChildren(new Option('세션 선택',''));for(const s of r.sessions||[])list.add(new Option(s.agent+' · '+s.state,s.id));list.value=terminalSelected;terminalError.textContent='';}catch(e){terminalError.textContent=e.message;}}
function terminalReady(projects){const panel=document.querySelector('#terminal-panel');panel.hidden=false;const select=document.querySelector('#terminal-project');const current=select.value;select.replaceChildren();for(const p of projects)select.add(new Option(p.name,p.controlId));if(current)select.value=current;if(!terminalInstance){terminalInstance=new window.Terminal({cols:Math.max(20,Math.min(100,Math.floor(panel.clientWidth/8))),rows:24,fontSize:12,theme:{background:'#111315',foreground:'#e5e7eb'},scrollback:1500});terminalInstance.open(document.querySelector('#terminal-screen'));terminalInstance.onData(terminalInput);new ResizeObserver(()=>{const cols=Math.max(20,Math.min(100,Math.floor((panel.clientWidth-40)/7.3)));if(cols!==terminalInstance.cols){terminalInstance.resize(cols,24);if(terminalSelected)void terminalQueue({operation:'resize',sessionId:terminalSelected,cols,rows:24});}}).observe(panel);}}
document.querySelector('#terminal-refresh').onclick=terminalList;
document.querySelector('#terminal-session').onchange=e=>terminalSelect(e.target.value);
document.querySelector('#terminal-start').onclick=async()=>{try{const r=await terminalRequest({operation:'start',targetId:document.querySelector('#terminal-project').value,agent:document.querySelector('#terminal-agent').value,cols:terminalInstance.cols,rows:terminalInstance.rows});await terminalList();document.querySelector('#terminal-session').value=r.session.id;terminalSelect(r.session.id);}catch(e){terminalError.textContent=e.message;}};
document.querySelector('#terminal-close').onclick=()=>terminalQueue({operation:'close',sessionId:terminalSelected});
let terminalPending='',terminalInputTimer=null;
function terminalInput(data){if(!terminalSelected)return;terminalPending+=data;if(terminalInputTimer)return;const sessionId=terminalSelected;terminalInputTimer=setTimeout(()=>{terminalInputTimer=null;let part='',size=0,encoded=0;for(const char of terminalPending){const n=new TextEncoder().encode(char).length;const e=new TextEncoder().encode(JSON.stringify(char)).length-2;if(size+n>4096||encoded+e>7500){void terminalQueue({operation:'input',sessionId,data:part});part='';size=0;encoded=0;}part+=char;size+=n;encoded+=e;}terminalPending='';if(part)void terminalQueue({operation:'input',sessionId,data:part});},180);}
for(const [id,data] of [['terminal-enter','\\r'],['terminal-escape','\\x1b'],['terminal-interrupt','\\x03']])document.getElementById(id).onclick=()=>terminalInput(data);
document.querySelector('#terminal-send').onclick=()=>{const field=document.querySelector('#terminal-line');if(field.value){terminalInput(field.value+'\\r');field.value='';}};

let actionSequence = 0;
let inFlight = false;
let projects = [];
let nextProjectPage = null;
let totalProjectCount = 0;
let projectQuery = "";
let selectedWorkspaceRoot = "";
let workspaceRootNames = [];
let workspaceRootsRequested = false;
const UNASSIGNED_WORKSPACE_ROOT = "__unassigned__";
const WORKSPACE_ROOT_FILTER_PREFIX = "root:";
// Name of the action currently in flight, so a result can say what succeeded
// or failed instead of a generic "요청을 처리했습니다".
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

function saveSession() {
  if (!sessionToken) return;
  try { sessionStorage.setItem(SESSION_STORAGE_KEY, sessionToken); } catch {}
}
function loadSavedSession() {
  try { return sessionStorage.getItem(SESSION_STORAGE_KEY) || ""; } catch { return ""; }
}
function clearSavedSession() {
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
  "codex.thread.start": "새 Codex 대화 만들기",
  "git.commit": "Commit", "git.pull": "Pull", "git.push": "Push",
  "git.merge": "기본 브랜치에 Merge",
  "worktree.add": "+ 표준 Git 워크트리", "worktree.add.orca": "+ Orca 등록 워크트리",
};

const ACTION_GROUPS = [
  { heading: "프로세스", className: "process", actions: ["start", "stop", "restart"] },
  {
    heading: "새 대화",
    className: "first",
    help: "Codex는 누를 때마다 이 프로젝트·워크트리에 연결된 새 대화를 만들고 ChatGPT Codex 앱에 그 대화를 열도록 요청합니다.",
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
  setBusy(true);
  socket.send(JSON.stringify(message));
}

function handleActionResult(message) {
  setBusy(false);
  const context = lastActionName || "요청";
  if (message.ok) {
    if (Array.isArray(message.workspaceRoots)) {
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
    notify(lastActionCode === "app.hermes"
      ? "최근 Hermes 대화 열기 요청을 Mac에 전달했습니다. 실제 대화 선택은 Mac의 Hermes Desktop에서 확인하세요."
      : context + " 완료");
    return;
  }
  // Keep the failure on screen; the toast alone vanished before it was useful.
  recordError(context, message.error);
  notify((message.error && message.error.message) || "요청을 처리하지 못했습니다.");
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
      sessionToken = "";
      setBusy(false);
      setStatus("연결 종료", "offline");
      clearSavedSession();
      notify(message.reason || message.message || "연결이 종료되었습니다.");
      intentionalClose = true;
    }
  });
  socket.addEventListener("close", (event) => {
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
      sessionToken = "";
      setBusy(false);
      setStatus("연결 종료", "offline");
      clearSavedSession();
      notify(message.reason || message.message || "연결이 종료되었습니다.");
      intentionalClose = true;
    }
  });
  socket.addEventListener("close", (event) => {
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

export const REMOTE_CONTROL_MOBILE_CSS = `
#terminal-panel{min-width:0;}#terminal-panel button,#terminal-panel select,#terminal-panel input{margin:4px 0;max-width:100%;min-height:44px;}#terminal-panel .terminal-screen{height:400px;background:#111315;overflow:hidden;border-radius:8px;}#terminal-panel #terminal-error{color:#ffafaf;font-size:12px;}
:root {
  color-scheme: dark;
  font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #07111f;
  color: #ecf5ff;
  --mint: #5eead4;
  --panel: rgba(13, 29, 48, .88);
  --border: rgba(148, 198, 220, .18);
}
* { box-sizing: border-box; }
body { margin: 0; min-height: 100dvh; background: radial-gradient(circle at 85% -10%, rgba(45, 212, 191, .18), transparent 42%), linear-gradient(165deg, #091728, #050b14 72%); }
main { width: min(760px, 100%); margin: 0 auto; padding: max(24px, env(safe-area-inset-top)) 18px calc(44px + env(safe-area-inset-bottom)); }
header { display: grid; grid-template-columns: auto 1fr auto; gap: 12px; align-items: center; margin-bottom: 24px; }
.brand-mark { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 14px; background: var(--mint); color: #06111d; font-weight: 900; }
.eyebrow { margin: 0 0 3px; color: #79a4c4; font-size: 10px; font-weight: 800; letter-spacing: .16em; }
h1 { margin: 0; font-size: 18px; }
.status { padding: 7px 10px; border-radius: 99px; font-size: 11px; font-weight: 800; }
.status.waiting { background: #3a2e14; color: #fbd78a; }
.status.online { background: #12372e; color: #77edca; }
.status.offline { background: #402025; color: #ff9aa6; }
.panel, .project-card { border: 1px solid var(--border); background: var(--panel); box-shadow: 0 18px 50px rgba(0, 0, 0, .24); backdrop-filter: blur(18px); }
.intro { padding: 22px; border-radius: 22px; }
.intro h2 { margin: 0 0 8px; font-size: 20px; line-height: 1.35; }
.intro p { margin: 0; color: #a8bdd0; line-height: 1.55; }
.toolbar { align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.toolbar:not([hidden]) { display: flex; }
.toolbar span { color: #7f9cb4; font-size: 11px; }
.project-list { display: grid; gap: 13px; }
.project-card { border-radius: 20px; padding: 18px; }
.project-card h2 { margin: 0; font-size: 17px; overflow-wrap: anywhere; }
.project-card p { margin: 7px 0 16px; font-size: 13px; font-weight: 750; }
.project-card p.alias { margin: 4px 0 0; font-size: 11px; font-weight: 700; color: #d8b4fe; overflow-wrap: anywhere; }
.project-card p.branch { margin: 3px 0 0; font-size: 11px; font-weight: 700; color: #8fd3c7; overflow-wrap: anywhere; }
.filter { gap: 7px; margin-bottom: 14px; }
.filter:not([hidden]) { display: grid; }
.filter label { color: #79a4c4; font-size: 10px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
.filter input, .filter select { min-height: 44px; padding: 0 14px; border: 1px solid #29435a; border-radius: 14px; background: #091725; color: #ecf5ff; font-size: 15px; }
.filter input:focus, .filter select:focus { outline: 2px solid var(--mint); outline-offset: 1px; }
.filter span { color: #7f9cb4; font-size: 11px; font-weight: 700; }
.errors { margin-bottom: 14px; border: 1px solid #6b2b34; border-radius: 16px; background: #1d1013; padding: 12px 14px; }
.errors-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.errors h2 { margin: 0; color: #ffb4bd; font-size: 11px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; }
.errors ol { margin: 10px 0 0; padding: 0; list-style: none; display: grid; gap: 10px; }
.errors li { border-top: 1px solid #45202a; padding-top: 9px; }
.errors li:first-child { border-top: 0; padding-top: 0; }
.error-head { margin: 0; color: #d79aa4; font-size: 11px; font-weight: 700; }
.error-message { margin: 3px 0 0; color: #ffe9ec; font-size: 14px; font-weight: 650; line-height: 1.45; }
.error-code { margin: 4px 0 0; color: #b3707d; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
.error-paths { margin: 6px 0 0; padding-left: 16px; color: #ffd7dc; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.6; word-break: break-all; }
.error-hint { margin: 6px 0 0; color: #9fe0c4; font-size: 13px; font-weight: 650; line-height: 1.45; }
/* 워크트리 묶음 — 어느 프로젝트의 워크트리인지 화면에서 읽히게 한다.
   규칙 정본은 src/remoteControlWorktreeGrouping.ts 이고 인터넷 포털도 같은 모양을 쓴다. */
.worktree-group { display: grid; gap: 12px; padding: 12px; border: 1px dashed rgba(94, 234, 212, .22); border-radius: 22px; background: rgba(94, 234, 212, .035); }
.worktree-group-title { margin: 0; color: #8fd3c7; font-size: 11px; font-weight: 800; overflow-wrap: anywhere; }
.project-card p.running { color: #77edca; }
.project-card p.stopped { color: #9db4c8; }
.project-card p.workspace-root { margin: 3px 0 0; color: #93c5fd; font-size: 11px; font-weight: 700; overflow-wrap: anywhere; }
.project-card p.action-heading { margin: 14px 0 7px; color: #79a4c4; font-size: 10px; font-weight: 850; letter-spacing: .04em; }
.project-card p.action-help { margin: -1px 0 8px; color: #8ca4b8; font-size: 11px; font-weight: 500; line-height: 1.55; }
.actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.actions-process { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.actions-first, .actions-reopen { grid-template-columns: minmax(0, 1fr); }
.actions-utility button, .actions-orca button { border: 1px solid #29435a; background: #0b1a29; color: #d9ecf8; }
.actions-first button { border: 1px solid rgba(110, 231, 183, .34); background: rgba(16, 185, 129, .13); color: #a7f3d0; }
.actions-reopen button { border: 1px solid rgba(216, 180, 254, .3); background: rgba(168, 85, 247, .1); color: #e9d5ff; }
.actions-git button { border: 1px solid rgba(94, 234, 212, .24); background: rgba(94, 234, 212, .08); color: #a7f3d0; }
button { min-height: 44px; border: 0; border-radius: 12px; background: var(--mint); color: #05111c; font-weight: 850; font-size: 13px; cursor: pointer; }
button.secondary { padding: 0 14px; border: 1px solid #29435a; background: #091725; color: #cde3f2; }
button:disabled { opacity: .38; cursor: not-allowed; }
.empty { padding: 24px; border: 1px dashed #29435a; border-radius: 18px; color: #9db4c8; text-align: center; }
#toast { position: fixed; left: 50%; bottom: calc(22px + env(safe-area-inset-bottom)); transform: translateX(-50%) translateY(24px); width: min(88vw, 420px); border-radius: 14px; background: #e8f7ff; color: #08131d; padding: 13px 16px; font-weight: 750; opacity: 0; pointer-events: none; transition: .2s ease; }
#toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
@media (min-width: 620px) { main { padding-inline: 24px; } .project-list { grid-template-columns: repeat(2, minmax(0, 1fr)); } .worktree-group { grid-column: 1 / -1; grid-template-columns: repeat(2, minmax(0, 1fr)); } .worktree-group-title { grid-column: 1 / -1; } }
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
