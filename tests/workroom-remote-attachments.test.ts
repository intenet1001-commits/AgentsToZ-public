import {afterEach,beforeEach,describe,expect,test} from 'bun:test';
import {existsSync,mkdtempSync,readFileSync,realpathSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {encryptTransitBlob,transitObjectPath} from '../src/vocAttachments';
import {WorkroomRemoteAttachmentLedger,WORKROOM_REMOTE_ATTACHMENT_STATE_FILE} from '../src/workroomRemoteAttachments.server';
import {
  normalizeWorkroomAttachmentResult, WORKROOM_ATTACH_ID_RE, WORKROOM_ATTACH_TTL_MS, WORKROOM_REMOTE_ATTACHMENT_MAX_BYTES,
  type WorkroomAttachmentReceive, type WorkroomAttachmentReceiveItem,
} from '../src/workroomRemoteAttachmentProtocol';

/**
 * w13 step A — the Mac side of phone attachments. The phone encrypts each file with a fresh key, uploads the ciphertext
 * to the private VOC transit bucket and sends the keys through the E2E relay; the Mac admits the request at once,
 * downloads in the background (never inside the relay poll), verifies, saves through the w10 host functions and
 * answers with opaque ids only.
 */
const HOST='11111111-2222-4333-8444-555555555555',UID='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SUPABASE='https://example-project.supabase.co';
const OWNER='device:h1:internet:controller-1',OTHER_OWNER='device:h1:internet:controller-2',TARGET='runtime-target-1';
const PNG=new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3,4,5,6,7,8]);
const PDF=new TextEncoder().encode('%PDF-1.7\n%secret contents\n');
const START=Date.UTC(2026,9,16,3,0,0);

let app:string;
beforeEach(()=>{app=realpathSync(mkdtempSync(join(tmpdir(),'remote-attach-')));});
afterEach(()=>rmSync(app,{recursive:true,force:true}));

type Fetch=(url:string,init?:RequestInit)=>Promise<Response>;
function harness(options:{fetch?:Fetch;transit?:{remove(paths:string[]):Promise<boolean>}|null;supabaseUrl?:string|null;now?:()=>number;itemTimeoutMs?:number}={}){
  const objects=new Map<string,Uint8Array>(),fetched:{url:string;redirect?:RequestRedirect}[]=[],removed:string[][]=[];
  let clock=START;
  const fetchImpl:Fetch=options.fetch??(async(url,init)=>{
    fetched.push({url,redirect:init?.redirect});
    const path=decodeURIComponent(new URL(url).pathname.split('/portmgr-voc-transit/')[1]!);
    const body=objects.get(path);
    return body?new Response(body as BodyInit):new Response('missing',{status:404});
  });
  const ledger=new WorkroomRemoteAttachmentLedger({
    appDataDir:app,hostId:()=>HOST,supabaseUrl:()=>options.supabaseUrl===undefined?SUPABASE:options.supabaseUrl,
    transit:()=>options.transit===undefined?{remove:async paths=>{removed.push(paths);return true;}}:options.transit,
    resolveTarget:async id=>{if(id!==TARGET&&id!=='runtime-target-2')throw new Error('unknown target');return {cwd:app};},
    fetchImpl:fetchImpl as typeof fetch,now:options.now??(()=>clock),sweepIntervalMs:null,itemTimeoutMs:options.itemTimeoutMs,
  });
  return {ledger,objects,fetched,removed,advance:(ms:number)=>{clock+=ms;},close:()=>ledger.close()};
}
async function upload(h:ReturnType<typeof harness>,plain:Uint8Array,kind:'image'|'file',extra:Partial<WorkroomAttachmentReceiveItem>={}):Promise<WorkroomAttachmentReceiveItem>{
  const sealed=await encryptTransitBlob(plain,WORKROOM_REMOTE_ATTACHMENT_MAX_BYTES);
  const path=transitObjectPath(HOST,UID,crypto.randomUUID());
  h.objects.set(path,sealed.ciphertext);
  return {path,token:'signed-token-'+'x'.repeat(30),key:sealed.key,sha256:sealed.sha256,bytes:sealed.bytes,kind,...(kind==='file'?{name:'보고서.pdf'}:{}),...extra};
}
const receive=(items:WorkroomAttachmentReceiveItem[],receiveId:string=crypto.randomUUID()):WorkroomAttachmentReceive=>({receiveId,items});
const scope=(extra:Partial<{owner:string;targetId:string;isActive:()=>boolean}>={})=>({owner:OWNER,targetId:TARGET,isActive:()=>true,...extra});
const fakeItem=(bytes=16):WorkroomAttachmentReceiveItem=>({path:transitObjectPath(HOST,UID,crypto.randomUUID()),token:'signed-token-'+'y'.repeat(30),key:'A'.repeat(43),sha256:'a'.repeat(64),bytes,kind:'file',name:'a.txt'});

