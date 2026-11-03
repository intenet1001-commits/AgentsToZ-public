import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync,statSync,symlinkSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {TEAM_QUESTION_PROTOCOL,normalizeTeamQuestionAnswerRequest,normalizeTeamQuestionAnswers,teamQuestionFromScreen,type TeamQuestionBinding,type TeamQuestionObservation,type TeamQuestionAnswerRequest,type TeamQuestionAnswer} from '../src/teamQuestionProtocol';
import {SqliteTeamQuestionJournal} from '../src/teamQuestionJournal';
import {TeamQuestionService,type TeamQuestionUserAnswer,type TeamQuestionReadback} from '../src/teamQuestionService';

const binding:TeamQuestionBinding={teamId:'team_123456789abc',memberId:'m1',executionId:'execution-one',generation:'a'.repeat(64)};
const observation=():TeamQuestionObservation=>({source:'provider',sourceRevision:'request-revision-one',providerRequestId:'provider-question-one',intent:'task-question',questions:[{id:'question-one',prompt:'어떤 구현을 선택할까요?',options:[{id:'choice-a',label:'A / 안전한 선택'},{id:'choice-b',label:'B'}],allowText:true,multiple:false}]});
function fixture(options:{unsupported?:boolean;readback?:boolean;limit?:number;file?:string}={}){
 let clock=1000,current=true,answerCurrent=true,effects=0,resolves=0,ids=0;
 let shown:TeamQuestionObservation|null=observation(),beforeSubmit:(()=>void)|null=null,proof:TeamQuestionReadback|null=null;
 let user:TeamQuestionUserAnswer|null=null;
 const journal=new SqliteTeamQuestionJournal(options.file??':memory:',options.limit??4096);
 const service=new TeamQuestionService({journal,now:()=>clock,createId:()=>`question-${++ids}`,current:b=>current&&b.generation===binding.generation,
  ...(!options.unsupported?{userAnswers:{resolve:async()=>{resolves++;return user;},current:()=>answerCurrent}}:{}),
  adapter:{observe:async()=>shown,submit:async(b,q,answers,_id,active)=>{beforeSubmit?.();if(!active())return 'not-sent';effects++;proof={binding:b,questionId:q.questionId,revision:q.revision,optionsHash:q.optionsHash,answerDigest:createHash('sha256').update(JSON.stringify(answers)).digest('hex'),providerReceiptId:'provider-semantic-answer'};return 'submitted';},readback:async()=>options.readback===false?null:proof}});
 const q=service.observe(binding,shown)!;
 function request(extra:Partial<TeamQuestionAnswerRequest>={}):TeamQuestionAnswerRequest{return {protocolVersion:TEAM_QUESTION_PROTOCOL,requestId:'answer-request-one',binding,questionId:q.questionId,expectedRevision:q.revision,optionsHash:q.optionsHash,userAnswerRef:'host-user-answer-one',...extra};}
 function answer(answers:TeamQuestionAnswer[]=[{questionId:'question-one',optionIds:['choice-b'],text:null}]){user={binding,questionId:q.questionId,revision:q.revision,optionsHash:q.optionsHash,recordedAt:clock,expiresAt:q.expiresAt,answers};}
 return {service,journal,q,request,answer,get effects(){return effects;},get resolves(){return resolves;},advance:(n:number)=>{clock+=n;},invalidate:()=>{current=false;},cancelAnswer:()=>{answerCurrent=false;},setShown:(o:TeamQuestionObservation|null)=>{shown=o;},beforeSubmit:(fn:()=>void)=>{beforeSubmit=fn;},setUser:(u:TeamQuestionUserAnswer|null)=>{user=u;},get now(){return clock;}};
}
test('typed answers cannot contain an instruction, fake user origin, keys or arbitrary selection labels',()=>{
 const f=fixture();for(const extra of [{text:'Root 인계문'},{origin:'user'},{keys:['enter']}])expect(()=>normalizeTeamQuestionAnswerRequest({...f.request(),...extra})).toThrow('QUESTION_INVALID');
 expect(()=>normalizeTeamQuestionAnswers([{questionId:'question-one',optionIds:['B'],text:null}],observation().questions)).toThrow('QUESTION_ANSWER_INVALID');
 expect(()=>normalizeTeamQuestionAnswers([{questionId:'question-one',optionIds:['choice-b'],text:'인계문'}],observation().questions)).toThrow('QUESTION_ANSWER_INVALID');f.journal.close();
});
test('a genuine host-owned selection resolves to the exact option and requires semantic readback',async()=>{
 const f=fixture();f.answer();expect(await f.service.answer(f.request())).toMatchObject({outcome:'confirmed',code:'ANSWER_CONFIRMED'});expect(f.effects).toBe(1);expect(f.service.pending(binding)).toBeNull();
 expect(await f.service.answer(f.request())).toMatchObject({outcome:'confirmed'});expect(f.effects).toBe(1);expect(f.resolves).toBe(1);
 await expect(f.service.answer(f.request({userAnswerRef:'different-user-receipt'}))).rejects.toThrow('QUESTION_REQUEST_CONFLICT');expect(f.effects).toBe(1);f.journal.close();
});
test('free text is accepted only from the bound user response and never from a leader handoff',async()=>{
 const f=fixture();f.answer([{questionId:'question-one',optionIds:[],text:'사용자의 직접 답변 / 한글'}]);expect((await f.service.answer(f.request())).outcome).toBe('confirmed');expect(f.effects).toBe(1);f.journal.close();
});
test('missing actual user-answer provenance is explicitly unsupported with zero effects',async()=>{
 const f=fixture({unsupported:true});expect(f.q.submission).toEqual({supported:false,code:'USER_ANSWER_SOURCE_UNAVAILABLE'});
 const r=await f.service.answer(f.request());expect(r).toMatchObject({outcome:'unsupported',code:'USER_ANSWER_SOURCE_UNAVAILABLE',answerDigest:null});expect(f.effects).toBe(0);
 expect(await f.service.answer(f.request())).toEqual(r);expect(f.resolves).toBe(0);f.journal.close();
});
test('member, session generation, question revision, option hash and expiry cannot substitute another question',async()=>{
 for(const extra of [{binding:{...binding,memberId:'m2'}},{binding:{...binding,generation:'b'.repeat(64)}},{questionId:'other-question'},{expectedRevision:2},{optionsHash:'c'.repeat(64)}]){
  const f=fixture();f.answer();await expect(f.service.answer(f.request(extra))).rejects.toThrow();expect(f.effects).toBe(0);f.journal.close();
 }
 const f=fixture();f.answer();f.advance(30*60_000);await expect(f.service.answer(f.request())).rejects.toThrow('QUESTION_STALE');expect(f.effects).toBe(0);f.journal.close();
});
test('late observation and the last write gate refuse changed questions, expired answers and cancelled user responses',async()=>{
 for(const change of ['question','generation','cancel'] as const){const f=fixture();f.answer();
  if(change==='question')f.setShown({...observation(),sourceRevision:'replacement'});else f.beforeSubmit(()=>change==='generation'?f.invalidate():f.cancelAnswer());
  expect((await f.service.answer(f.request())).outcome).toBe('not-sent');expect(f.effects).toBe(0);f.journal.close();
 }
 const f=fixture();f.setUser({binding,questionId:f.q.questionId,revision:f.q.revision,optionsHash:f.q.optionsHash,recordedAt:f.now,expiresAt:f.now+1,answers:[{questionId:'question-one',optionIds:['choice-a'],text:null}]});
 f.beforeSubmit(()=>f.advance(2));expect((await f.service.answer(f.request())).outcome).toBe('not-sent');expect(f.effects).toBe(0);f.journal.close();
});
test('accepted bytes or a vanished screen do not confirm submission, and unknown cannot replay under either ID',async()=>{
 const f=fixture({readback:false});f.answer();const first=await f.service.answer(f.request());expect(first).toMatchObject({outcome:'unknown',code:'QUESTION_READBACK_UNKNOWN'});expect(f.effects).toBe(1);
 expect(await f.service.answer(f.request())).toEqual(first);await expect(f.service.answer(f.request({requestId:'new-answer-request'}))).rejects.toThrow('QUESTION_ALREADY_SUBMITTED');expect(f.effects).toBe(1);f.journal.close();
});
test('restarted durable journal returns the original unknown receipt without touching a new adapter or user response',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'team-question-journal-')),file=join(dir,'answers.sqlite');
 try{const f=fixture({readback:false,file});f.answer([{questionId:'question-one',optionIds:[],text:'사용자의 직접 답변'}]);const r=await f.service.answer(f.request());f.journal.close();
  const next=fixture({file});expect(await next.service.answer(f.request())).toEqual(r);expect(next.effects).toBe(0);expect(next.resolves).toBe(0);next.journal.close();
  expect(statSync(file).mode&0o777).toBe(0o600);expect(readFileSync(file).includes(Buffer.from('사용자의 직접 답변'))).toBe(false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('one answer attempt per question is durable across different request IDs and concurrent submits',async()=>{
 const f=fixture();f.answer();const results=await Promise.allSettled([f.service.answer(f.request()),f.service.answer(f.request({requestId:'other-id'}))]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(f.effects).toBe(1);f.journal.close();
});
test('journal capacity and unsafe paths refuse before effects without evicting earlier unknown receipts',async()=>{
 const f=fixture({limit:1,readback:false});f.answer();const r=await f.service.answer(f.request());const q=f.service.observe(binding,{...observation(),sourceRevision:'revision-two'})!;
 f.setUser({binding,questionId:q.questionId,revision:q.revision,optionsHash:q.optionsHash,recordedAt:f.now,expiresAt:q.expiresAt,answers:[{questionId:'question-one',optionIds:['choice-a'],text:null}]});
 await expect(f.service.answer({...f.request(),requestId:'second-request',questionId:q.questionId,expectedRevision:q.revision,optionsHash:q.optionsHash,userAnswerRef:'second-user-answer'})).rejects.toThrow('QUESTION_JOURNAL_FULL');expect(f.service.receipt(r.requestId,binding)).toEqual(r);expect(f.effects).toBe(1);f.journal.close();
 const dir=mkdtempSync(join(tmpdir(),'question-unsafe-'));try{mkdirSync(join(dir,'owned'),{mode:0o700});symlinkSync(join(dir,'owned'),join(dir,'link'));expect(()=>new SqliteTeamQuestionJournal(join(dir,'link','db'))).toThrow('QUESTION_JOURNAL_UNSAFE');}finally{rmSync(dir,{recursive:true,force:true});}
});
test('two mobile/main-chat sources do not choose a hub or change the bound member, and a handoff is never an approval',async()=>{
 const f=fixture();const second={...binding,memberId:'m2',executionId:'execution-two'};const q2=f.service.observe(second,observation())!;
 expect(f.service.list(binding.teamId).questions.map(q=>q.binding.memberId)).toEqual(['m1','m2']);expect(q2.questionId).not.toBe(f.q.questionId);
 const human=f.service.observe(binding,{...observation(),intent:'human-handoff',sourceRevision:'system-auth'})!;expect(human.submission).toEqual({supported:false,code:'HUMAN_HANDOFF_REQUIRED'});expect(f.effects).toBe(0);f.journal.close();
});
test('the broader observed AskUserQuestion tail blocks a handoff while keeping already answered transcript out',()=>{
 const screen=['AskUserQuestion','어떤 방식을 선택할까요?','❯ 1. A','  2. B','  3. Type something','description','detail','footer 1','footer 2','footer 3','footer 4','footer 5','Tab to switch','Enter to select'];
 const seen=teamQuestionFromScreen(screen);expect(seen?.source).toBe('screen');expect(seen?.intent).toBe('unclassified');expect(seen?.questions[0]?.options.map(x=>x.id)).toEqual(['option_1','option_2','option_3']);
 expect(teamQuestionFromScreen([...screen,'>'])).toBeNull();
 expect(teamQuestionFromScreen(['AskUserQuestion','직접 답변해 주세요.','Type your answer','Enter to submit'])?.questions[0]?.allowText).toBe(true);
});
