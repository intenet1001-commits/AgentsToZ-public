import {afterEach,describe,expect,test} from 'bun:test';
import {chmodSync,existsSync,mkdirSync,mkdtempSync,realpathSync,rmSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkroomConversationJournal} from '../src/workroomConversationJournal';
import {submitWorkroomDraft} from '../src/workroomSubmissionClient';
import {AiTerminalService,type AiTerminalAuthority} from '../src/aiTerminalService';
import type {AiTerminalRequest} from '../src/aiTerminalProtocol';
import {assertWorkroomImageAttachments} from '../src/workroomImages';
import {assertWorkroomFileAttachments} from '../src/workroomFiles';
import {workroomAttachmentMessage} from '../src/workroomImageAttachments';
import {encryptTransitBlob,transitObjectPath} from '../src/vocAttachments';
import {WorkroomRemoteAttachmentLedger} from '../src/workroomRemoteAttachments.server';
import {submissionDigest,submissionManifestHash,normalizeWorkroomSubmission} from '../src/workroomSubmissionProtocol';
import {WORKROOM_ATTACH_TTL_MS,WORKROOM_REMOTE_ATTACHMENT_MAX_BYTES} from '../src/workroomRemoteAttachmentProtocol';

/**
 * w13 step A — a phone submission names attachments by opaque id; the host appends the attachment block itself.
 * Ids are checked at begin (owner, target, expiry), leased and re-checked right before the write, consumed after the
 * write fence. A phone's own text that ends in a block-shaped tail is still refused.
 */
const HOST='11111111-2222-4333-8444-555555555555',UID='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SUPABASE='https://example-project.supabase.co';
const OWNER='device:h1:internet:controller-1';
const PNG=new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,9,8,7,6,5,4,3,2]);
const PDF=new TextEncoder().encode('%PDF-1.7\n%remote file\n');
const START=Date.UTC(2026,9,16,3,0,0);
const cleanups:(()=>Promise<void>|void)[]=[];
afterEach(async()=>{for(const c of cleanups.splice(0).reverse())await c();});

