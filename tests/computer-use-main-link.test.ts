import {describe,expect,test} from 'bun:test';
import {Duplex} from 'node:stream';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ComputerUseMainLink} from '../src/computerUseMainLink';
import {NativeCommunityComponentIdentity} from '../src/communityComponentIdentity';

function fixture(timeout=1000,verifyMain?:()=>boolean){
  const writes:Buffer[]=[];
  const stream=new Duplex({read(){},write(chunk,_encoding,done){writes.push(Buffer.from(chunk));done();}});
  const link=new ComputerUseMainLink(stream,timeout,verifyMain);
  const envelope=(index=0)=>JSON.parse(writes[index]!.subarray(4).toString());
  const reply=(response:unknown={ok:true},index=0)=>{
    const body=Buffer.from(JSON.stringify({version:1,id:envelope(index).id,response}));
    const header=Buffer.alloc(4);header.writeUInt32BE(body.length);return Buffer.concat([header,body]);
  };
  return {stream,link,writes,envelope,reply};
}

describe('computer-use inherited main channel',()=>{
  test.skipIf(process.platform!=='darwin')('pinned token stays tied to the first verified descriptor and the live peer',()=>{
    const directory=mkdtempSync(join(tmpdir(),'agentstoz-peer-pin-'));
    try{
      const source=fileURLToPath(new URL('./fixtures/computer-use-peer-pin.c',import.meta.url));
      const binary=join(directory,'peer-pin');
      const built=spawnSync('/usr/bin/clang',['-std=c11','-Wall','-Wextra','-Werror','-pthread',source,'-o',binary],{encoding:'utf8'});
      expect(built.status,built.stderr).toBe(0);
      const run=spawnSync(binary,[],{encoding:'utf8',timeout:10000});
      expect(run.status,run.stderr).toBe(0);
    }finally{rmSync(directory,{recursive:true,force:true});}
  });
  test('fragmented replies preserve identity and a completed channel can be reused',async()=>{
    const f=fixture();try{
      const first=f.link.request({operation:'status'}),wire=f.reply({success:true});
      f.stream.push(wire.subarray(0,2));f.stream.push(wire.subarray(2,6));f.stream.push(wire.subarray(6));
      expect(await first).toEqual({success:true});expect(f.writes).toHaveLength(1);
      const second=f.link.request({operation:'status'});
      const body=Buffer.from(JSON.stringify({version:1,id:JSON.parse(f.writes[1]!.subarray(4).toString()).id,response:{second:true}}));
      const h=Buffer.alloc(4);h.writeUInt32BE(body.length);f.stream.push(Buffer.concat([h,body]));
      expect(await second).toEqual({second:true});expect(f.link.available).toBe(true);
    }finally{f.link.dispose();}
  });
  test('installed main proof is rechecked and fails closed after loss or verifier errors',()=>{
    let trusted=true;const stream=new Duplex({read(){},write(_chunk,_encoding,done){done();}});
    const link=new ComputerUseMainLink(stream,1000,()=>trusted);
    expect(link.verifiedMain).toBe(true);trusted=false;expect(link.verifiedMain).toBe(false);
    link.dispose();trusted=true;expect(link.verifiedMain).toBe(false);
    const failing=new ComputerUseMainLink(new Duplex({read(){},write(_chunk,_encoding,done){done();}}),1000,()=>{throw Error('verification failed');});
    expect(failing.verifiedMain).toBe(false);failing.dispose();
  });
  test('one active request admits a FIFO successor; oversized inputs and closed channels never dispatch',async()=>{
    const f=fixture();const pending=f.link.request({operation:'status'});
    const next=f.link.request({operation:'observe'});
    expect(f.writes).toHaveLength(1);f.stream.push(f.reply());await pending;
    expect(f.writes).toHaveLength(2);f.stream.push(f.reply({observed:true},1));expect(await next).toEqual({observed:true});
    await expect(f.link.request({value:'x'.repeat(16384)})).rejects.toMatchObject({code:'request-too-large',notDispatched:true});
    expect(f.writes).toHaveLength(2);f.link.dispose();
    await expect(f.link.request({operation:'status'})).rejects.toMatchObject({code:'unavailable',notDispatched:true});
  });
  test('a held human-approval operation and concurrent browser/agent proofs keep immutable FIFO payloads',async()=>{
    const f=fixture();try{
      const approval=f.link.request({operation:'request-approval',fixtureOnly:true});
      const request={operation:'community-component-sign',purpose:'agent',payload:{kind:'access',subject:'original'}};
      const signing=f.link.request(request),browser=f.link.request({operation:'community-adapter-authorize',capability:'computer-use.browser'});
      request.purpose='teams';request.payload.subject='changed after enqueue';
      expect(f.writes).toHaveLength(1);f.stream.push(f.reply({approved:true}));await approval;
      expect(f.envelope(1).request).toEqual({operation:'community-component-sign',purpose:'agent',payload:{kind:'access',subject:'original'}});
      f.stream.push(f.reply({signature:'fixture'},1));await signing;expect(f.envelope(2).request.operation).toBe('community-adapter-authorize');
      f.stream.push(f.reply({authorized:true},2));await browser;expect(new Set(f.writes.map((_,i)=>f.envelope(i).id)).size).toBe(3);
    }finally{f.link.dispose();}
  });
  test('a waiting timeout and cancellation never write and leave the active operation alone',async()=>{
    const f=fixture(),abort=new AbortController();try{
      const active=f.link.request({operation:'request-approval'}),expired=f.link.request({operation:'community-component-context'},{queueTimeoutMs:5});
      await expect(expired).rejects.toMatchObject({code:'queue-timeout',notDispatched:true});
      const cancelled=f.link.request({operation:'community-adapter-authorize'},{signal:abort.signal});abort.abort();
      await expect(cancelled).rejects.toMatchObject({code:'cancelled',notDispatched:true});expect(f.link.available).toBe(true);expect(f.writes).toHaveLength(1);
      f.stream.push(f.reply({approved:true}));await active;
    }finally{f.link.dispose();}
  });
  test.each(['count','bytes'] as const)('the shared queue has a strict %s bound and releases every wait on close',async kind=>{
    const f=fixture(),rejections:Promise<unknown>[]=[];const active=f.link.request({operation:'request-approval'}).catch(e=>e);
    const count=kind==='count'?16:8;
    for(let i=0;i<count;i++)rejections.push(f.link.request({operation:'community-component-sign',...(kind==='bytes'?{payload:'x'.repeat(16000)}:{})}).catch(e=>e));
    await expect(f.link.request({operation:'community-component-sign',...(kind==='bytes'?{payload:'x'.repeat(16000)}:{})})).rejects.toMatchObject({code:'busy',notDispatched:true});
    expect(f.writes).toHaveLength(1);f.link.dispose();expect(await active).toMatchObject({notDispatched:false});
    for(const error of await Promise.all(rejections))expect(error).toMatchObject({notDispatched:true});
  });
  test('cancelling a written operation is unknown and blocks every queued request without replay',async()=>{
    const f=fixture(),abort=new AbortController(),active=f.link.request({operation:'press'},{signal:abort.signal}).catch(e=>e),queued=f.link.request({operation:'status'}).catch(e=>e);
    abort.abort();expect(await active).toMatchObject({code:'outcome-unknown',notDispatched:false});expect(await queued).toMatchObject({notDispatched:true});
    await expect(f.link.request({operation:'press'})).rejects.toMatchObject({notDispatched:true});expect(f.writes).toHaveLength(1);
  });
  test('a stale Main lineage closes active and waiting requests permanently even if a verifier later returns true',async()=>{
    let trusted=true;const f=fixture(1000,()=>trusted),active=f.link.request({operation:'request-approval'}).catch(e=>e),queued=f.link.request({operation:'community-component-context'}).catch(e=>e);
    trusted=false;f.stream.push(f.reply({approved:true}));
    expect(await active).toMatchObject({code:'main-changed',notDispatched:false});expect(await queued).toMatchObject({code:'main-changed',notDispatched:true});
    trusted=true;expect(f.link.verifiedMain).toBe(false);await expect(f.link.request({operation:'status'})).rejects.toMatchObject({notDispatched:true});expect(f.writes).toHaveLength(1);
  });
  test('the actual component broker uses shared admission without hiding unbounded work behind another queue',async()=>{
    const f=fixture(1000,()=>true),active=f.link.request({operation:'request-approval'}).catch(e=>e),identity=new NativeCommunityComponentIdentity(f.link),errors:unknown[]=[];
    const calls=Array.from({length:20},()=>identity.context().catch(error=>{errors.push(error);return error;}));
    await new Promise(r=>setImmediate(r));expect(errors).toHaveLength(4);for(const e of errors)expect(e).toMatchObject({code:'busy',notDispatched:true});
    f.link.dispose();await active;await Promise.all(calls);expect(errors).toHaveLength(20);expect(f.writes).toHaveLength(1);
  });
  test('a missing reply is unknown and never retransmitted',async()=>{
    const f=fixture(15);
    await expect(f.link.request({operation:'press'})).rejects.toMatchObject({code:'outcome-unknown',notDispatched:false});
    expect(f.writes).toHaveLength(1);expect(f.link.available).toBe(false);
    await expect(f.link.request({operation:'press'})).rejects.toMatchObject({notDispatched:true});
    expect(f.writes).toHaveLength(1);
  });
  test.each(['wrong-id','oversize','trailing-frame','invalid-utf8','extra-authority','unsolicited'] as const)('%s destroys the channel without a replay',async kind=>{
    const f=fixture();
    if(kind==='unsolicited'){f.stream.push(Buffer.from([0]));await new Promise(r=>setImmediate(r));expect(f.link.available).toBe(false);return;}
    const pending=f.link.request({operation:'press'});let bytes:Buffer;
    if(kind==='oversize'){bytes=Buffer.alloc(4);bytes.writeUInt32BE(524289);}
    else if(kind==='trailing-frame'){bytes=Buffer.concat([f.reply(),Buffer.from([0])]);}
    else {
      let body=Buffer.from(JSON.stringify({version:1,id:kind==='wrong-id'?'wrong':f.envelope().id,response:{ok:true},...(kind==='extra-authority'?{surface:'management'}:{})}));
      if(kind==='invalid-utf8')body=Buffer.concat([body.subarray(0,body.length-2),Buffer.from([0xff]),body.subarray(body.length-2)]);
      const header=Buffer.alloc(4);header.writeUInt32BE(body.length);bytes=Buffer.concat([header,body]);
    }
    f.stream.push(bytes);await expect(pending).rejects.toMatchObject({notDispatched:false});expect(f.writes).toHaveLength(1);expect(f.link.available).toBe(false);
  });
  test.skipIf(process.platform!=='darwin')('real inherited socket is close-on-exec before a provider child starts',()=>{
    const module=fileURLToPath(new URL('../src/computerUseMainLink.ts',import.meta.url));
    const root=fileURLToPath(new URL('../',import.meta.url)),directory=mkdtempSync(join(tmpdir(),'agentstoz-private-link-'));
    const binary=join(directory,'probe'),entry=join(directory,'probe.ts');
    writeFileSync(entry,`import{inheritedComputerUseMainLink as link}from ${JSON.stringify(module)};
      const raw=process.argv.at(-1);
      const child=Bun.spawnSync(['python3','-c','import os,sys;\\ntry: os.fstat(int(sys.argv[1])); print("inherited")\\nexcept OSError: print("closed")',raw],{stdout:'pipe',stderr:'pipe'});
      if(child.exitCode!==0)throw Error(new TextDecoder().decode(child.stderr));
      let response=null,notDispatched=null;try{response=link?await link.request({operation:'status'}):null;}catch(error){notDispatched=error.notDispatched;}
      console.log(JSON.stringify({prepared:link?.available??false,verifiedMain:link?.verifiedMain??false,envRemoved:process.env.PORTMGR_COMPUTER_USE_FD===undefined,grandchild:new TextDecoder().decode(child.stdout).trim(),response,notDispatched}));link?.dispose();`);
    const built=spawnSync('/usr/bin/clang',['-std=c11','-O2','-Wall','-Wextra','-Werror','-bundle','-undefined','dynamic_lookup','-framework','Security','-framework','CoreFoundation','-lbsm','-I',join(root,'node_modules/node-api-headers/include'),join(root,'src-tauri/native/computer-use/PrivateLink/addon.c'),'-o',join(directory,'agentstoz-api-sidecar-control-link.node')],{encoding:'utf8'});
    expect(built.status,built.stderr).toBe(0);
    const compiled=spawnSync(process.execPath,['build','--compile',entry,'--outfile',binary],{encoding:'utf8',timeout:15000});
    expect(compiled.status,compiled.stderr).toBe(0);
    const script=String.raw`
import os,socket,subprocess,json,struct,sys
parent,child=socket.socketpair()
fd=child.fileno()
env=os.environ.copy();env['PORTMGR_BUNDLED_SIDECAR']='1';env['PORTMGR_COMPUTER_USE_FD']=str(fd)
p=subprocess.Popen([sys.argv[1],str(fd)],pass_fds=(fd,),env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
child.close();parent.settimeout(5)
def exact(n):
 out=b''
 while len(out)<n:
  chunk=parent.recv(n-len(out))
  if not chunk:
   out,err=p.communicate(timeout=5);raise RuntimeError('early-eof: '+err.decode()+' '+out.decode())
  out+=chunk
 return out
assert parent.recv(1)==b'', 'an unverified Python parent must receive no request frame'
out,err=p.communicate(timeout=5);parent.close()
if p.returncode: raise RuntimeError(err.decode())
print(out.decode().strip())
`;
    try {
    const run=spawnSync('python3',['-c',script,binary],{encoding:'utf8',timeout:12000});
    expect(run.status,run.stderr).toBe(0);
    expect(JSON.parse(run.stdout.trim())).toEqual({prepared:false,verifiedMain:false,envRemoved:true,grandchild:'closed',response:null,notDispatched:true});
    const unsupported=spawnSync('python3',['-c',String.raw`
import os,socket,subprocess,sys
parent,child=socket.socketpair();fd=child.fileno()
env=os.environ.copy();env.pop('PORTMGR_BUNDLED_SIDECAR',None);env['PORTMGR_COMPUTER_USE_FD']=str(fd)
p=subprocess.Popen([sys.argv[1],str(fd)],pass_fds=(fd,),env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
child.close();parent.settimeout(5);assert parent.recv(1)==b''
out,err=p.communicate(timeout=5);parent.close()
if p.returncode:raise RuntimeError(err.decode())
print(out.decode().strip())
`,binary],{encoding:'utf8',timeout:12000});
    expect(unsupported.status,unsupported.stderr).toBe(0);
    expect(JSON.parse(unsupported.stdout.trim())).toEqual({prepared:false,verifiedMain:false,envRemoved:true,grandchild:'closed',response:null,notDispatched:null});
    }finally{rmSync(directory,{recursive:true,force:true});}
  },25000);
});
