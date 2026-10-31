import {expect,test} from 'bun:test';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CodexNewChatReceiptStore} from '../src/codexNewChatReceipts';
import {projectLaunchDirectoryIdentity} from '../src/projectLaunchReceipt';
import {startTestApiServer} from './startTestApiServer';

test('Mac management requires capability, exact registered project and fresh explicit CAS confirmation',async()=>{
  const root=mkdtempSync(join(tmpdir(),'codex-new-manage-'));
  const home=join(root,'home'),appData=join(root,'data'),folder=join(root,'project');
  mkdirSync(home,{recursive:true});mkdirSync(appData,{recursive:true});mkdirSync(folder,{recursive:true});
  const portId='codex-management-fixture';
  writeFileSync(join(appData,'ports.json'),JSON.stringify([{id:portId,name:'Fixture',folderPath:folder}]));
  const store=new CodexNewChatReceiptStore(appData),folderIdentity=projectLaunchDirectoryIdentity(folder);
  const projectIdentity=JSON.stringify([folderIdentity,portId]);
  const request={controllerId:'paired-device',projectIdentity,folderIdentity,registrationIdentity:portId,actionId:'test-action',expiresAt:new Date(Date.now()+60000).toISOString()};
  await store.reserve(request);
  let child: Bun.Subprocess|undefined;
  try {
    const started=await startTestApiServer({cwd:join(import.meta.dir,'..'),env:{...process.env,HOME:home,APPDATA:join(home,'AppData'),XDG_CONFIG_HOME:join(home,'.config'),APP_DATA_DIR:appData,NODE_ENV:'test',PORT:'9000',PORTMGR_BUNDLED_SIDECAR:'1',PORTMGR_PARENT_PID:String(process.pid),PORTMGR_REMOTE_CONTROL_CAPABILITY:'f'.repeat(64),PORTMGR_WHAT_I_SAID_CAPABILITY:'e'.repeat(64),AGENTSTOZ_SKIP_HERMES_SYNC:'1'}});
    child=started.child;
    const call=async(path:string,body:Record<string,unknown>,capability=true,method='POST')=>{
      const response=await fetch(started.baseUrl+path,{method,headers:{'Content-Type':'application/json',Origin:'http://tauri.localhost',...(capability?{'X-AgentsToZ-Remote-Control-Capability':'f'.repeat(64)}:{})},...(method==='POST'?{body:JSON.stringify(body)}:{})});
      return {status:response.status,body:await response.json() as any};
    };
    expect((await call('/api/remote-control/codex-new/review',{portId},false)).status).toBe(403);
    expect((await call('/api/remote-control/codex-new/resolve',{portId},false)).status).toBe(403);
    expect((await call('/api/remote-control/codex-new/review',{},true,'GET')).status).toBe(405);
    expect((await call('/api/remote-control/codex-new/resolve',{},true,'GET')).status).toBe(405);
    expect((await call('/api/remote-control/codex-new/review',{portId,folderPath:folder})).status).toBe(400);
    const review=await call('/api/remote-control/codex-new/review',{portId});
    expect(review.status).toBe(200);expect(review.body.receipt.state).toBe('started');
    expect(JSON.stringify(review.body)).not.toContain(folder);expect(JSON.stringify(review.body)).not.toContain('paired-device');
    expect((await call('/api/remote-control/codex-new/resolve',{portId,expectedRevision:review.body.receipt.revision,confirmed:false})).status).toBe(400);
    expect((await call('/api/remote-control/codex-new/resolve',{portId,expectedRevision:'a'.repeat(64),confirmed:true})).status).toBe(409);
    expect((await call('/api/remote-control/codex-new/resolve',{portId,expectedRevision:review.body.receipt.revision,confirmed:true})).status).toBe(200);
    expect((await store.reserve(request)).state).toBe('cancelled');
  } finally {if(child){try{child.kill();}catch{}await child.exited.catch(()=>undefined);}rmSync(root,{recursive:true,force:true});}
},30_000);
