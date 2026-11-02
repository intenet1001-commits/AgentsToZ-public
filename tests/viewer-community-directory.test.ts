import {afterEach,expect,test} from 'bun:test';
import {existsSync,lstatSync,mkdtempSync,readFileSync,readdirSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentDialogueHost} from '../src/agentDialogueHost';
import {createViewerCommunityPublisher,viewerCommunityDirectory,VIEWER_COMMUNITY_FILE} from '../src/viewerCommunityDirectory';

const roots:string[]=[];
const temporary=()=>{const root=mkdtempSync(join(tmpdir(),'viewer-directory-'));roots.push(root);return root;};
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const device={deviceId:'other-mac',endpointId:'endpoint-secret-reference',displayName:'아젠투지 1호',kind:'ops' as const,lastSeenAt:'2023-11-14T22:13:20.000Z'};

test('Viewer directory is bounded discovery, with no endpoint, credential, address, screen key or grant',()=>{
  const document=viewerCommunityDirectory({inside:true,devices:[device,{...device,displayName:'duplicate'},
    {...device,deviceId:'spoof',displayName:'Host\u202eMac'}, {...device,deviceId:'long',displayName:'가'.repeat(81)}]},1_700_000_000_000);
  expect(document.devices).toHaveLength(1);
  expect(Object.keys(document.devices[0]!)).toEqual(['ref','name','lastSeenAt']);
  expect(JSON.stringify(document)).not.toContain(device.endpointId);
  expect(JSON.stringify(document)).not.toContain(device.deviceId);
  expect(document.expiresAt-document.generatedAt).toBe(90_000);
  expect(viewerCommunityDirectory({inside:false,devices:[device]}).devices).toEqual([]);
  expect(viewerCommunityDirectory({inside:true,devices:Array.from({length:200},(_,i)=>({...device,deviceId:String(i)}))}).devices).toHaveLength(64);
});

test('publisher atomically replaces a symlink rather than following it and leaves only an owner-readable file',()=>{
  const root=temporary(),sentinel=join(root,'sentinel');writeFileSync(sentinel,'private data');
  symlinkSync(sentinel,join(root,VIEWER_COMMUNITY_FILE));
  const publish=createViewerCommunityPublisher(root,()=>1_700_000_000_000);
  publish({inside:true,devices:[device]});
  expect(readFileSync(sentinel,'utf8')).toBe('private data');
  expect(lstatSync(join(root,VIEWER_COMMUNITY_FILE)).isSymbolicLink()).toBe(false);
  expect(lstatSync(join(root,VIEWER_COMMUNITY_FILE)).mode&0o777).toBe(0o600);
  expect(readdirSync(root).filter(name=>name.endsWith('.tmp'))).toEqual([]);
  publish({inside:false,devices:[device]});
  expect(JSON.parse(readFileSync(join(root,VIEWER_COMMUNITY_FILE),'utf8')).devices).toEqual([]);
});

test('actual community host exports existing member responses, clears on leave, and ignores delayed reads after profile change',async()=>{
  const root=temporary(),snapshots:{inside:boolean;devices:unknown[]}[]=[];
  let profileId='profile-one',inside=false,calls=0,hold=false,release:(()=>void)|undefined,started:(()=>void)|undefined;
  const host=new AgentDialogueHost({appDataDir:root,identity:()=>({profileId,deviceId:'self-mac'}),secret:async()=>'x'.repeat(44),
    resolveTarget:async()=>({kind:'ops',displayName:'This Mac'}),
    communityDirectory:value=>snapshots.push(value),
    rpc:async(operation)=>{
      if(operation==='register-endpoint')return {endpointId:'local-ops'};
      if(operation==='community-join')inside=true;
      if(operation==='community-leave')inside=false;
      if(operation==='community-status'){
        calls++;if(hold)await new Promise<void>(resolve=>{release=resolve;started?.();});
        return {inside,roomId:'room',members:[device,{...device,deviceId:'self-mac'}]};
      }
      return {};
    }});
  await host.enable({target:'ops'},true);await host.uiCommunity({target:'ops'},'join');
  await host.controlDevices();
  expect(snapshots.at(-1)).toEqual({inside:true,devices:[device]});
  const count=calls;await host.controlDevices();expect(calls).toBe(count);
  await host.uiCommunity({target:'ops'},'leave');expect(snapshots.at(-1)).toEqual({inside:false,devices:[]});
  await host.uiCommunity({target:'ops'},'join');
  hold=true;
  const waiting=new Promise<void>(resolve=>{started=resolve;});
  const pending=host.controlDevices();
  await waiting;
  profileId='profile-two';host.status();const before=snapshots.length;
  release?.();await pending;
  expect(snapshots.slice(before).some(value=>value.inside)).toBe(false);
});

test('presentation controls accept normal AppKit activation without manufacturing a protected action',async()=>{
  if(process.platform!=='darwin')return;
  const root=temporary(),main=join(root,'main.swift'),binary=join(root,'presentation');
  writeFileSync(main,`import AppKit
@main struct PresentationCheck {
  @MainActor static func main() {
    let application = NSApplication.shared
    var opened = 0
    let button = PresentationButton(title: "Mac 추가…") { opened += 1 }
    button.performClick(nil)
    guard opened == 1 else { fatalError("presentation was refused") }
    print("presentation opened; no enrollment, connection, key or input path linked")
    _ = application
  }
}
`);
  const source=join(import.meta.dir,'../native/screen-control/Sources/AgentsToZViewer/ViewerPresentation.swift');
  const compile=Bun.spawn(['swiftc','-parse-as-library','-o',binary,source,main],{stdout:'pipe',stderr:'pipe'});
  const [code,errors]=await Promise.all([compile.exited,new Response(compile.stderr).text()]);
  expect(code,errors).toBe(0);
  const run=Bun.spawn([binary],{stdout:'pipe',stderr:'pipe'});
  const [exit,output]=await Promise.all([run.exited,new Response(run.stdout).text()]);
  expect(exit).toBe(0);expect(output).toContain('presentation opened');
  expect(existsSync(join(root,VIEWER_COMMUNITY_FILE))).toBe(false);
},120_000);