describe('receive: admit now, download in the background, answer with opaque ids', () => {
  test('a PNG and a PDF become a workroom image and a workroom file; the answer carries no Mac path', async () => {
    const h=harness();
    const png=await upload(h,PNG,'image'),pdf=await upload(h,PDF,'file');
    const request=receive([png,pdf]);
    const admitted=await h.ledger.receive(request,scope());
    expect(admitted.receiveId).toBe(request.receiveId);
    expect(admitted.items.map(item=>item.state)).toEqual(['pending','pending']);
    await h.ledger.idle();
    const settled=h.ledger.status(request.receiveId,scope());
    expect(normalizeWorkroomAttachmentResult(settled)).toEqual(settled);
    expect(settled.items.map(item=>item.state)).toEqual(['ready','ready']);
    const json=JSON.stringify(settled);
    expect(json).not.toContain('/');expect(json).not.toContain(app);expect(json).not.toContain('workroom-');
    const [image,file]=settled.items as Extract<(typeof settled.items)[number],{state:'ready'}>[];
    expect(image!.id).toMatch(WORKROOM_ATTACH_ID_RE);expect(file!.id).toMatch(WORKROOM_ATTACH_ID_RE);
    expect(image!.kind).toBe('image');expect(file!.kind).toBe('file');
    expect(image!.removed).toBe(true);expect(image!.expiresInMs).toBe(WORKROOM_ATTACH_TTL_MS);
    // Download URLs are rebuilt from this Mac's Supabase URL and the token only, never followed through a redirect.
    expect(h.fetched.map(f=>f.url).sort()).toEqual([png,pdf].map(item=>`${SUPABASE}/storage/v1/object/sign/portmgr-voc-transit/${item.path}?token=${item.token}`).sort());
    expect(h.fetched.every(f=>f.redirect==='error')).toBe(true);
    expect(h.removed.flat().sort()).toEqual([png.path,pdf.path].sort());
    const lease=h.ledger.lease([image!.id,file!.id],{owner:OWNER,targetId:TARGET});
    expect(lease.images).toHaveLength(1);expect(lease.files).toHaveLength(1);
    expect(lease.images[0]!.startsWith(join(app,'workroom-images')+'/')).toBe(true);
    expect(lease.files[0]!.startsWith(join(app,'workroom-files')+'/')).toBe(true);
    expect(lease.files[0]!.endsWith('-보고서.pdf')).toBe(true);
    expect(readFileSync(lease.images[0]!)).toEqual(Buffer.from(PNG));
    expect(readFileSync(lease.files[0]!)).toEqual(Buffer.from(PDF));
    expect(statSync(lease.files[0]!).mode&0o777).toBe(0o600);
    expect(image!.lineBytes).toBe(Buffer.byteLength(lease.images[0]!));expect(file!.lineBytes).toBe(Buffer.byteLength(lease.files[0]!));
    lease.release();h.close();
  });

  test('a phone-sent download URL is never used; a path under another Mac is refused before any fetch', async () => {
    const h=harness();
    const png=await upload(h,PNG,'image');
    const foreign={...png,path:transitObjectPath('99999999-2222-4333-8444-555555555555',UID,crypto.randomUUID())};
    await expect(h.ledger.receive(receive([foreign]),scope())).rejects.toThrow('(WORKROOM_ATTACH_PATH_INVALID)');
    expect(h.fetched).toHaveLength(0);
    const noUrl=harness({supabaseUrl:null});
    await expect(noUrl.ledger.receive(receive([png]),scope())).rejects.toThrow('(WORKROOM_ATTACH_SUPABASE_URL_MISSING)');
    h.close();noUrl.close();
  });

  test('a hash mismatch fails that item only: nothing saved for it, its object removed, the sibling still ready', async () => {
    const h=harness();
    const good=await upload(h,PNG,'image'),bad={...await upload(h,PDF,'file'),sha256:'0'.repeat(64)};
    const request=receive([bad,good]);
    await h.ledger.receive(request,scope());await h.ledger.idle();
    const settled=h.ledger.status(request.receiveId,scope());
    expect(settled.items[0]).toMatchObject({state:'failed',code:'WORKROOM_ATTACH_HASH_MISMATCH',removed:true});
    expect(settled.items[1]).toMatchObject({state:'ready',kind:'image'});
    expect(existsSync(join(app,'workroom-files'))).toBe(false);
    expect(h.removed.flat()).toContain(bad.path);
    h.close();
  });

  test('a file declared as an image must be one by its bytes', async () => {
    const h=harness();
    const pdfAsImage=await upload(h,PDF,'image');
    const request=receive([pdfAsImage]);
    await h.ledger.receive(request,scope());await h.ledger.idle();
    expect(h.ledger.status(request.receiveId,scope()).items[0]).toMatchObject({state:'failed',code:'WORKROOM_ATTACH_NOT_IMAGE'});
    expect(existsSync(join(app,'workroom-images'))).toBe(false);
    h.close();
  });

  test('consent revoked before saving: nothing is saved', async () => {
    const h=harness();
    let active=true;
    const png=await upload(h,PNG,'image');
    const request=receive([png]);
    await h.ledger.receive(request,scope({isActive:()=>active}));
    active=false;
    await h.ledger.idle();
    expect(h.ledger.status(request.receiveId,scope()).items[0]).toMatchObject({state:'failed',code:'WORKROOM_ATTACH_REVOKED'});
    expect(existsSync(join(app,'workroom-images'))).toBe(false);
    h.close();
  });

  test('the same receiveId is one job (no second download); other items under it are a conflict', async () => {
    const h=harness();
    const png=await upload(h,PNG,'image');
    const request=receive([png]);
    await h.ledger.receive(request,scope());
    const again=await h.ledger.receive(request,scope());
    await h.ledger.idle();
    expect(again.receiveId).toBe(request.receiveId);
    expect(h.fetched).toHaveLength(1);
    const third=await h.ledger.receive(request,scope());
    expect(third.items[0]!.state).toBe('ready');
    expect(h.fetched).toHaveLength(1);
    await expect(h.ledger.receive({...request,items:[await upload(h,PDF,'file')]},scope())).rejects.toThrow('(WORKROOM_ATTACH_RECEIVE_CONFLICT)');
    // Another owner never sees this job, even with the same receiveId.
    expect(()=>h.ledger.status(request.receiveId,scope({owner:OTHER_OWNER}))).toThrow('(WORKROOM_ATTACH_NOT_FOUND)');
    h.close();
  });

  test('a LAN owner is refused: attachments travel only over the internet connection', async () => {
    const h=harness();
    const png=await upload(h,PNG,'image');
    await expect(h.ledger.receive(receive([png]),scope({owner:'device:h1:lan:controller-9'}))).rejects.toThrow('(WORKROOM_ATTACH_INTERNET_ONLY)');
    await expect(h.ledger.receive(receive([png]),scope({owner:'local'}))).rejects.toThrow('(WORKROOM_ATTACH_INTERNET_ONLY)');
    await expect(h.ledger.receive(receive([png]),scope({targetId:'not-registered'}))).rejects.toThrow('(WORKROOM_ATTACH_TARGET_INVALID)');
    expect(h.fetched).toHaveLength(0);
    h.close();
  });
});

