import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PlatformCliStore} from '../src/platformCliStore';
import {PlatformCliHost} from '../src/platformCliHost';
import {PlatformCliOperations} from '../src/platformCliOperation';
import {validatePlatformCliRequest} from '../src/platformCliRequestValidation';
const dirs:string[]=[];afterEach(()=>dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true})));
const rid=()=>crypto.randomUUID();
async function fixture(){const dir=mkdtempSync(join(tmpdir(),'atz-keychain-wait-'));dirs.push(dir);const vault=new Map<string,string>(),store=new PlatformCliStore(dir,{get:async id=>vault.get(id)??null,set:async(id,v)=>{vault.set(id,v);}}),host=new PlatformCliHost({store,executable:()=>'/fixture/gh',resolveProject:async id=>({id,cwd:dir,label:id}),run:async()=>({code:0,stdout:'{"login":"owner","id":1}',stderr:''})});const account=await store.create('github','Work account','ghp_'+'a'.repeat(40),rid());return {dir,store,host,account,ops:new PlatformCliOperations(host)};}
test('a blocked Keychain read returns an immediate waiting receipt; polling never restarts the API check',async()=>{
  const f=await fixture();let resolve!:(v:any)=>void,calls=0;f.host.check=async()=>{calls++;return new Promise(r=>{resolve=r;});};const request={operation:'check-start',accountId:f.account.id,requestId:rid()};
  const admitted=await f.ops.start(request);expect(admitted.state).toBe('waiting');expect(admitted.provider).toBe('github');expect(f.ops.status(request.requestId).state).toBe('waiting');expect((await f.ops.start(request)).state).toBe('waiting');expect(calls).toBe(1);
  await expect(f.ops.start({...request,requestId:rid()})).rejects.toThrow();resolve({...f.account,state:'ready'});await Bun.sleep(5);expect(f.ops.status(request.requestId).state).toBe('completed');expect(calls).toBe(1);
  const receipt=readFileSync(join(f.store.root,'connection-operation-'+request.requestId+'.json'),'utf8');expect(receipt).not.toContain('ghp_');
});
test('restarting while awaiting approval reports interruption and never replays an unknown outcome',async()=>{
  const f=await fixture();let resolve!:(v:any)=>void;f.host.check=()=>new Promise(r=>{resolve=r;});const request={operation:'check-start',accountId:f.account.id,requestId:rid()};await f.ops.start(request);
  const resumed=new PlatformCliOperations(f.host);expect(resumed.status(request.requestId).state).toBe('interrupted');expect(resumed.status(request.requestId).provider).toBe('github');expect((await resumed.start(request)).state).toBe('interrupted');resolve(f.account);await Bun.sleep(5);
});
test('request id binds the account and purpose; agents cannot enter credential or interactive operations',async()=>{
  const f=await fixture(),request={operation:'check-start',accountId:f.account.id,requestId:rid()};await f.ops.start(request);await Bun.sleep(5);await expect(f.ops.start({...request,accountId:'different'})).rejects.toThrow();
  for(const operation of ['check-start','connect-native-start','connection-status'])expect(()=>validatePlatformCliRequest({operation,requestId:rid()},true)).toThrow();
});