function fixture(){
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'remote-submission-')));chmodSync(dir,0o700);
  const app=join(dir,'app');mkdirSync(app,{mode:0o700});
  const store=new WorkroomConversationJournal(app);
  const objects=new Map<string,Uint8Array>();
  let clock=START;
  const ledger=new WorkroomRemoteAttachmentLedger({appDataDir:app,hostId:()=>HOST,supabaseUrl:()=>SUPABASE,transit:()=>({remove:async()=>true}),
    resolveTarget:async()=>({cwd:dir}),now:()=>clock,sweepIntervalMs:null,
    fetchImpl:(async(url:string)=>{const path=decodeURIComponent(new URL(url).pathname.split('/portmgr-voc-transit/')[1]!);const body=objects.get(path);return body?new Response(body as BodyInit):new Response('',{status:404});}) as typeof fetch});
  let finish!:(code:number)=>void;let exit:()=>void=()=>{};let output:(data:Uint8Array)=>void=()=>{};
  const writes:string[]=[],spawned:string[][]=[];
  const service=new AiTerminalService({submissions:()=>store,remoteAttachments:ledger,
    submissionAttachments:(paths,files=[])=>{if(paths.length)assertWorkroomImageAttachments(app,paths);if(files.length)assertWorkroomFileAttachments(files);},
    resolveTarget:async()=>({cwd:dir}),executable:()=>'/fixture/harmless',signalGroup:()=>{exit();finish(0);},
    spawn:(args,options)=>{spawned.push(args);const t=options.terminal as {exit():void;data(pty:unknown,data:Uint8Array):void};exit=t.exit;output=data=>t.data(null,data);
      return{pid:999999998,exited:new Promise<number>(resolve=>{finish=resolve;}),kill:()=>{},terminal:{write:(text:string)=>{writes.push(text);return Buffer.byteLength(text);},resize:()=>{},close:()=>{exit();finish(0);}}};}});
  cleanups.push(()=>rmSync(dir,{recursive:true,force:true}),()=>store.close(),()=>service.shutdown(),()=>ledger.close());
  const authority=(owner=OWNER,targets=['fixture-project']):AiTerminalAuthority=>({owner,targets:new Set(targets),isActive:()=>true,deviceConsentActive:()=>true});
  const perform=(r:Omit<AiTerminalRequest,'requestId'>,who?:AiTerminalAuthority,options?:{receiptOwner?:string})=>service.perform({...r,requestId:crypto.randomUUID()},who,options);
  const start=async()=>{const session=(await perform({operation:'start',targetId:'fixture-project',agent:'hermes',cols:80,rows:24})).session!;output(new TextEncoder().encode('\x1b[?2004hready\r\n'));await Bun.sleep(50);return session;};
  // Uploads, admits and settles items for an owner and target; returns the ids and the saved paths (via a lease peek).
  const attach=async(plains:{bytes:Uint8Array;kind:'image'|'file'}[],owner=OWNER,targetId='fixture-project')=>{
    const items=[];
    for(const plain of plains){const sealed=await encryptTransitBlob(plain.bytes,WORKROOM_REMOTE_ATTACHMENT_MAX_BYTES);const path=transitObjectPath(HOST,UID,crypto.randomUUID());objects.set(path,sealed.ciphertext);
      items.push({path,token:'signed-token-'+'x'.repeat(30),key:sealed.key,sha256:sealed.sha256,bytes:sealed.bytes,kind:plain.kind,...(plain.kind==='file'?{name:'메모.pdf'}:{})});}
    const receiveId=crypto.randomUUID();
    await ledger.receive({receiveId,items},{owner,targetId,isActive:()=>true});await ledger.idle();
    const ids=ledger.status(receiveId,{owner,targetId}).items.map(item=>(item as {id:string}).id);
    const peek=ledger.lease(ids,{owner,targetId});const paths={images:peek.images,files:peek.files};peek.release();
    return {ids,...paths};
  };
  return {app,dir,ledger,service,writes,spawned,perform,start,attach,authority,advance:(ms:number)=>{clock+=ms;}};
}
const typed=(writes:string[])=>writes.join('').replace(/\x1b\[20[01]~/g,'');

describe('a phone submission with attachment ids', () => {
  test('is written once with the phone text, then the image block and the file block the host built', async () => {
    const f=fixture();const session=await f.start();
    const {ids,images,files}=await f.attach([{bytes:PNG,kind:'image'},{bytes:PDF,kind:'file'}]);
    const receipt=await submitWorkroomDraft({id:'remote-attach-1',sessionId:session.id,text:'이 화면과 문서를 봐 줘\r',attachments:ids,request:r=>f.perform(r,f.authority()),prepared:()=>{}});
    expect(receipt.state).toBe('written');
    expect(typed(f.writes)).toContain(workroomAttachmentMessage('이 화면과 문서를 봐 줘',images,files).replace(/\n/g,'\r')+'\r');
    // Consumed: after the id lifetime the sweep keeps the saved files (an unconsumed one would be deleted).
    f.advance(WORKROOM_ATTACH_TTL_MS+1);f.ledger.sweep();
    expect(existsSync(images[0]!)).toBe(true);expect(existsSync(files[0]!)).toBe(true);
    // A replay of the stored receipt after the ids expired returns it; nothing is written again.
    const before=f.writes.length;
    expect((await submitWorkroomDraft({id:'remote-attach-1',sessionId:session.id,text:'이 화면과 문서를 봐 줘\r',attachments:ids,request:r=>f.perform(r,f.authority()),prepared:()=>{}})).state).toBe('written');
    expect(f.writes.length).toBe(before);
    // The same id with other attachments is a different request.
    await expect(submitWorkroomDraft({id:'remote-attach-1',sessionId:session.id,text:'이 화면과 문서를 봐 줘\r',attachments:[ids[0]!],request:r=>f.perform(r,f.authority()),prepared:()=>{}})).rejects.toThrow('변경되었습니다');
  });

  test('attachments without words: the text may be Enter alone, but Enter alone without attachments is refused', async () => {
    const f=fixture();const session=await f.start();
    const {ids,images}=await f.attach([{bytes:PNG,kind:'image'}]);
    expect((await submitWorkroomDraft({id:'remote-attach-only',sessionId:session.id,text:'\r',attachments:ids,request:r=>f.perform(r,f.authority()),prepared:()=>{}})).state).toBe('written');
    expect(typed(f.writes)).toContain(workroomAttachmentMessage('',images,[]).replace(/\n/g,'\r')+'\r');
    await expect(submitWorkroomDraft({id:'remote-enter-only',sessionId:session.id,text:'\r',request:r=>f.perform(r,f.authority()),prepared:()=>{}})).rejects.toThrow('24,000바이트');
  });

  test('another owner, another target, an expired or unknown id: refused at begin, no receipt, nothing written', async () => {
    const f=fixture();const session=await f.start();
    const foreign=await f.attach([{bytes:PNG,kind:'image'}],'device:h1:internet:controller-2');
    const otherTarget=await f.attach([{bytes:PNG,kind:'image'}],OWNER,'other-project');
    const mine=await f.attach([{bytes:PNG,kind:'image'}]);
    const before=f.writes.length;
    const refused=async(id:string,ids:string[],words:string)=>{
      await expect(submitWorkroomDraft({id,sessionId:session.id,text:'봐 줘\r',attachments:ids,request:r=>f.perform(r,f.authority()),prepared:()=>{}})).rejects.toThrow(words);
      await expect(f.perform({operation:'submission',sessionId:session.id,submission:{phase:'status',id}},f.authority())).rejects.toThrow('제출 기록을 확인하지 못했습니다');
    };
    await refused('remote-foreign-owner',foreign.ids,'찾을 수 없거나 만료되었습니다');
    await refused('remote-other-target',otherTarget.ids,'다른 프로젝트용으로 넣은 첨부입니다');
    await refused('remote-unknown-id',['wa_'+'Z'.repeat(32)],'찾을 수 없거나 만료되었습니다');
    f.advance(WORKROOM_ATTACH_TTL_MS+1);
    await refused('remote-expired',mine.ids,'만료되었습니다');
    expect(f.writes.length).toBe(before);
  });

  test('a file deleted between begin and the write is refused at the write; nothing reaches the terminal', async () => {
    const f=fixture();const session=await f.start();
    const {ids,files}=await f.attach([{bytes:PDF,kind:'file'}]);
    const long='긴 요청 '.repeat(800)+'\r';
    const before=f.writes.length;
    await expect(submitWorkroomDraft({id:'remote-file-gone',sessionId:session.id,text:long,attachments:ids,request:r=>f.perform(r,f.authority()),prepared:()=>{unlinkSync(files[0]!);}})).rejects.toThrow('첨부 파일을 찾지 못했거나');
    expect(f.writes.length).toBe(before);
  });

  test('the phone\'s own block-shaped tail is still refused, with or without ids', async () => {
    const f=fixture();const session=await f.start();
    const {ids}=await f.attach([{bytes:PNG,kind:'image'}]);
    const quoted=workroomAttachmentMessage('봐 줘',['/Users/someone/.ssh/id_rsa'],[])+'\r';
    const before=f.writes.length;
    await expect(submitWorkroomDraft({id:'remote-quoted-with-ids',sessionId:session.id,text:quoted,attachments:ids,request:r=>f.perform(r,f.authority()),prepared:()=>{}})).rejects.toThrow('첨부할 수 없습니다');
    await expect(submitWorkroomDraft({id:'remote-quoted-no-ids',sessionId:session.id,text:quoted,request:r=>f.perform(r,f.authority()),prepared:()=>{}})).rejects.toThrow('첨부할 수 없습니다');
    expect(f.writes.length).toBe(before);
  });

  test('this Mac and another community Mac never send attachment ids', async () => {
    const f=fixture();const session=await f.start();
    const {ids}=await f.attach([{bytes:PNG,kind:'image'}]);
    await expect(submitWorkroomDraft({id:'local-with-ids',sessionId:session.id,text:'봐 줘\r',attachments:ids,request:r=>f.perform(r),prepared:()=>{}})).rejects.toThrow('첨부');
    await expect(submitWorkroomDraft({id:'community-with-ids',sessionId:session.id,text:'봐 줘\r',attachments:ids,request:r=>f.perform(r,undefined,{receiptOwner:'community:peer'}),prepared:()=>{}})).rejects.toThrow('첨부');
  });

  test('the request with the host block must still fit 24,000 bytes', async () => {
    const f=fixture();const session=await f.start();
    const {ids}=await f.attach([{bytes:PNG,kind:'image'}]);
    const text='가'.repeat(7_990)+'\r';
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(24_000);
    await expect(submitWorkroomDraft({id:'remote-too-long',sessionId:session.id,text,attachments:ids,request:r=>f.perform(r,f.authority()),prepared:()=>{}})).rejects.toThrow('첨부 경로·참고 프로젝트를 포함한 요청이 24,000바이트를 넘습니다');
  });

  test('a launch with ids opens the CLI with the block in its first request', async () => {
    const f=fixture();
    const {ids,images,files}=await f.attach([{bytes:PNG,kind:'image'},{bytes:PDF,kind:'file'}]);
    const receipt=await submitWorkroomDraft({id:'remote-launch-attach',text:'새 세션에서 봐 줘\r',attachments:ids,launch:{targetId:'fixture-project',agent:'hermes',cols:80,rows:24},request:r=>f.perform(r,f.authority()),prepared:()=>{}});
    expect(receipt.state).toBe('written');expect(receipt.sessionId).toBeTruthy();
    const prompt=f.spawned.at(-1)!.at(-1)!;
    expect(prompt).toBe(workroomAttachmentMessage('새 세션에서 봐 줘',images,files));
    f.advance(WORKROOM_ATTACH_TTL_MS+1);f.ledger.sweep();
    expect(existsSync(images[0]!)).toBe(true);
  });

  test('single use: after a written launch, a NEW launch or input naming the same ids is refused — no second CLI (review w13)', async () => {
    const f=fixture();
    const {ids}=await f.attach([{bytes:PNG,kind:'image'}]);
    const launch={targetId:'fixture-project',agent:'hermes' as const,cols:80,rows:24};
    expect((await submitWorkroomDraft({id:'remote-launch-first',text:'봐 줘\r',attachments:ids,launch,request:r=>f.perform(r,f.authority()),prepared:()=>{}})).state).toBe('written');
    expect(f.spawned).toHaveLength(1);
    // A replay of the same submission id is still the stored receipt (exactly once), even though the ids are consumed.
    expect((await submitWorkroomDraft({id:'remote-launch-first',text:'봐 줘\r',attachments:ids,launch,request:r=>f.perform(r,f.authority()),prepared:()=>{}})).state).toBe('written');
    expect(f.spawned).toHaveLength(1);
    // A new request naming the consumed ids (the start button pressed again after a lost answer settled) is refused.
    await expect(submitWorkroomDraft({id:'remote-launch-second',text:'\r',attachments:ids,launch,request:r=>f.perform(r,f.authority()),prepared:()=>{}})).rejects.toThrow('찾을 수 없거나 만료되었습니다');
    expect(f.spawned).toHaveLength(1);
    const session=await f.start();
    const before=f.writes.length;
    await expect(submitWorkroomDraft({id:'remote-input-reuse',sessionId:session.id,text:'다시 봐 줘\r',attachments:ids,request:r=>f.perform(r,f.authority()),prepared:()=>{}})).rejects.toThrow('찾을 수 없거나 만료되었습니다');
    expect(f.writes.length).toBe(before);
  });

  test('two NEW requests naming the same ids at once: the files are typed into one session only', async () => {
    const f=fixture();const a=await f.start(),b=await f.start();
    const {ids,images}=await f.attach([{bytes:PNG,kind:'image'}]);
    const send=(id:string,sessionId:string)=>submitWorkroomDraft({id,sessionId,text:'봐 줘\r',attachments:ids,request:r=>f.perform(r,f.authority()),prepared:()=>{}});
    const results=await Promise.allSettled([send('remote-input-race-a',a.id),send('remote-input-race-b',b.id)]);
    expect(results.filter(r=>r.status==='fulfilled'&&r.value.state==='written')).toHaveLength(1);
    const refused=results.find(r=>r.status==='rejected') as PromiseRejectedResult|undefined;
    expect(String((refused?.reason as Error|undefined)?.message)).toMatch(/다른 요청에서 쓰이는 중입니다|찾을 수 없거나 만료되었습니다/);
    expect(typed(f.writes).split(images[0]!).length-1).toBe(1);
  });

  test('a launch with ids for a target the ids were not admitted for is refused before any CLI starts', async () => {
    const f=fixture();
    const {ids}=await f.attach([{bytes:PNG,kind:'image'}],OWNER,'other-project');
    await expect(submitWorkroomDraft({id:'remote-launch-other',text:'봐 줘\r',attachments:ids,launch:{targetId:'fixture-project',agent:'hermes',cols:80,rows:24},request:r=>f.perform(r,f.authority()),prepared:()=>{}})).rejects.toThrow('다른 프로젝트용');
    expect(f.spawned).toHaveLength(0);
  });
});

describe('wire compatibility', () => {
  test('the manifest hash is unchanged without attachments; ids join it only when present', () => {
    const bytes=new TextEncoder().encode('hello\r'),digest=submissionDigest(bytes);
    expect(submissionManifestHash(bytes.length,digest,[])).toBe(submissionDigest(new TextEncoder().encode(JSON.stringify([bytes.length,digest,[]]))));
    expect(submissionManifestHash(bytes.length,digest,['ref'],[])).toBe(submissionManifestHash(bytes.length,digest,['ref']));
    expect(submissionManifestHash(bytes.length,digest,[],['wa_'+'A'.repeat(32)])).not.toBe(submissionManifestHash(bytes.length,digest,[]));
  });

  test('attachments: 1..16 unique ids on begin and single only; Enter alone only with them', () => {
    const one=new TextEncoder().encode('\r'),two=new TextEncoder().encode('a\r');
    const single=(data:Uint8Array,extra:Record<string,unknown>={})=>({phase:'single',id:'submission-1',bytes:data.length,digest:submissionDigest(data),data:Buffer.from(data).toString('base64'),...extra});
    expect(normalizeWorkroomSubmission(single(one,{attachments:['wa_'+'A'.repeat(32)]}))).toMatchObject({attachments:['wa_'+'A'.repeat(32)]});
    expect(()=>normalizeWorkroomSubmission(single(one))).toThrow();
    expect(()=>normalizeWorkroomSubmission(single(two,{attachments:[]}))).toThrow();
    expect(()=>normalizeWorkroomSubmission(single(two,{attachments:['wa_'+'A'.repeat(32),'wa_'+'A'.repeat(32)]}))).toThrow();
    expect(()=>normalizeWorkroomSubmission(single(two,{attachments:Array.from({length:17},(_,i)=>'wa_'+String(i).padStart(32,'A'))}))).toThrow();
    expect(()=>normalizeWorkroomSubmission(single(two,{attachments:['/Users/x/a.png']}))).toThrow();
    expect(()=>normalizeWorkroomSubmission({phase:'chunk',id:'submission-1',epoch:'epoch-0001',index:0,data:'YQ==',attachments:['wa_'+'A'.repeat(32)]})).toThrow();
  });
});
