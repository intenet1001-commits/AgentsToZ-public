/** Real React runtime panel with in-memory transport; never accesses API 3001. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const origin = process.env.FRONTEND_OBSERVATION_ORIGIN || 'http://127.0.0.1:9123';
assert.equal(new URL(origin).hostname, '127.0.0.1');
const ownedServer = process.env.FRONTEND_OBSERVATION_ORIGIN ? null : spawn(
  process.execPath,
  ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '9123', '--strictPort'],
  { cwd: new URL('../', import.meta.url), stdio: 'pipe' },
);
let serverError = '';
ownedServer?.stderr.on('data', chunk => { serverError = (serverError + chunk).slice(-2000); });
let browser;
try {
  let source;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (ownedServer?.exitCode !== null && ownedServer?.exitCode !== undefined) throw new Error(serverError || 'Fixture Vite exited');
    try {
      const response = await fetch(`${origin}/src/AgentRuntimePanel.tsx`);
      if (response.ok) { source = await response.text(); break; }
    } catch {}
    await delay(100);
  }
  assert.ok(source, 'Fixture Vite must start within 10 seconds');
  const react = source.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react\.js[^"\n]*)"/)?.[1];
  assert.ok(react, 'Vite React dependency is required');
  const html = `<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';
import React from ${JSON.stringify(react)};
import ReactDOM from ${JSON.stringify(react.replace('/react.js', '/react-dom_client.js'))};
RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
const state=window.__observation={reads:[],events:[],aborted:0,mutations:[],pending:false,terminal:false,withQuestion:false,questionVersion:1,visibilityListeners:new Set()};
const add=document.addEventListener.bind(document),remove=document.removeEventListener.bind(document);
document.addEventListener=(type,handler,...rest)=>{if(type==='visibilitychange')state.visibilityListeners.add(handler);return add(type,handler,...rest)};
document.removeEventListener=(type,handler,...rest)=>{if(type==='visibilitychange')state.visibilityListeners.delete(handler);return remove(type,handler,...rest)};
let hidden=false;
Object.defineProperty(document,'hidden',{configurable:true,get:()=>hidden});
window.__setHidden=value=>{hidden=value;document.dispatchEvent(new Event('visibilitychange'))};
const {AgentRuntimeClient}=await import('/src/agentRuntimeClient.ts');
const {AgentRuntimePanel}=await import('/src/AgentRuntimePanel.tsx');
const target={targetId:'target_fixture_main',projectTargetId:'target_fixture_main',label:'Fixture',scope:'main',branch:'main',locked:false,worktreeCapable:true};
const capabilities={protocolVersion:'agentstoz-tasks-v2',adapters:[],limits:{maxPromptBytes:65536,maxConcurrentTasks:1}};
const tasks=()=>Array.from({length:16},(_,i)=>({taskId:'task_fixture_'+i,targetId:target.targetId,projectLabel:'Fixture '+i,adapterId:'codex',modelId:null,executionMode:'workspace-write',status:state.terminal?'succeeded':'running',lastSeq:state.terminal?1:0,createdAt:'2026-09-07T00:00:00.000Z',updatedAt:'2026-09-07T00:00:00.000Z'}));
for(const method of ['capabilities','conversationCapabilities','targets','tasks','readiness','conversations'])AgentRuntimeClient.prototype[method]=async()=>{
 state.reads.push(method);
 if(method==='capabilities'||method==='conversationCapabilities')return capabilities;
 if(method==='targets')return {targets:[target],complete:true};
 if(method==='tasks')return {tasks:tasks()};
 if(method==='conversations')return {conversations:state.withQuestion?[{
   protocolVersion:'agentstoz-conversations-v1',conversationId:'conversation_fixture',targetId:target.targetId,projectLabel:'Question fixture',adapterId:'codex',modelId:'fixture-model',state:'running',activeTurnId:'turn_fixture',revision:1,createdAt:'2026-09-07T00:00:00.000Z',updatedAt:'2026-09-07T00:00:00.000Z',
 }]:[]};
 throw new Error('Fixture readiness is unavailable');
};
AgentRuntimeClient.prototype.events=async function(id,after,{signal}){
 state.events.push({id,after});
 if(state.pending)return new Promise((resolve,reject)=>{
   const abort=()=>{state.aborted++;reject(new DOMException('aborted','AbortError'))};
   if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
 });
 return {events:state.terminal&&after===0?[{protocolVersion:'agentstoz-tasks-v2',taskId:id,seq:1,occurredAt:'2026-09-07T00:00:00.000Z',type:'task.result',payload:{summary:'Completed '+id}}]:[]};
};
AgentRuntimeClient.prototype.conversationEvents=async()=>{state.reads.push('conversationEvents');return {events:[],nextCursor:0}};
AgentRuntimeClient.prototype.conversationQuestion=async()=>{
 state.reads.push('conversationQuestion');
 return {question:{protocolVersion:'agentstoz-conversation-questions-v1',questionRequestId:'question_fixture_'+state.questionVersion,conversationId:'conversation_fixture',turnId:'turn_fixture',revision:1,expiresAt:'2099-09-07T00:00:00.000Z',questions:[
  {questionId:'question_freeform',header:'초안',question:'남길 답변은?',options:null,allowOther:true},
  {questionId:'question_choice',header:'선택',question:'선호하는 선택은?',options:[{optionId:'option_first',label:'첫 번째 선택',description:''},{optionId:'option_second',label:'두 번째 선택',description:''}],allowOther:false},
 ]}};
};
for(const method of ['start','cancel','startConversation','continueConversation','steerConversation','interruptConversation','setConversationArchived','deleteConversation','answerConversationQuestion'])AgentRuntimeClient.prototype[method]=async()=>{state.mutations.push(method);throw new Error('No fixture mutation is permitted')};
let root=ReactDOM.createRoot(document.getElementById('root'));
function Wrapper(){const [visible,setVisible]=React.useState(true);window.__setPanelVisible=setVisible;return React.createElement(AgentRuntimePanel,{visible,projects:[target]})}
window.__mount=()=>{root.render(React.createElement(Wrapper))};
window.__unmount=()=>{root.unmount();root=ReactDOM.createRoot(document.getElementById('root'))};
window.__mount();
</script>`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1000, height: 1050 }, serviceWorkers: 'block' });
  const blocked = [], errors = [];
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || url.pathname.startsWith('/api/')) {
      blocked.push(`${route.request().method()} ${url.origin}${url.pathname}`);
      return route.abort('blockedbyclient');
    }
    if (url.pathname === '/__frontend-observation') return route.fulfill({ contentType: 'text/html', body: html });
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.install();
  await page.goto(`${origin}/__frontend-observation`);
  await page.getByTestId('agent-runtime-panel').waitFor();
  const snapshot = () => page.evaluate(() => ({
    reads: [...window.__observation.reads], events: [...window.__observation.events],
    aborted: window.__observation.aborted, mutations: [...window.__observation.mutations],
    listeners: window.__observation.visibilityListeners.size,
  }));
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve())));
  const advance = async ms => { await page.clock.runFor(ms); await settle(); };
  await page.waitForFunction(() => window.__observation.reads.includes('tasks'));
  await advance(5000);
  assert.equal((await snapshot()).events.length, 0, 'Default conversations must not poll hidden task events');
  await page.getByRole('tab', { name: '작업', exact: true }).click();
  await page.waitForFunction(() => window.__observation.events.length > 0);
  await page.getByRole('tab', { name: '대화', exact: true }).click();
  const hiddenTaskReads = (await snapshot()).events.length;
  await advance(5000);
  assert.equal((await snapshot()).events.length, hiddenTaskReads, 'Hidden task timeline polling must be zero');
  console.log('PASS hidden task events: 0 polls across 5 seconds; visible task resumes');

  const prompt = page.getByRole('textbox', { name: '대화 지시', exact: true });
  await prompt.fill('문서가 숨겨져도 남는 초안');
  await prompt.evaluate(node => { node.dataset.fixtureIdentity = 'retained'; });
  await page.evaluate(() => window.__setHidden(true));
  await settle();
  const hiddenSnapshot = await snapshot();
  await advance(60000);
  assert.deepEqual((await snapshot()).reads, hiddenSnapshot.reads, 'Occluded document must not poll any runtime inventory');
  assert.deepEqual((await snapshot()).events, hiddenSnapshot.events);
  await page.evaluate(() => window.__setHidden(false));
  await page.waitForFunction(count => window.__observation.reads.length > count, hiddenSnapshot.reads.length);
  assert.equal(await prompt.inputValue(), '문서가 숨겨져도 남는 초안');
  assert.equal(await prompt.getAttribute('data-fixture-identity'), 'retained', 'Document visibility must preserve mounted draft controls');
  console.log('PASS document hidden: 0 reads across 60 seconds; resume preserves draft and DOM');

  await page.evaluate(() => { window.__observation.pending = true; });
  await page.getByRole('tab', { name: '작업', exact: true }).click();
  const pendingStart = await snapshot();
  await page.evaluate(() => window.__setHidden(true));
  await page.waitForFunction(count => window.__observation.aborted > count, pendingStart.aborted);
  const abortedSnapshot = await snapshot();
  await advance(10000);
  assert.deepEqual((await snapshot()).events, abortedSnapshot.events, 'Aborted hidden requests must not reschedule');
  await page.evaluate(() => { window.__observation.pending = false; window.__observation.terminal = true; window.__setHidden(false); });
  await page.waitForFunction(() => window.__observation.events.some(event => event.id === 'task_fixture_0' && event.after === 0));
  await page.getByText('Completed task_fixture_0', { exact: true }).waitFor();
  console.log('PASS in-flight read abort on hide, durable cursor replay on resume');

  for (let i = 1; i < 16; i++) {
    await page.getByRole('list', { name: '에이전트 작업 목록' }).getByText(`Fixture ${i}`, { exact: true }).click();
    await page.getByText(`Completed task_fixture_${i}`, { exact: true }).waitFor();
  }
  const beforeRevisit = await snapshot();
  await page.getByRole('list', { name: '에이전트 작업 목록' }).getByText('Fixture 0', { exact: true }).click();
  await page.getByText('Completed task_fixture_0', { exact: true }).waitFor();
  const afterRevisit = await snapshot();
  assert.equal(afterRevisit.events.length, beforeRevisit.events.length + 1, 'Evicted task must refetch');
  assert.deepEqual(afterRevisit.events.at(-1), { id: 'task_fixture_0', after: 0 });
  await page.getByRole('list', { name: '에이전트 작업 목록' }).getByText('Fixture 15', { exact: true }).click();
  await page.getByText('Completed task_fixture_15', { exact: true }).waitFor();
  assert.equal((await snapshot()).events.length, afterRevisit.events.length, 'Recent cached task must not refetch');
  console.log('PASS 16 task visits: LRU eviction replays from cursor 0; recent task uses cache');

  await page.evaluate(() => { window.__observation.withQuestion = true; });
  await page.getByRole('tab', { name: '대화', exact: true }).click();
  await page.getByRole('complementary', { name: '대화 목록' }).getByText('Question fixture', { exact: true }).click();
  const questionCard = page.getByTestId('conversation-question-card');
  await questionCard.waitFor();
  const questionAnswer = questionCard.getByRole('textbox', { name: '답변', exact: true });
  await questionAnswer.fill('질문 답안 초안도 보존합니다');
  await questionCard.getByRole('radio', { name: '두 번째 선택', exact: true }).check();
  for (const boundary of ['document', 'surface']) {
    if (boundary === 'document') await page.evaluate(() => window.__setHidden(true));
    else await page.getByRole('tab', { name: '작업', exact: true }).click();
    await settle();
    const questionsBefore = (await snapshot()).reads.filter(method => method === 'conversationQuestion').length;
    await advance(10000);
    assert.equal((await snapshot()).reads.filter(method => method === 'conversationQuestion').length, questionsBefore);
    if (boundary === 'document') await page.evaluate(() => window.__setHidden(false));
    else await page.getByRole('tab', { name: '대화', exact: true }).click();
    await page.waitForFunction(count => window.__observation.reads.filter(method => method === 'conversationQuestion').length > count, questionsBefore);
    assert.equal(await questionAnswer.inputValue(), '질문 답안 초안도 보존합니다');
    assert.equal(await questionCard.getByRole('radio', { name: '두 번째 선택', exact: true }).isChecked(), true);
  }
  await page.evaluate(() => { window.__observation.questionVersion++; });
  await advance(2000);
  assert.equal(await questionAnswer.inputValue(), '', 'A different server question must clear the previous draft');
  assert.equal(await questionCard.getByRole('radio', { name: '두 번째 선택', exact: true }).isChecked(), false);
  console.log('PASS question text/radio drafts survive document and surface hiding; new question clears drafts');

  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => window.__unmount());
    await settle();
    const unmounted = await snapshot();
    assert.equal(unmounted.listeners, 0, 'Unmount must remove the visibility listener');
    await advance(60000);
    assert.deepEqual(await snapshot(), unmounted, 'Unmount must not retain timers or issue work');
    await page.evaluate(() => window.__mount());
    await page.getByTestId('agent-runtime-panel').waitFor();
    assert.equal((await snapshot()).listeners, 1, 'Remount must install only one listener');
  }
  assert.deepEqual((await snapshot()).mutations, [], 'Observation lifecycle must never cancel, restart or mutate jobs');
  assert.deepEqual(blocked, [], 'All transport must remain in memory; no app API or external connection');
  assert.deepEqual(errors, [], 'Real React components must not throw');
  console.log('PASS 10 unmount/remount cycles: 0 orphan reads/listeners, 0 job mutations, 0 real API requests');
} finally {
  await browser?.close();
  if (ownedServer && ownedServer.exitCode === null) {
    ownedServer.kill('SIGTERM');
    await Promise.race([new Promise(resolve => ownedServer.once('exit', resolve)), delay(3000)]);
  }
}
