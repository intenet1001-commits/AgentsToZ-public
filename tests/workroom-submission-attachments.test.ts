import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync,chmodSync,mkdirSync,writeFileSync,symlinkSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkroomConversationJournal} from '../src/workroomConversationJournal';
import {submitWorkroomDraft} from '../src/workroomSubmissionClient';
import {AiTerminalService} from '../src/aiTerminalService';
import type {AiTerminalRequest} from '../src/aiTerminalProtocol';
import {workroomImageMessage,splitWorkroomAttachmentBlock,withSuffixBeforeWorkroomAttachments} from '../src/workroomImageAttachments';
import {assertWorkroomImageAttachments,WORKROOM_IMAGE_DIR} from '../src/workroomImages';
import {assertWorkroomFileAttachments} from '../src/workroomFiles';
import {workroomAttachmentMessage} from '../src/workroomImageAttachments';

/** Image paths are the last lines of a request; nothing the host adds may land on one of them. */
const cleanups:(()=>Promise<void>|void)[]=[];
afterEach(async()=>{for(const c of cleanups.splice(0).reverse())await c();});
const PNG=Uint8Array.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0]);
function fixture(options:{corrections?:ConstructorParameters<typeof AiTerminalService>[0]['corrections']}={}){
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'submission-images-')));chmodSync(dir,0o700);
 const app=join(dir,'app');mkdirSync(app,{mode:0o700});const ref=join(dir,'reference');mkdirSync(ref);
 const day=join(app,WORKROOM_IMAGE_DIR,'2026-10-15');mkdirSync(day,{recursive:true,mode:0o700});
 const image=(name:string)=>{const path=join(day,name);writeFileSync(path,PNG,{mode:0o600});return path;};
 const store=new WorkroomConversationJournal(app);
 let finish!:(code:number)=>void;let exit:()=>void=()=>{};let output:(data:Uint8Array)=>void=()=>{};const writes:string[]=[];
 const service=new AiTerminalService({submissions:()=>store,...(options.corrections?{corrections:options.corrections}:{}),submissionAttachments:(paths,files=[])=>{if(paths.length)assertWorkroomImageAttachments(app,paths);if(files.length)assertWorkroomFileAttachments(files);},
  resolveTarget:async id=>({cwd:id==='reference-project'?ref:dir}),executable:()=>'/fixture/harmless',signalGroup:()=>{exit();finish(0);},
  spawn:(_args,options)=>{const t=options.terminal as {exit():void;data(pty:unknown,data:Uint8Array):void};exit=t.exit;output=data=>t.data(null,data);return{pid:999999999,exited:new Promise<number>(resolve=>{finish=resolve;}),kill:()=>{},terminal:{write:(text:string)=>{writes.push(text);return Buffer.byteLength(text);},resize:()=>{},close:()=>{exit();finish(0);}}};}});
 cleanups.push(()=>rmSync(dir,{recursive:true,force:true}),()=>store.close(),()=>service.shutdown());
 const perform=(r:Omit<AiTerminalRequest,'requestId'>,authority?:any)=>service.perform({...r,requestId:crypto.randomUUID()},authority);
 // The CLI turns on bracketed paste, as Claude Code and Codex do, so a multi-line request can be submitted.
 const start=async()=>{const session=(await perform({operation:'start',targetId:'fixture-project',agent:'hermes',cols:80,rows:24})).session!;output(new TextEncoder().encode('\x1b[?2004hready\r\n'));await Bun.sleep(50);return session;};
 return {app,day,image,service,writes,perform,start,store};
}
const pathLines=(text:string,paths:readonly string[])=>text.split('\n').map(line=>line.replace(/\r$/,'')).filter(line=>paths.some(p=>line.includes(p)));
// What reached the terminal, without the bracketed-paste markers around a multi-line body.
const typed=(writes:string[])=>writes.join('').replace(/\x1b\[20[01]~/g,'');

test('the attachment block is recognised only when it is exactly what the composer wrote',()=>{
 const paths=['/a/1.png','/a/2.png'];
 expect(splitWorkroomAttachmentBlock(workroomImageMessage('요청',paths))).toEqual({text:'요청',paths});
 expect(splitWorkroomAttachmentBlock(workroomImageMessage('',paths))).toEqual({text:'',paths});
 expect(splitWorkroomAttachmentBlock('요청')).toBeNull();
 expect(splitWorkroomAttachmentBlock('요청\n\n[첨부 이미지 3개 — 각 파일을 열어 확인하세요]\n/a/1.png\n/a/2.png')).toBeNull();
 for(const text of ['요청',''])for(const enter of ['','\r']){
  const out=withSuffixBeforeWorkroomAttachments(workroomImageMessage(text,paths)+enter,' (참고)');
  expect(out.endsWith('/a/2.png'+enter)).toBe(true);expect(pathLines(out,paths)).toEqual(paths);expect(out).toContain('(참고)');
 }
 expect(withSuffixBeforeWorkroomAttachments('plain\r',' (참고)')).toBe('plain (참고)\r');
});

test('a # reference on a raw request with images goes on the request line, never on an image path',async()=>{
 const f=fixture();const session=await f.start();
 const paths=[f.image('101010-aaaaaaaa.png'),f.image('101011-bbbbbbbb.png')];
 await f.perform({operation:'input',sessionId:session.id,data:workroomImageMessage('이 화면 확인',paths)+'\r',references:['reference-project']});
 // Pasted lines reach the terminal with CR as the line break.
 const sent=typed(f.writes).split('\r');
 expect(sent.filter(line=>paths.includes(line))).toEqual(paths);
 expect(sent.find(line=>line.includes('이 화면 확인'))).toContain('참고 프로젝트');
});

test('a submission with images is written once with its paths intact; a missing, foreign or linked image is refused before writing',async()=>{
 const f=fixture();const session=await f.start();
 const paths=[f.image('101010-aaaaaaaa.png'),f.image('101011-bbbbbbbb.png')];
 const text=workroomImageMessage('이 두 화면 비교',paths)+'\r';
 expect((await submitWorkroomDraft({id:'images-submission',sessionId:session.id,text,request:r=>f.perform(r),prepared:()=>{}})).state).toBe('written');
 const sent=typed(f.writes);expect(sent).toContain(paths.join('\r'));expect(sent.split('\r').filter(line=>paths.includes(line))).toEqual(paths);
 // The # reference suffix goes on the request line, not after the last path.
 await submitWorkroomDraft({id:'images-reference-submission',sessionId:session.id,text:workroomImageMessage('참고와 함께',paths)+'\r',references:['reference-project'],request:r=>f.perform(r),prepared:()=>{}});
 const lines=typed(f.writes).split('\r');expect(lines.find(line=>line.includes('참고와 함께'))).toContain('참고 프로젝트');expect(lines.filter(line=>paths.includes(line)).length).toBe(4);
 const refused=async(id:string,list:string[])=>{
  const before=f.writes.length;
  await expect(submitWorkroomDraft({id,sessionId:session.id,text:workroomImageMessage('확인',list)+'\r',request:r=>f.perform(r),prepared:()=>{}})).rejects.toThrow('이미지');
  expect(f.writes.length).toBe(before);
  expect((await f.perform({operation:'submission',sessionId:session.id,submission:{phase:'status',id}})).submission?.state).toBe('prepared');
 };
 await refused('missing-image-submission',[join(f.day,'101012-cccccccc.png')]);
 const outside=join(f.app,'101013-dddddddd.png');writeFileSync(outside,PNG);await refused('foreign-image-submission',[outside]);
 const link=join(f.day,'101014-eeeeeeee.png');symlinkSync(outside,link);await refused('linked-image-submission',[link]);
 await refused('named-image-submission',[f.image('not-an-image.txt')]);
 // Another device never attaches this Mac's images.
 f.service.setRemoteAccess('remote-owner',true);
 await expect(submitWorkroomDraft({id:'remote-image-submission',sessionId:session.id,text,request:r=>f.perform(r,{owner:'remote-owner',targets:new Set(['fixture-project'])}),prepared:()=>{}})).rejects.toThrow('이미지');
});

test('a composer submission with images receives the related correction before its attachment block and records the exposure',async()=>{
 // The outcome coverage note must not claim images never receive corrections: they ride the same submission write.
 const memoryId='image-correction-memory';
 const f=fixture({corrections:async()=>({text:'Failure: screenshot was misread. Next: zoom in first.',validate:()=>{},
  exposure:{memoryId,contextHash:'c'.repeat(64),sourceWithheld:false,entries:[{entryKey:'e'.repeat(24),contentVersionHash:'a'.repeat(32),reportIds:['image-report']}]}})});
 const session=await f.start();
 const paths=[f.image('101015-ffffffff.png')];
 const receipt=await submitWorkroomDraft({id:'image-correction-submission',sessionId:session.id,text:workroomImageMessage('이 화면 확인',paths)+'\r',request:r=>f.perform(r),prepared:()=>{}});
 expect(receipt.state).toBe('written');
 const lines=typed(f.writes).split('\r');
 expect(lines.find(line=>line.includes('이 화면 확인'))).toContain('zoom in first');
 expect(lines.filter(line=>paths.includes(line))).toEqual(paths);
 expect(f.store.correctionTaskSummary('fixture-project',memoryId)).toMatchObject({delivered:1});
});

test('a request that only quotes an attachment header, with no images attached, is written as plain text from any sender',async()=>{
 const f=fixture();const session=await f.start();
 // A malformed block (the header names one image, no path is a workroom image) and a header in mid-text.
 const quoted=['지난번 요청 복사:\n[첨부 이미지 1개 — 각 파일을 열어 확인하세요]\n/x/y.png\n이게 왜 안 됐지?','[첨부 이미지 2개 — 각 파일을 열어 확인하세요]\n/x/only-one.png'];
 const send=async(id:string,text:string,perform:(r:Omit<AiTerminalRequest,'requestId'>)=>Promise<any>)=>{
  const before=f.writes.length;
  expect((await submitWorkroomDraft({id,sessionId:session.id,text:text+'\r',request:perform,prepared:()=>{}})).state).toBe('written');
  expect(typed(f.writes.slice(before))).toContain(text.split('\n').at(-1)!);
 };
 for(const [i,text] of quoted.entries())await send('quoted-local-'+i,text,r=>f.perform(r));
 // A phone and another community Mac never attach images, so quoted text is not an attachment from them either.
 f.service.setRemoteAccess('remote-owner',true);
 for(const [i,text] of quoted.entries())await send('quoted-phone-'+i,text,r=>f.perform(r,{owner:'remote-owner',targets:new Set(['fixture-project'])}));
 for(const [i,text] of quoted.entries())await send('quoted-community-'+i,text,r=>f.service.perform({...r,requestId:crypto.randomUUID()},undefined,{receiptOwner:'community:peer'}));
});

test('S3: a submission with referenced files is written once with both blocks; a file gone before the write, or a remote sender, is refused before writing',async()=>{
 const f=fixture();const session=await f.start();
 const image=[f.image('101020-abababab.png')];
 const doc=join(f.app,'..','보고서 최종.pdf');writeFileSync(doc,'%PDF-1.7');const folder=join(f.app,'..','reference');
 const text=workroomAttachmentMessage('이 문서와 폴더 검토',image,[doc,folder])+'\r';
 expect((await submitWorkroomDraft({id:'files-submission',sessionId:session.id,text,request:r=>f.perform(r),prepared:()=>{}})).state).toBe('written');
 const lines=typed(f.writes).split('\r');
 expect(lines).toContain('[첨부 파일 2개 — 각 파일을 열어 확인하세요]');
 expect(lines.filter(line=>line===doc||line===folder)).toEqual([doc,folder]);
 const gone=join(f.app,'..','gone.pdf');
 const before=f.writes.length;
 await expect(submitWorkroomDraft({id:'missing-file-submission',sessionId:session.id,text:workroomAttachmentMessage('확인',[],[gone])+'\r',request:r=>f.perform(r),prepared:()=>{}})).rejects.toThrow('작성 내용은 유지했습니다');
 expect(f.writes.length).toBe(before);
 f.service.setRemoteAccess('remote-owner',true);
 await expect(submitWorkroomDraft({id:'remote-file-submission',sessionId:session.id,text:workroomAttachmentMessage('확인',[],[doc])+'\r',request:r=>f.perform(r,{owner:'remote-owner',targets:new Set(['fixture-project'])}),prepared:()=>{}})).rejects.toThrow('이미지·파일');
 expect(f.writes.length).toBe(before);
});
