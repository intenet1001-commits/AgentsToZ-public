/**
 * Review w13 — the real phone queue wired to the real Mac ledger (in-memory bucket, no network). Switching the viewed
 * session between projects used to re-upload every kept chip and leave the old ids live on the Mac until the 32-id cap
 * refused, and 「빼기」 never freed a Mac id. Now a switch rebinds the same ids (no upload, no download, no quota) and a
 * chip taken out releases its id.
 */
import {expect,test} from 'bun:test';
import {mkdtempSync,readFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RemoteWorkroomAttachments,type RemoteAttachContext} from '../src/remoteWorkroomAttachments';
import {WorkroomRemoteAttachmentLedger,WORKROOM_REMOTE_ATTACHMENT_STATE_FILE} from '../src/workroomRemoteAttachments.server';
import type {MobileWorkspaceRequest,MobileWorkspaceResult} from '../src/mobileWorkspaceProtocol';
import type {WorkroomAttachmentIdsRequest,WorkroomAttachmentReceive,WorkroomAttachmentStatusRequest} from '../src/workroomRemoteAttachmentProtocol';

const HOST='11111111-2222-4333-8444-555555555555',UID='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',SUPABASE='https://example-project.supabase.co';
const OWNER='device:h1:internet:controller-1',A='A'.repeat(43),B='B'.repeat(43);
const PNG=new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,9,8,7,6,5,4,3,2]);

test('flipping projects keeps the same Mac ids; removing chips frees the live cap', async () => {
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'remote-attach-flip-')));
  const objects=new Map<string,Uint8Array>();
  let downloads=0;
  const ledger=new WorkroomRemoteAttachmentLedger({appDataDir:dir,hostId:()=>HOST,supabaseUrl:()=>SUPABASE,transit:()=>({remove:async(paths:string[])=>{for(const p of paths)objects.delete(p);return true;}}),
    resolveTarget:async()=>({cwd:dir}),sweepIntervalMs:null,
    fetchImpl:(async(url:string)=>{downloads++;const path=decodeURIComponent(new URL(url).pathname.split('/portmgr-voc-transit/')[1]!);const body=objects.get(path);return body?new Response(body as BodyInit):new Response('',{status:404});}) as typeof fetch});
  const bucket={
    upload:async(path:string,body:Blob)=>{objects.set(path,new Uint8Array(await body.arrayBuffer()));return {error:null};},
    createSignedUrl:async(path:string)=>({data:{signedUrl:`${SUPABASE}/storage/v1/object/sign/portmgr-voc-transit/${path}?token=tok.${crypto.randomUUID().replaceAll('-','')}.sig`},error:null}),
    remove:async(paths:string[])=>{for(const p of paths)objects.delete(p);return {error:null};},
    list:async()=>({data:[],error:null}),
  };
  // The Mac side of performMobileWorkspace for these actions (owner = the device consent's requestOwner).
  const send=async(request:MobileWorkspaceRequest):Promise<MobileWorkspaceResult>=>{
    const action=request.workspace.action,body=request.workspace.attachments;
    const answer=action==='attachments.receive'?await ledger.receive(body as WorkroomAttachmentReceive,{owner:OWNER,targetId:request.targetId,isActive:()=>true}).then(async r=>{await ledger.idle();return r;})
      :action==='attachments.status'?ledger.status((body as WorkroomAttachmentStatusRequest).receiveId,{owner:OWNER,targetId:request.targetId})
      :action==='attachments.rebind'?await ledger.rebind(body as WorkroomAttachmentIdsRequest,{owner:OWNER,targetId:request.targetId})
      :action==='attachments.release'?ledger.release(body as WorkroomAttachmentIdsRequest,{owner:OWNER}):null;
    if(!answer)throw new Error('unexpected '+action);
    return {kind:'workspace',action,workroomAttachments:answer};
  };
  const context:RemoteAttachContext={availability:'ready',supabase:{auth:{getSession:async()=>({data:{session:{user:{id:UID}}}})},storage:{from:()=>bucket}} as never,hostId:HOST,send};
  let clock=1_000_000;
  const attach=new RemoteWorkroomAttachments({context:()=>context,targetId:A,online:()=>true,now:()=>clock,sleep:async ms=>{clock+=ms;await Promise.resolve();},
    preparePhoto:async file=>({bytes:new Uint8Array(await file.arrayBuffer()),mime:'image/png'}),objectUrl:()=>undefined});
  const settle=async()=>{for(let i=0;i<2000&&attach.moving();i++)await new Promise(r=>setTimeout(r,0));for(let i=0;i<20;i++)await new Promise(r=>setTimeout(r,0));};
  const usage=()=>JSON.parse(readFileSync(join(dir,WORKROOM_REMOTE_ATTACHMENT_STATE_FILE),'utf8')).usage[OWNER].bytes;
  try{
    attach.add(Array.from({length:6},(_,i)=>new File([PNG],`photo${i}.png`,{type:'image/png'})),'image');
    await settle();
    const ids=attach.ready().ids;
    expect(ids).toHaveLength(6);
    const charged=usage();
    for(const target of [B,A,B,A,B]){
      attach.retarget(target);await settle();
      expect(attach.snapshot().map(c=>c.state)).toEqual(Array(6).fill('ready'));
      expect(attach.ready().ids).toEqual(ids);
      // The Mac accepts them for the viewed project now, and only for it.
      expect(()=>ledger.check(ids,{owner:OWNER,targetId:target})).not.toThrow();
    }
    expect(downloads).toBe(6);
    expect(usage()).toBe(charged);
    // 「빼기」 frees the Mac's room: take everything out, then 32 fresh ids fit again.
    attach.clear();await settle();
    expect(()=>ledger.check([ids[0]!],{owner:OWNER,targetId:B})).toThrow('찾을 수 없거나 만료되었습니다');
    for(let round=0;round<5;round++){
      attach.add(Array.from({length:6},(_,i)=>new File([PNG],`again${round}-${i}.png`,{type:'image/png'})),'image');
      await settle();
      expect(attach.snapshot().map(c=>c.state)).toEqual(Array(6).fill('ready'));
      attach.clear();await settle();
    }
    attach.add(Array.from({length:6},(_,i)=>new File([PNG],`last${i}.png`,{type:'image/png'})),'image');
    await settle();
    expect(attach.snapshot().map(c=>c.state)).toEqual(Array(6).fill('ready'));
    expect(objects.size).toBe(0);
  }finally{attach.dispose();ledger.close();rmSync(dir,{recursive:true,force:true});}
});
