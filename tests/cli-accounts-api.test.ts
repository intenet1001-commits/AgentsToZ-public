import {afterAll,beforeAll,expect,test} from 'bun:test';
import {createCliAccountsApiFixture} from './fixtures/cliAccountsApi';
import {HOST_CLI_ACCOUNT_ID} from '../src/cliAccountProtocol';

let f:Awaited<ReturnType<typeof createCliAccountsApiFixture>>;
beforeAll(async()=>{f=await createCliAccountsApiFixture();},60_000);afterAll(async()=>{await f?.close();});
const accounts='/api/agent-runtime/terminals/accounts';
const terminal='/api/agent-runtime/terminals';
const rid=()=>crypto.randomUUID();
test('account registration, official login adapter, project selection and MCP starts meet the real API',async()=>{
  for(const agent of ['codex','claude']) {
    const first=await f.post(accounts,{operation:'create',agent,label:agent+' 업무',requestId:rid()});expect(first.status).toBe(200);
    const id=first.body.accounts[1].id;
    expect(JSON.stringify(first.body)).not.toContain(f.home);
    const request={operation:'accounts',accountAction:'select',agent,targetId:'account-project',accountId:id,requestId:rid()};
    expect((await f.post(terminal,request)).status).toBe(400);
    const login=await f.post(accounts,{operation:'login',accountId:id,requestId:rid()});expect(login.status).toBe(200);
    let state:any;
    for(const deadline=Date.now()+5000;Date.now()<deadline;await Bun.sleep(25)){
      state=(await f.post(accounts,{operation:'list',agent})).body.accounts.find((s:any)=>s.id===id);
      if(state.authState==='signed-in')break;
    }
    expect(state).toMatchObject({authState:'signed-in',loginState:'idle'});
    const listed=await f.call('list_workroom_accounts',{portId:'account-project',agent});expect(listed).toMatchObject({success:true,accounts:{selectedAccountId:HOST_CLI_ACCOUNT_ID}});
    const selected=await f.call('select_workroom_account',{portId:'account-project',agent,accountId:id,requestId:rid()});expect(selected).toMatchObject({success:true,accounts:{selectedAccountId:id}});
    const launched=await f.call('start_workroom_session',{portId:'account-project',agent,accountId:id,requestId:rid(),foreground:false});expect(launched).toMatchObject({success:true,session:{accountId:id,accountLabel:agent+' 업무'}});
    const list=(await f.post(terminal,{operation:'list',requestId:rid()})).body;
    expect(list.sessions.find((s:any)=>s.id===launched.session.id).accountId).toBe(id);
    const host=await f.call('start_workroom_session',{portId:'account-project',agent,accountId:HOST_CLI_ACCOUNT_ID,reuse:true,requestId:rid(),foreground:false});
    expect(host).toMatchObject({success:true,reused:false,session:{accountId:HOST_CLI_ACCOUNT_ID}});
    const reused=await f.call('start_workroom_session',{portId:'account-project',agent,accountId:id,reuse:true,requestId:rid(),foreground:false});expect(reused.session.id).toBe(launched.session.id);
    await f.post(terminal,{operation:'close',sessionId:launched.session.id,requestId:rid()});await f.post(terminal,{operation:'close',sessionId:host.session.id,requestId:rid()});
    expect(JSON.stringify(selected)).not.toContain('private@example.invalid');expect(JSON.stringify(selected)).not.toContain(f.home);
  }
},30_000);
test('management route is exact and localhost control cannot turn an account ID into a path or login token',async()=>{
  expect((await fetch(f.baseUrl+accounts)).status).toBeGreaterThanOrEqual(400);
  expect((await f.post(accounts+'?x=1',{operation:'list',agent:'codex'})).status).toBeGreaterThanOrEqual(400);
  expect((await f.post(accounts,{operation:'login',accountId:'../../auth.json',requestId:rid()})).status).toBe(400);
  expect((await f.post(accounts,{operation:'create',agent:'codex',label:'B',requestId:rid(),credentials:{token:'SECRET'}})).status).toBe(400);
});