describe('bounds: every refusal comes before any download', () => {
  test('daily quota: 256 MiB of declared plaintext per owner per day, reserved at admission and never refunded', async () => {
    let fetches=0;
    const h=harness({fetch:async()=>{fetches++;throw new Error('offline');}});
    const big=()=>Array.from({length:5},()=>fakeItem(WORKROOM_REMOTE_ATTACHMENT_MAX_BYTES));
    for(let i=0;i<5;i++){await h.ledger.receive(receive(big()),scope());await h.ledger.idle();}
    const before=fetches;
    await expect(h.ledger.receive(receive(big()),scope())).rejects.toThrow('(WORKROOM_ATTACH_QUOTA)');
    expect(fetches).toBe(before);
    // Another owner has its own day; a new local day resets it.
    await h.ledger.receive(receive(big()),scope({owner:OTHER_OWNER}));await h.ledger.idle();
    h.advance(24*60*60*1000);
    await h.ledger.receive(receive(big()),scope());await h.ledger.idle();
    h.close();
  });

  test('live ids: at most 32 unconsumed per owner; host-wide 512 MiB; at most 2 downloading and 8 queued', async () => {
    const hang:((r:Response)=>void)[]=[];
    let fetches=0;
    const h=harness({fetch:()=>{fetches++;return new Promise<Response>(resolve=>hang.push(resolve));}});
    for(let i=0;i<6;i++)await h.ledger.receive(receive(Array.from({length:5},()=>fakeItem())),scope());
    const seen=fetches;
    await expect(h.ledger.receive(receive(Array.from({length:5},()=>fakeItem())),scope())).rejects.toThrow('(WORKROOM_ATTACH_LIVE_LIMIT)');
    expect(fetches).toBe(seen);
    // 4 more jobs (10 total) fill the queue; the 11th is busy.
    for(let i=0;i<4;i++)await h.ledger.receive(receive([fakeItem()]),scope({owner:OTHER_OWNER}));
    await expect(h.ledger.receive(receive([fakeItem()]),scope({owner:'device:h1:internet:controller-3'}))).rejects.toThrow('(WORKROOM_ATTACH_BUSY)');
    expect(fetches).toBe(seen);
    for(const resolve of hang.splice(0))resolve(new Response('gone',{status:404}));
    h.close();
  });

  test('host-wide: unconsumed bytes across owners stay under 512 MiB', async () => {
    const hang:((r:Response)=>void)[]=[];
    const h=harness({fetch:()=>new Promise<Response>(resolve=>hang.push(resolve))});
    const big=()=>Array.from({length:5},()=>fakeItem(WORKROOM_REMOTE_ATTACHMENT_MAX_BYTES));
    for(const owner of [OWNER,OTHER_OWNER])for(let i=0;i<5;i++)await h.ledger.receive(receive(big()),scope({owner}));
    await expect(h.ledger.receive(receive(big()),scope({owner:'device:h1:internet:controller-3'}))).rejects.toThrow('(WORKROOM_ATTACH_HOST_LIMIT)');
    for(const resolve of hang.splice(0))resolve(new Response('gone',{status:404}));
    h.close();
  });
});

