import {describe,expect,test} from 'bun:test';
import {Duplex} from 'node:stream';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ComputerUseMainLink} from '../src/computerUseMainLink';

function fixture(timeout=1000){
  const writes:Buffer[]=[];
  const stream=new Duplex({read(){},write(chunk,_encoding,done){writes.push(Buffer.from(chunk));done();}});
  const link=new ComputerUseMainLink(stream,timeout);
  const envelope=()=>JSON.parse(writes[0]!.subarray(4).toString());
  const reply=(response:unknown={ok:true})=>{
    const body=Buffer.from(JSON.stringify({version:1,id:envelope().id,response}));
    const header=Buffer.alloc(4);header.writeUInt32BE(body.length);return Buffer.concat([header,body]);
  };
  return {stream,link,writes,envelope,reply};
}

describe('computer-use inherited main channel',()=>{
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
  test('one in flight, oversized inputs and closed channels never dispatch',async()=>{
    const f=fixture();const pending=f.link.request({operation:'status'});
    await expect(f.link.request({operation:'observe'})).rejects.toMatchObject({code:'busy',notDispatched:true});
    expect(f.writes).toHaveLength(1);f.stream.push(f.reply());await pending;
    await expect(f.link.request({value:'x'.repeat(16384)})).rejects.toMatchObject({code:'request-too-large',notDispatched:true});
    expect(f.writes).toHaveLength(1);f.link.dispose();
    await expect(f.link.request({operation:'status'})).rejects.toMatchObject({code:'unavailable',notDispatched:true});
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
      const response=link?await link.request({operation:'status'}):null;
      console.log(JSON.stringify({prepared:link?.available??false,envRemoved:process.env.PORTMGR_COMPUTER_USE_FD===undefined,grandchild:new TextDecoder().decode(child.stdout).trim(),response}));link?.dispose();`);
    const built=spawnSync('/usr/bin/clang',['-std=c11','-O2','-Wall','-Wextra','-Werror','-bundle','-undefined','dynamic_lookup','-I',join(root,'node_modules/node-api-headers/include'),join(root,'src-tauri/native/computer-use/PrivateLink/addon.c'),'-o',join(directory,'agentstoz-api-sidecar-control-link.node')],{encoding:'utf8'});
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
size=struct.unpack('>I',exact(4))[0];request=json.loads(exact(size));assert request['request']=={'operation':'status'}
reply=json.dumps({'version':1,'id':request['id'],'response':{'verifiedFixture':True}}).encode();parent.sendall(struct.pack('>I',len(reply))+reply)
out,err=p.communicate(timeout=5);parent.close()
if p.returncode: raise RuntimeError(err.decode())
print(out.decode().strip())
`;
    try {
    const run=spawnSync('python3',['-c',script,binary],{encoding:'utf8',timeout:12000});
    expect(run.status,run.stderr).toBe(0);
    expect(JSON.parse(run.stdout.trim())).toEqual({prepared:true,envRemoved:true,grandchild:'closed',response:{verifiedFixture:true}});
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
    expect(JSON.parse(unsupported.stdout.trim())).toEqual({prepared:false,envRemoved:true,grandchild:'closed',response:null});
    }finally{rmSync(directory,{recursive:true,force:true});}
  },25000);
});
