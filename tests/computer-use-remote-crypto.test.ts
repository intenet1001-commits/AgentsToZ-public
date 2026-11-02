import {PGlite} from '@electric-sql/pglite';
import {afterAll,beforeAll,describe,expect,test} from 'bun:test';
import {
  COMPUTER_USE_REMOTE_REPLY_BOX_MAX_CHARS,
  COMPUTER_USE_REMOTE_REPLY_MEMORY_MS,
  ComputerUseRemoteChannel,
  ComputerUseRemoteCryptoError,
  computerUseRemoteAad,
  computerUseRemoteCallReplyBody,
  computerUseRemoteNonce,
  decodeComputerUseRemoteBox,
  decodeComputerUseRemoteFrame,
  encodeComputerUseRemoteBox,
  encodeComputerUseRemoteFrame,
  generateComputerUseRemoteKeyPair,
  joinComputerUseRemoteBox,
  normalizeComputerUseRemoteBinding,
  splitComputerUseRemoteBox,
  type ComputerUseRemoteBinding,
  type ComputerUseRemoteSealHeader,
} from '../src/computerUseRemoteCrypto';
import {
  COMPUTER_USE_REMOTE_LIMITS,
  COMPUTER_USE_REMOTE_REPLY_FRAME_MAX_BYTES,
  COMPUTER_USE_REMOTE_REQUEST_BOX_MAX_CHARS,
  computerUseRemotePartMatches,
  computerUseRemotePartRequest,
  parseComputerUseRemoteEnvelope,
  parseComputerUseRemoteReply,
} from '../src/computerUseRemoteProtocol';
import {generateRemoteControlRelayKeyPair} from '../src/remoteControlRelayCrypto';

const A='11111111-1111-4111-8111-111111111111';
const B='22222222-2222-4222-8222-222222222222';
const C='33333333-3333-4333-8333-333333333333';
const binding:ComputerUseRemoteBinding={session:'0123456789abcdef0123456789abcdef',senderDeviceId:A,receiverDeviceId:B,
  instance:'fedcba9876543210fedcba9876543210',platform:'darwin'};
const sentAt=1_700_000_000_000;
const call=(seq:number,op:ComputerUseRemoteSealHeader['op']='call'):ComputerUseRemoteSealHeader=>({op,seq,sentAt:sentAt+seq});

async function pair(receiverBinding:Partial<ComputerUseRemoteBinding>={},clock?:()=>number){
  const a=await generateComputerUseRemoteKeyPair(),b=await generateComputerUseRemoteKeyPair();
  const sender=await ComputerUseRemoteChannel.establish({side:'sender',privateKey:a.keyPair.privateKey,peerPublicKey:b.publicKey,binding,clock});
  const receiver=await ComputerUseRemoteChannel.establish({side:'receiver',privateKey:b.keyPair.privateKey,peerPublicKey:a.publicKey,
    binding:{...binding,...receiverBinding}});
  return {sender,receiver,a,b};
}
async function code(work:Promise<unknown>|(()=>unknown)):Promise<string|null>{
  try{await (typeof work==='function'?work():work);return null;}
  catch(error){expect(error).toBeInstanceOf(ComputerUseRemoteCryptoError);return (error as ComputerUseRemoteCryptoError).code;}
}
/** Change one base64 character in the middle to another valid one, keeping the box canonical. */
function tamper(box:string){const index=Math.floor(box.length/2);return box.slice(0,index)+(box[index]==='A'?'B':'A')+box.slice(index+1);}
/** A meta object whose JSON is exactly `bytes` long. */
function metaOf(bytes:number):Record<string,unknown>{
  const base=JSON.stringify({pad:''}).length;
  return {pad:'x'.repeat(bytes-base)};
}
function bytesOf(length:number,seed=7){
  const bytes=new Uint8Array(length);let x=seed;
  for(let i=0;i<length;i+=1){x=(x*1103515245+12345)>>>0;bytes[i]=x>>>24;}
  return bytes;
}