describe('ids: owner and target bound, sixty minutes, unconsumed files deleted', () => {
  async function readyIds(h:ReturnType<typeof harness>,plains:{bytes:Uint8Array;kind:'image'|'file'}[]){
    const items=[];for(const p of plains)items.push(await upload(h,p.bytes,p.kind));
    const request=receive(items);await h.ledger.receive(request,scope());await h.ledger.idle();
    return h.ledger.status(request.receiveId,scope()).items.map(item=>(item as {id:string}).id);
  }

  test('check refuses another owner, another target, an expired or unknown id — with the words the composer shows', async () => {
    const h=harness();
    const [id]=await readyIds(h,[{bytes:PNG,kind:'image'}]);
    expect(()=>h.ledger.check([id!],{owner:OWNER,targetId:TARGET})).not.toThrow();
    expect(()=>h.ledger.check([id!],{owner:OTHER_OWNER,targetId:TARGET})).toThrow('첨부 1개를 찾을 수 없거나 만료되었습니다');
    expect(()=>h.ledger.check([id!],{owner:OWNER,targetId:'runtime-target-2'})).toThrow('다른 프로젝트용으로 넣은 첨부입니다');
    expect(()=>h.ledger.check(['wa_'+'Z'.repeat(32)],{owner:OWNER,targetId:TARGET})).toThrow('첨부 1개를 찾을 수 없거나 만료되었습니다');
    h.advance(WORKROOM_ATTACH_TTL_MS+1);
    expect(()=>h.ledger.check([id!],{owner:OWNER,targetId:TARGET})).toThrow('만료되었습니다');
    h.close();
  });

  test('expiry deletes an unconsumed file and keeps a consumed one; a pinned id is never swept', async () => {
    const h=harness();
    const [kept,dropped,pinned]=await readyIds(h,[{bytes:PNG,kind:'image'},{bytes:PDF,kind:'file'},{bytes:PNG,kind:'image'}]);
    const consumed=h.ledger.lease([kept!],{owner:OWNER,targetId:TARGET});const keptPath=consumed.images[0]!;consumed.consume();consumed.release();
    const peek=h.ledger.lease([dropped!],{owner:OWNER,targetId:TARGET});const droppedPath=peek.files[0]!;peek.release();
    const holding=h.ledger.lease([pinned!],{owner:OWNER,targetId:TARGET});const pinnedPath=holding.images[0]!;
    h.advance(WORKROOM_ATTACH_TTL_MS+1);h.ledger.sweep();
    expect(existsSync(keptPath)).toBe(true);
    expect(existsSync(droppedPath)).toBe(false);
    expect(existsSync(pinnedPath)).toBe(true);
    holding.recheck();holding.release();h.ledger.sweep();
    expect(existsSync(pinnedPath)).toBe(false);
    h.close();
  });

  test('a restart marks pending items interrupted, keeps ready ones, and never deletes a file outside its own folders', async () => {
    const hang:((r:Response)=>void)[]=[];
    const h=harness({fetch:()=>new Promise<Response>(resolve=>hang.push(resolve))});
    const pending=receive([fakeItem()]);
    await h.ledger.receive(pending,scope());
    h.close();
    const outside=join(app,'outside.txt');writeFileSync(outside,'keep me');
    // A tampered state file naming a file outside workroom-images/-files: the sweep must leave it alone.
    const statePath=join(app,WORKROOM_REMOTE_ATTACHMENT_STATE_FILE);
    const state=JSON.parse(readFileSync(statePath,'utf8'));
    state.jobs.push({receiveId:crypto.randomUUID(),owner:OWNER,targetId:TARGET,fingerprint:'f'.repeat(64),createdAt:START,
      items:[{state:'ready',kind:'file',bytes:7,id:'wa_'+'Q'.repeat(32),path:outside,readyAt:START,expiresAt:START+WORKROOM_ATTACH_TTL_MS,consumedAt:null,removed:true}]});
    writeFileSync(statePath,JSON.stringify(state),{mode:0o600});
    let clock=START+WORKROOM_ATTACH_TTL_MS+5;
    const next=new WorkroomRemoteAttachmentLedger({appDataDir:app,hostId:()=>HOST,supabaseUrl:()=>SUPABASE,transit:()=>null,
      resolveTarget:async()=>({cwd:app}),fetchImpl:(async()=>{throw new Error('no');}) as never,now:()=>clock,sweepIntervalMs:null});
    expect(existsSync(outside)).toBe(true);
    clock=START+1;
    expect(next.status(pending.receiveId,scope()).items[0]).toMatchObject({state:'failed',code:'WORKROOM_ATTACH_INTERRUPTED'});
    expect(statSync(statePath).mode&0o777).toBe(0o600);
    expect(readFileSync(statePath,'utf8')).not.toContain('signed-token');
    for(const resolve of hang.splice(0))resolve(new Response('gone',{status:404}));
    next.close();
  });

  test('the state file never holds a transit key or token', async () => {
    const h=harness();
    const png=await upload(h,PNG,'image');
    await h.ledger.receive(receive([png]),scope());
    const during=readFileSync(join(app,WORKROOM_REMOTE_ATTACHMENT_STATE_FILE),'utf8');
    await h.ledger.idle();
    const after=readFileSync(join(app,WORKROOM_REMOTE_ATTACHMENT_STATE_FILE),'utf8');
    for(const text of [during,after]){expect(text).not.toContain(png.key);expect(text).not.toContain(png.token);}
    h.close();
  });
});