// The mailbox table's own checks measure octet_length(<jsonb>::text) — jsonb's text form adds spaces, so measure it there.
let db:PGlite;
beforeAll(async()=>{db=new PGlite();});
afterAll(async()=>{await db.close();});
async function jsonbBytes(value:unknown){
  const result=await db.query<{n:number}>('select octet_length($1::jsonb::text) as n',[JSON.stringify(value)]);
  return Number(result.rows[0]!.n);
}

describe('computer-use remote sealing',()=>{
  test('a call, its reply with an attachment, and the background ops round-trip',async()=>{
    const {sender,receiver}=await pair();
    const box=await sender.sealRequest(call(1),{operation:'scope-status',client:'Claude Code',host:'Terminal'});
    const envelope=parseComputerUseRemoteEnvelope({kind:'computer-use',v:1,op:'call',session:binding.session,seq:1,sentAt:sentAt+1,box});
    expect(envelope.op).toBe('call');
    expect(box).not.toContain('scope-status');
    expect(await receiver.openRequest(call(1),box)).toEqual({meta:{operation:'scope-status',client:'Claude Code',host:'Terminal'}});
    expect(receiver.lastRequestSeq).toBe(1);
    const jpeg=bytesOf(1000);
    const reply=await receiver.sealReply(call(1),{success:true,observationId:'o-1'},jpeg);
    const opened=await sender.openReply(call(1),reply);
    expect(opened.meta).toEqual({success:true,observationId:'o-1'});
    expect(opened.attachment).toEqual(jpeg);
    for(const [seq,op] of [[2,'heartbeat'],[3,'disconnect']] as const){
      const sealed=await sender.sealRequest(call(seq,op),{});
      expect((await receiver.openRequest(call(seq,op),sealed)).meta).toEqual({});
      expect((await sender.openReply(call(seq,op),await receiver.sealReply(call(seq,op),{}))).attachment).toBeNull();
    }
  });
  test('a tampered box does not open and does not burn the sequence',async()=>{
    const {sender,receiver}=await pair();
    const box=await sender.sealRequest(call(1),{operation:'scope-observe'});
    expect(await code(receiver.openRequest(call(1),tamper(box)))).toBe('DECRYPTION_FAILED');
    expect(receiver.lastRequestSeq).toBe(0);
    expect((await receiver.openRequest(call(1),box)).meta).toEqual({operation:'scope-observe'});
    const reply=await receiver.sealReply(call(1),{ok:1});
    expect(await code(sender.openReply(call(1),tamper(reply)))).toBe('DECRYPTION_FAILED');
    // The reply stays awaited: a damaged part is fetched again and the true reply still opens.
    expect((await sender.openReply(call(1),reply)).meta).toEqual({ok:1});
  });
  test('the AAD binds seq, sentAt and op',async()=>{
    const {sender,receiver}=await pair();
    const box=await sender.sealRequest(call(5),{operation:'scope-key'});
    expect(await code(receiver.openRequest({op:'call',seq:5,sentAt:sentAt+6},box))).toBe('DECRYPTION_FAILED');
    expect(await code(receiver.openRequest({op:'heartbeat',seq:5,sentAt:sentAt+5},box))).toBe('DECRYPTION_FAILED');
    expect(await code(receiver.openRequest({op:'call',seq:6,sentAt:sentAt+5},box))).toBe('DECRYPTION_FAILED');
    expect((await receiver.openRequest(call(5),box)).meta).toEqual({operation:'scope-key'});
    // A reply answers exactly that request.
    const reply=await receiver.sealReply(call(5),{answer:5});
    expect(await code(sender.openReply({op:'call',seq:5,sentAt:sentAt+4},reply))).toBe('DECRYPTION_FAILED');
    expect(computerUseRemoteAad(binding,call(5))).toBe(`v1|${binding.session}|5|${sentAt+5}|${A}|${B}|${binding.instance}|darwin|call`);
  });
  test('a box moved to another device\'s row, another connection, session or platform does not open',async()=>{
    for(const changed of [{senderDeviceId:C},{receiverDeviceId:C},{instance:'00000000000000000000000000000000'},
      {session:'ffffffffffffffffffffffffffffffff'},{platform:'other' as const}]){
      const {sender,receiver}=await pair(changed);
      const box=await sender.sealRequest(call(1),{operation:'scope-click'});
      expect(await code(receiver.openRequest(call(1),box))).toBe('DECRYPTION_FAILED');
      expect(receiver.lastRequestSeq).toBe(0);
    }
  });
  test('a replayed or reordered request is refused',async()=>{
    const {sender,receiver}=await pair();
    const one=await sender.sealRequest(call(1),{n:1}),two=await sender.sealRequest(call(2),{n:2});
    expect((await receiver.openRequest(call(2),two)).meta).toEqual({n:2});
    expect(await code(receiver.openRequest(call(1),one))).toBe('REPLAY');
    expect(await code(receiver.openRequest(call(2),two))).toBe('REPLAY');
    // The same box opened twice at once: only one wins.
    const three=await sender.sealRequest(call(3),{n:3});
    const results=await Promise.allSettled([receiver.openRequest(call(3),three),receiver.openRequest(call(3),three)]);
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    expect(((results.find(result=>result.status==='rejected') as PromiseRejectedResult).reason as ComputerUseRemoteCryptoError).code).toBe('REPLAY');
    // A reply opens once, and only for a request this channel sealed.
    const reply=await receiver.sealReply(call(2),{});
    expect((await sender.openReply(call(2),reply)).meta).toEqual({});
    expect(await code(sender.openReply(call(2),reply))).toBe('REPLAY');
    expect(await code(sender.openReply(call(9),reply))).toBe('REPLAY');
  });
  test('a nonce is never used twice',async()=>{
    const {sender,receiver}=await pair();
    await sender.sealRequest(call(4),{});
    expect(await code(sender.sealRequest(call(4),{}))).toBe('NONCE_REUSE');
    expect(await code(sender.sealRequest(call(3),{}))).toBe('NONCE_REUSE');
    const concurrent=await Promise.allSettled([sender.sealRequest(call(5),{a:1}),sender.sealRequest(call(5),{a:2})]);
    expect(concurrent.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    const box=await sender.sealRequest(call(6),{});
    await receiver.openRequest(call(6),box);
    await receiver.sealReply(call(6),{});
    expect(await code(receiver.sealReply(call(6),{}))).toBe('NONCE_REUSE');
    expect(await code(receiver.sealReply(call(7),{}))).toBe('NONCE_REUSE');
    const tags=[computerUseRemoteNonce('a2b',1),computerUseRemoteNonce('b2a',1)];
    expect(tags[0]).not.toEqual(tags[1]);
    expect(Array.from(computerUseRemoteNonce('a2b',Number.MAX_SAFE_INTEGER).subarray(4))).toEqual([0x00,0x1f,0xff,0xff,0xff,0xff,0xff,0xff]);
    expect(Array.from(computerUseRemoteNonce('b2a',0x1_0000_0002).subarray(4))).toEqual([0,0,0,1,0,0,0,2]);
    expect(await code(()=>computerUseRemoteNonce('a2b',0))).toBe('INVALID_HEADER');
  });
  test('one direction cannot open the other, and each side keeps to its own role',async()=>{
    const {sender,receiver}=await pair();
    const request=await sender.sealRequest(call(1),{x:1});
    await receiver.openRequest(call(1),request);
    const reply=await receiver.sealReply(call(1),{x:1});
    // A reply reflected back as a request uses the other direction's key.
    expect(await code(receiver.openRequest(call(2),reply))).toBe('DECRYPTION_FAILED');
    expect(await code(sender.openRequest(call(1),request))).toBe('WRONG_SIDE');
    expect(await code(sender.sealReply(call(1),{}))).toBe('WRONG_SIDE');
    expect(await code(receiver.sealRequest(call(9),{}))).toBe('WRONG_SIDE');
    expect(await code(receiver.openReply(call(1),reply))).toBe('WRONG_SIDE');
  });
  test('bindings, headers and keys are checked',async()=>{
    expect(await code(()=>normalizeComputerUseRemoteBinding({...binding,receiverDeviceId:A}))).toBe('INVALID_BINDING');
    expect(await code(()=>normalizeComputerUseRemoteBinding({...binding,session:'xyz'}))).toBe('INVALID_BINDING');
    expect(await code(()=>normalizeComputerUseRemoteBinding({...binding,platform:'linux' as never}))).toBe('INVALID_BINDING');
    expect(normalizeComputerUseRemoteBinding({...binding,senderDeviceId:A.toUpperCase()}).senderDeviceId).toBe(A);
    const {sender}=await pair();
    expect(await code(sender.sealRequest({op:'part' as never,seq:1,sentAt},{}))).toBe('INVALID_HEADER');
    expect(await code(sender.sealRequest({op:'call',seq:0,sentAt},{}))).toBe('INVALID_HEADER');
    expect(await code(sender.sealRequest({op:'call',seq:1,sentAt:0},{}))).toBe('INVALID_HEADER');
    const a=await generateComputerUseRemoteKeyPair();
    expect(await code(ComputerUseRemoteChannel.establish({side:'sender',privateKey:a.keyPair.privateKey,peerPublicKey:'AAAA',binding}))).toBe('INVALID_PUBLIC_KEY');
  });
  test('a key pair establishes one channel only, so no (key, nonce) pair repeats across channels',async()=>{
    const a=await generateComputerUseRemoteKeyPair(),b=await generateComputerUseRemoteKeyPair();
    const establish=(privateKey:CryptoKey,peerPublicKey:string,side:'sender'|'receiver'='sender',bound:ComputerUseRemoteBinding=binding)=>
      ComputerUseRemoteChannel.establish({side,privateKey,peerPublicKey,binding:bound});
    const sender=await establish(a.keyPair.privateKey,b.publicKey);
    // The review's reproduction: a second channel from the same keys and binding would derive the same key and seal seq 1
    // again — the XOR of the two ciphertexts is the XOR of the two texts. It is never built.
    expect(await code(establish(a.keyPair.privateKey,b.publicKey))).toBe('KEY_NOT_FRESH');
    expect(await code(establish(a.keyPair.privateKey,b.publicKey,'receiver',{...binding,session:'f'.repeat(32)}))).toBe('KEY_NOT_FRESH');
    // A clone is a new CryptoKey object of the same key; a key this module did not generate is not fresh either.
    const c=await generateComputerUseRemoteKeyPair();
    expect(await code(establish(structuredClone(c.keyPair.privateKey),b.publicKey))).toBe('KEY_NOT_FRESH');
    expect(await code(establish((await generateRemoteControlRelayKeyPair()).privateKey,b.publicKey))).toBe('KEY_NOT_FRESH');
    expect(await code(establish(undefined as never,b.publicKey))).toBe('KEY_NOT_FRESH');
    // Two attempts at once with one fresh key: exactly one gets it.
    const both=await Promise.allSettled([establish(c.keyPair.privateKey,b.publicKey),establish(c.keyPair.privateKey,b.publicKey)]);
    expect(both.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    expect(((both.find(result=>result.status==='rejected') as PromiseRejectedResult).reason as ComputerUseRemoteCryptoError).code).toBe('KEY_NOT_FRESH');
    // A failed attempt uses the key up as well: a retried hello makes a new pair.
    const d=await generateComputerUseRemoteKeyPair();
    expect(await code(establish(d.keyPair.privateKey,'AAAA'))).toBe('INVALID_PUBLIC_KEY');
    expect(await code(establish(d.keyPair.privateKey,b.publicKey))).toBe('KEY_NOT_FRESH');
    // The receiver's side is the same: a second channel there would restart its replay counter at 0.
    const receiver=await establish(b.keyPair.privateKey,a.publicKey,'receiver');
    expect(await code(establish(b.keyPair.privateKey,a.publicKey,'receiver'))).toBe('KEY_NOT_FRESH');
    // The one channel each side holds works.
    const box=await sender.sealRequest(call(1),{n:1});
    expect((await receiver.openRequest(call(1),box)).meta).toEqual({n:1});
  });
  test('a late answer still opens after many newer requests, for the session\'s late-answer memory',async()=>{
    expect(COMPUTER_USE_REMOTE_REPLY_MEMORY_MS).toBe(COMPUTER_USE_REMOTE_LIMITS.lateAnswerMemoryMs);
    let now=sentAt;
    const {sender,receiver}=await pair({},()=>now);
    const late=await sender.sealRequest(call(1),{operation:'scope-click',requestId:'click-0001'});
    await receiver.openRequest(call(1),late);
    const reply=await receiver.sealReply(call(1),{success:true});
    // The call timed out on A and its answer is recovered later; meanwhile heavy use seals far more than 256 requests
    // that stay unopened (the old count bound) inside the memory.
    for(let seq=2;seq<=600;seq+=1){now+=900;await sender.sealRequest(call(seq),{});}
    expect(now-sentAt).toBeLessThan(COMPUTER_USE_REMOTE_REPLY_MEMORY_MS);
    expect((await sender.openReply(call(1),reply)).meta).toEqual({success:true});
    // The memory is by age: a reply sealed for a request older than it is forgotten (fails safe — the input stays unknown).
    const t0=now;
    const old=await sender.sealRequest(call(601),{}),kept=await sender.sealRequest(call(602),{});
    await receiver.openRequest(call(601),old);await receiver.openRequest(call(602),kept);
    const oldReply=await receiver.sealReply(call(601),{n:601}),keptReply=await receiver.sealReply(call(602),{n:602});
    now=t0+COMPUTER_USE_REMOTE_REPLY_MEMORY_MS;await sender.sealRequest(call(603),{});
    expect((await sender.openReply(call(602),keptReply)).meta).toEqual({n:602});
    now+=1;await sender.sealRequest(call(604),{});
    expect(await code(sender.openReply(call(601),oldReply))).toBe('REPLAY');
  });
});

describe('frames and size',()=>{
  test('a request frame is at most 16,000 bytes, has no attachment and fits the mailbox request check',async()=>{
    const {sender,receiver}=await pair();
    expect(await code(sender.sealRequest(call(1),metaOf(COMPUTER_USE_REMOTE_LIMITS.requestFrameMaxBytes-4+1)))).toBe('FRAME_TOO_LARGE');
    const meta=metaOf(COMPUTER_USE_REMOTE_LIMITS.requestFrameMaxBytes-4);
    const box=await sender.sealRequest(call(2),meta);
    expect(box.length).toBe(COMPUTER_USE_REMOTE_REQUEST_BOX_MAX_CHARS);
    const envelope={kind:'computer-use',v:1,op:'call',session:binding.session,seq:2,sentAt:sentAt+2,box};
    expect(parseComputerUseRemoteEnvelope(envelope).op).toBe('call');
    expect(await jsonbBytes(envelope)).toBeLessThanOrEqual(COMPUTER_USE_REMOTE_LIMITS.mailboxRequestMaxBytes);
    expect((await receiver.openRequest(call(2),box)).meta).toEqual(meta);
  });
  test('frames refuse oversized parts and malformed content',async()=>{
    expect(await code(()=>encodeComputerUseRemoteFrame(metaOf(COMPUTER_USE_REMOTE_LIMITS.metaMaxBytes+1)))).toBe('FRAME_TOO_LARGE');
    expect(await code(()=>encodeComputerUseRemoteFrame({},new Uint8Array(COMPUTER_USE_REMOTE_LIMITS.attachmentMaxBytes+1)))).toBe('FRAME_TOO_LARGE');
    expect(await code(()=>encodeComputerUseRemoteFrame([] as never))).toBe('FRAME_INVALID');
    const options={maxBytes:COMPUTER_USE_REMOTE_REPLY_FRAME_MAX_BYTES,allowAttachment:true};
    const frame=encodeComputerUseRemoteFrame({a:1},Uint8Array.of(1,2,3));
    expect(decodeComputerUseRemoteFrame(frame,options)).toEqual({meta:{a:1},attachment:Uint8Array.of(1,2,3)});
    expect(await code(()=>decodeComputerUseRemoteFrame(frame,{...options,allowAttachment:false}))).toBe('FRAME_INVALID');
    const lying=frame.slice();new DataView(lying.buffer).setUint32(0,COMPUTER_USE_REMOTE_LIMITS.metaMaxBytes+1);
    expect(await code(()=>decodeComputerUseRemoteFrame(lying,options))).toBe('FRAME_INVALID');
    const past=frame.slice();new DataView(past.buffer).setUint32(0,frame.byteLength);
    expect(await code(()=>decodeComputerUseRemoteFrame(past,options))).toBe('FRAME_INVALID');
    const array=new TextEncoder().encode('[1]'),arrayFrame=new Uint8Array(4+array.byteLength);
    new DataView(arrayFrame.buffer).setUint32(0,array.byteLength);arrayFrame.set(array,4);
    expect(await code(()=>decodeComputerUseRemoteFrame(arrayFrame,options))).toBe('FRAME_INVALID');
    const badUtf8=Uint8Array.of(0,0,0,4,0x7b,0xff,0xfe,0x7d);
    expect(await code(()=>decodeComputerUseRemoteFrame(badUtf8,options))).toBe('FRAME_INVALID');
    expect(await code(()=>decodeComputerUseRemoteFrame(Uint8Array.of(0,0),options))).toBe('FRAME_INVALID');
  });
  test('boxes are canonical padded base64',async()=>{
    expect(encodeComputerUseRemoteBox(Uint8Array.of(1,2,3,4))).toBe('AQIDBA==');
    expect(decodeComputerUseRemoteBox('A'.repeat(24))).toEqual(new Uint8Array(18));
    expect(await code(()=>decodeComputerUseRemoteBox('AQIDBB=='.padStart(24,'A')))).toBe('INVALID_BOX');
    expect(await code(()=>decodeComputerUseRemoteBox('A'.repeat(24).replace(/A$/,'-')))).toBe('INVALID_BOX');
  });
  test('the worst reply (meta 60 KB + JPEG 240,000 bytes) is two parts, each inside the mailbox response check',async()=>{
    const {sender,receiver}=await pair();
    const request=await sender.sealRequest(call(1),{operation:'scope-observe',grant:'g'.repeat(64),epoch:1,capture:true});
    await receiver.openRequest(call(1),request);
    const meta=metaOf(COMPUTER_USE_REMOTE_LIMITS.metaMaxBytes),jpeg=bytesOf(COMPUTER_USE_REMOTE_LIMITS.attachmentMaxBytes);
    expect(encodeComputerUseRemoteFrame(meta,jpeg).byteLength).toBe(300_004);
    const box=await receiver.sealReply(call(1),meta,jpeg);
    expect(box.length).toBe(400_028);
    expect(COMPUTER_USE_REMOTE_REPLY_BOX_MAX_CHARS).toBe(400_028);
    const ref='abcdefabcdefabcdefabcdefabcdefab';
    const {body,rest}=computerUseRemoteCallReplyBody(box,ref);
    expect(body).toMatchObject({v:1,parts:2,ref});
    expect(body.box.length).toBe(210_000);
    expect(rest!.length).toBe(190_028);
    const first={ok:true,body},second={ok:true,body:{v:1,box:rest}};
    expect(await jsonbBytes(first)).toBeLessThanOrEqual(COMPUTER_USE_REMOTE_LIMITS.mailboxResponseMaxBytes);
    expect(await jsonbBytes(second)).toBeLessThanOrEqual(COMPUTER_USE_REMOTE_LIMITS.mailboxResponseMaxBytes);
    // The sender reads both answers through the closed reply parser, joins and opens them once.
    const callReply=parseComputerUseRemoteReply('call',body),partReply=parseComputerUseRemoteReply('part',second.body);
    expect(callReply.parts).toBe(2);
    expect(await code(sender.openReply(call(1),joinComputerUseRemoteBox([callReply.box,tamper(partReply.box)])))).toBe('DECRYPTION_FAILED');
    const opened=await sender.openReply(call(1),joinComputerUseRemoteBox([callReply.box,partReply.box]));
    expect(opened.meta).toEqual(meta);
    expect(opened.attachment).toEqual(jpeg);
    // One byte more of attachment or meta does not fit the frame at all.
    expect(await code(()=>encodeComputerUseRemoteFrame(meta,bytesOf(COMPUTER_USE_REMOTE_LIMITS.attachmentMaxBytes+1)))).toBe('FRAME_TOO_LARGE');
  });
  test('a part carries its call\'s seq, is matched on session, seq and ref, and never moves either side\'s sequence',async()=>{
    const {sender,receiver}=await pair();
    const request=await sender.sealRequest(call(1),{operation:'scope-observe',capture:true});
    await receiver.openRequest(call(1),request);
    const jpeg=bytesOf(200_000);
    const {body,rest}=computerUseRemoteCallReplyBody(await receiver.sealReply(call(1),{success:true},jpeg));
    if(body.parts!==2||rest===null)throw new Error('expected a split reply');
    // B caches the rest under the call it answered; A asks for it with that call's seq, not a new one.
    const cached={session:binding.session,seq:1,ref:body.ref};
    const part=computerUseRemotePartRequest({session:binding.session,seq:1},body.ref,sentAt+700);
    expect(part).toEqual({kind:'computer-use',v:1,op:'part',session:binding.session,seq:1,sentAt:sentAt+700,ref:body.ref,index:1});
    const received=parseComputerUseRemoteEnvelope(structuredClone(part));
    if(received.op!=='part')throw new Error('expected a part envelope');
    // Its seq equals the receiver's lastRequestSeq rather than exceeding it, and that is right: a part orders nothing.
    expect(received.seq).toBe(receiver.lastRequestSeq);
    expect(computerUseRemotePartMatches(received,cached)).toBe(true);
    for(const other of [{...cached,seq:2},{...cached,ref:'0'.repeat(32)},{...cached,session:'f'.repeat(32)}])
      expect(computerUseRemotePartMatches(received,other)).toBe(false);
    expect(receiver.lastRequestSeq).toBe(1);
    // A opens the joined reply under the call's own header, then seals its next request at the next seq — no gap.
    const opened=await sender.openReply(call(1),joinComputerUseRemoteBox([body.box,parseComputerUseRemoteReply('part',{v:1,box:rest}).box]));
    expect(opened.attachment).toEqual(jpeg);
    const next=await sender.sealRequest(call(2),{operation:'scope-status'});
    expect((await receiver.openRequest(call(2),next)).meta).toEqual({operation:'scope-status'});
  });
  test('a reply that fits one part is sent whole',async()=>{
    const {body,rest}=computerUseRemoteCallReplyBody('A'.repeat(32));
    expect(body).toEqual({v:1,box:'A'.repeat(32),parts:1});
    expect(rest).toBeNull();
    expect(parseComputerUseRemoteReply('call',body)).toEqual(body);
    expect(splitComputerUseRemoteBox('A'.repeat(COMPUTER_USE_REMOTE_LIMITS.partMaxChars))).toHaveLength(1);
    expect(splitComputerUseRemoteBox('A'.repeat(COMPUTER_USE_REMOTE_LIMITS.partMaxChars+4))).toHaveLength(2);
  });
  test('parts are joined only in the shape they were split in',async()=>{
    const max=COMPUTER_USE_REMOTE_LIMITS.partMaxChars;
    expect(joinComputerUseRemoteBox(['A'.repeat(max),'AAA='])).toBe('A'.repeat(max)+'AAA=');
    expect(await code(()=>joinComputerUseRemoteBox(['A'.repeat(max-4),'AAAA']))).toBe('PARTS_INVALID');
    expect(await code(()=>joinComputerUseRemoteBox(['A'.repeat(max),'AAAA','AAAA']))).toBe('PARTS_INVALID');
    expect(await code(()=>joinComputerUseRemoteBox([]))).toBe('PARTS_INVALID');
    expect(await code(()=>joinComputerUseRemoteBox(['A'.repeat(max)+'AAAA']))).toBe('PARTS_INVALID');
    expect(await code(()=>splitComputerUseRemoteBox('A'.repeat(2*max+4)))).toBe('PARTS_INVALID');
    expect(await code(()=>computerUseRemoteCallReplyBody('A'.repeat(32),'not-a-ref'))).toBe('PARTS_INVALID');
  });
});