describe('the declared size bounds the download (review w13: quota charged 1 byte for a 10 MiB pull)', () => {
  /** Serves the object in 1 KiB pieces and counts what the Mac actually pulled. */
  function streamed(h:ReturnType<typeof harness>,options:{contentLength?:boolean}={}){
    const served={bytes:0};
    const fetchImpl:Fetch=async url=>{
      const path=decodeURIComponent(new URL(url).pathname.split('/portmgr-voc-transit/')[1]!);
      const body=h.objects.get(path)!;let offset=0;
      const stream=new ReadableStream<Uint8Array>({pull(controller){
        if(offset>=body.byteLength){controller.close();return;}
        const piece=body.subarray(offset,offset+1024);offset+=piece.byteLength;served.bytes+=piece.byteLength;controller.enqueue(piece);
      }});
      return new Response(stream,options.contentLength?{headers:{'content-length':String(body.byteLength)}}:undefined);
    };
    return {served,fetchImpl};
  }

  test('an object far larger than its declared bytes is cut off after bytes + 28 and charged what it declared', async () => {
    let fetchImpl:Fetch=async()=>new Response('unused',{status:500});
    const h=harness({fetch:(url,init)=>fetchImpl(url,init)});
    const big=new Uint8Array(1024*1024).fill(7);
    const item={...await upload(h,big,'file'),bytes:1};
    const counter=streamed(h);fetchImpl=counter.fetchImpl;
    const request=receive([item]);
    await h.ledger.receive(request,scope());await h.ledger.idle();
    expect(h.ledger.status(request.receiveId,scope()).items[0]).toMatchObject({state:'failed',code:'WORKROOM_ATTACH_TOO_LARGE'});
    // At most the declared ciphertext (1 + 28) and the piece in which it ran over, plus what the stream queued ahead.
    expect(counter.served.bytes).toBeLessThanOrEqual(1+28+3*1024);
    expect(existsSync(join(app,'workroom-files'))).toBe(false);
    const usage=JSON.parse(readFileSync(join(app,WORKROOM_REMOTE_ATTACHMENT_STATE_FILE),'utf8')).usage[OWNER];
    expect(usage.bytes).toBe(1);
    h.close();
  });

  test('a content-length over the declared bytes is refused before the body is read', async () => {
    let fetchImpl:Fetch=async()=>new Response('unused',{status:500});
    const h=harness({fetch:(url,init)=>fetchImpl(url,init)});
    const item={...await upload(h,new Uint8Array(64*1024).fill(3),'file'),bytes:10};
    const counter=streamed(h,{contentLength:true});fetchImpl=counter.fetchImpl;
    const request=receive([item]);
    await h.ledger.receive(request,scope());await h.ledger.idle();
    expect(h.ledger.status(request.receiveId,scope()).items[0]).toMatchObject({state:'failed',code:'WORKROOM_ATTACH_TOO_LARGE'});
    expect(counter.served.bytes).toBeLessThanOrEqual(2*1024);
    h.close();
  });

  test('an honest declaration still downloads in full', async () => {
    let fetchImpl:Fetch=async()=>new Response('unused',{status:500});
    const h=harness({fetch:(url,init)=>fetchImpl(url,init)});
    const plain=new Uint8Array(200*1024).fill(9);
    const item=await upload(h,plain,'file');
    const counter=streamed(h,{contentLength:true});fetchImpl=counter.fetchImpl;
    const request=receive([item]);
    await h.ledger.receive(request,scope());await h.ledger.idle();
    expect(h.ledger.status(request.receiveId,scope()).items[0]).toMatchObject({state:'ready'});
    expect(counter.served.bytes).toBe(plain.byteLength+28);
    h.close();
  });
});

describe('single use, rebind and release (review w13: a second CLI with the same files; live ids grew with every project switch)', () => {
  async function ready(h:ReturnType<typeof harness>,plains:{bytes:Uint8Array;kind:'image'|'file'}[],owner=OWNER,targetId=TARGET){
    const items=[];for(const p of plains)items.push(await upload(h,p.bytes,p.kind));
    const request=receive(items);await h.ledger.receive(request,scope({owner,targetId}));await h.ledger.idle();
    return h.ledger.status(request.receiveId,scope({owner,targetId})).items.map(item=>(item as {id:string}).id);
  }

  test('a consumed id is single-use: a new request naming it is refused at begin and at the write', async () => {
    const h=harness();
    const [id]=await ready(h,[{bytes:PNG,kind:'image'}]);
    const lease=h.ledger.lease([id!],{owner:OWNER,targetId:TARGET});lease.consume();lease.release();
    expect(()=>h.ledger.check([id!],{owner:OWNER,targetId:TARGET})).toThrow('첨부 1개를 찾을 수 없거나 만료되었습니다');
    expect(()=>h.ledger.lease([id!],{owner:OWNER,targetId:TARGET})).toThrow('첨부 1개를 찾을 수 없거나 만료되었습니다');
    // Its file stays for the AI that got it (the 14-day prune removes it), and it no longer counts as live.
    h.close();
  });

  test('an id another request holds is not lent again; after that request it is gone, or lent again if it wrote nothing', async () => {
    const h=harness();
    const [id,other]=await ready(h,[{bytes:PNG,kind:'image'},{bytes:PDF,kind:'file'}]);
    // Two new requests at once both pass the begin check; only the first gets the lease.
    h.ledger.check([id!],{owner:OWNER,targetId:TARGET});h.ledger.check([id!],{owner:OWNER,targetId:TARGET});
    const first=h.ledger.lease([id!],{owner:OWNER,targetId:TARGET});
    expect(()=>h.ledger.lease([id!],{owner:OWNER,targetId:TARGET})).toThrow('다른 요청에서 쓰이는 중입니다');
    expect(()=>h.ledger.lease([other!,id!],{owner:OWNER,targetId:TARGET})).toThrow('다른 요청에서 쓰이는 중입니다');
    // A refused lease pins nothing: the other id is still free.
    const free=h.ledger.lease([other!],{owner:OWNER,targetId:TARGET});free.release();
    // The first wrote: the id is consumed and gone for everyone after it.
    first.recheck();first.consume();first.release();
    expect(()=>h.ledger.lease([id!],{owner:OWNER,targetId:TARGET})).toThrow('첨부 1개를 찾을 수 없거나 만료되었습니다');
    // A request that stopped before its write (released, not consumed) gives the id back.
    const stopped=h.ledger.lease([other!],{owner:OWNER,targetId:TARGET});stopped.release();
    const again=h.ledger.lease([other!],{owner:OWNER,targetId:TARGET});again.release();
    h.close();
  });

  test('rebind moves ready ids to another project: same id, no download, no quota; the old project refuses them', async () => {
    const h=harness();
    const [image,file]=await ready(h,[{bytes:PNG,kind:'image'},{bytes:PDF,kind:'file'}]);
    const fetches=h.fetched.length;
    const usage=()=>JSON.parse(readFileSync(join(app,WORKROOM_REMOTE_ATTACHMENT_STATE_FILE),'utf8')).usage[OWNER].bytes;
    const charged=usage();
    const answer=await h.ledger.rebind({receiveId:crypto.randomUUID(),ids:[image!,file!]},{owner:OWNER,targetId:'runtime-target-2'});
    expect(normalizeWorkroomAttachmentResult(answer)).toEqual(answer);
    expect(answer.items.map(item=>item.state==='ready'?item.id:item.state)).toEqual([image!,file!]);
    expect(h.fetched).toHaveLength(fetches);expect(usage()).toBe(charged);
    expect(()=>h.ledger.check([image!,file!],{owner:OWNER,targetId:'runtime-target-2'})).not.toThrow();
    expect(()=>h.ledger.check([image!],{owner:OWNER,targetId:TARGET})).toThrow('다른 프로젝트용으로 넣은 첨부입니다');
    // Back again: still the same ids. The binding survives a restart.
    await h.ledger.rebind({receiveId:crypto.randomUUID(),ids:[image!]},{owner:OWNER,targetId:TARGET});
    h.close();
    const next=new WorkroomRemoteAttachmentLedger({appDataDir:app,hostId:()=>HOST,supabaseUrl:()=>SUPABASE,transit:()=>null,
      resolveTarget:async()=>({cwd:app}),fetchImpl:(async()=>{throw new Error('no');}) as never,now:()=>START,sweepIntervalMs:null});
    expect(()=>next.check([image!],{owner:OWNER,targetId:TARGET})).not.toThrow();
    expect(()=>next.check([file!],{owner:OWNER,targetId:'runtime-target-2'})).not.toThrow();
    expect(()=>next.check([file!],{owner:OWNER,targetId:TARGET})).toThrow('다른 프로젝트용으로 넣은 첨부입니다');
    next.close();
  });

  test('rebind answers failed for another owner, an unknown, an expired or a consumed id, and refuses an unregistered project', async () => {
    const h=harness();
    const [a,b,c]=await ready(h,[{bytes:PNG,kind:'image'},{bytes:PDF,kind:'file'},{bytes:PNG,kind:'image'}]);
    const lease=h.ledger.lease([c!],{owner:OWNER,targetId:TARGET});lease.consume();lease.release();
    const other=await h.ledger.rebind({receiveId:crypto.randomUUID(),ids:[a!]},{owner:OTHER_OWNER,targetId:'runtime-target-2'});
    expect(other.items[0]).toMatchObject({state:'failed',code:'WORKROOM_ATTACH_NOT_FOUND'});
    const mixed=await h.ledger.rebind({receiveId:crypto.randomUUID(),ids:['wa_'+'Z'.repeat(32),c!,b!]},{owner:OWNER,targetId:'runtime-target-2'});
    expect(mixed.items.map(item=>item.state==='failed'?item.code:item.state)).toEqual(['WORKROOM_ATTACH_NOT_FOUND','WORKROOM_ATTACH_CONSUMED','ready']);
    await expect(h.ledger.rebind({receiveId:crypto.randomUUID(),ids:[a!]},{owner:OWNER,targetId:'not-registered'})).rejects.toThrow('(WORKROOM_ATTACH_TARGET_INVALID)');
    await expect(h.ledger.rebind({receiveId:crypto.randomUUID(),ids:[a!]},{owner:'device:h1:lan:controller-9',targetId:TARGET})).rejects.toThrow('(WORKROOM_ATTACH_INTERNET_ONLY)');
    h.advance(WORKROOM_ATTACH_TTL_MS+1);
    const late=await h.ledger.rebind({receiveId:crypto.randomUUID(),ids:[a!]},{owner:OWNER,targetId:'runtime-target-2'});
    expect(late.items[0]).toMatchObject({state:'failed'});
    h.close();
  });

  test('release deletes an unconsumed file and frees its live slot; a consumed, pinned or foreign id is left alone', async () => {
    const h=harness();
    // 31 ready, unconsumed ids: one more fits under the 32-id cap, two do not.
    for(let i=0;i<6;i++)await ready(h,Array.from({length:5},()=>({bytes:PDF,kind:'file' as const})));
    const [one]=await ready(h,[{bytes:PDF,kind:'file'}]);
    const two=async()=>receive([await upload(h,PDF,'file'),await upload(h,PDF,'file')]);
    await expect(h.ledger.receive(await two(),scope())).rejects.toThrow('(WORKROOM_ATTACH_LIVE_LIMIT)');
    const peek=h.ledger.lease([one!],{owner:OWNER,targetId:TARGET});const path=peek.files[0]!;
    // Pinned (a write in progress): not released.
    h.ledger.release({receiveId:crypto.randomUUID(),ids:[one!]},{owner:OWNER});
    expect(existsSync(path)).toBe(true);
    peek.release();
    // Another owner cannot release it.
    h.ledger.release({receiveId:crypto.randomUUID(),ids:[one!]},{owner:OTHER_OWNER});
    expect(existsSync(path)).toBe(true);
    const answer=h.ledger.release({receiveId:crypto.randomUUID(),ids:[one!]},{owner:OWNER});
    expect(normalizeWorkroomAttachmentResult(answer).items[0]).toMatchObject({state:'failed',code:'WORKROOM_ATTACH_RELEASED'});
    expect(existsSync(path)).toBe(false);
    expect(()=>h.ledger.check([one!],{owner:OWNER,targetId:TARGET})).toThrow('찾을 수 없거나 만료되었습니다');
    // The freed slot takes the two that did not fit.
    await h.ledger.receive(await two(),scope());await h.ledger.idle();
    h.close();
  });

  test('a consumed id is not released (its file is the AI\'s now)', async () => {
    const h=harness();
    const [id]=await ready(h,[{bytes:PDF,kind:'file'}]);
    const lease=h.ledger.lease([id!],{owner:OWNER,targetId:TARGET});const path=lease.files[0]!;lease.consume();lease.release();
    h.ledger.release({receiveId:crypto.randomUUID(),ids:[id!]},{owner:OWNER});
    expect(existsSync(path)).toBe(true);
    h.close();
  });
});
