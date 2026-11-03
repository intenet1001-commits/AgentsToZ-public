/** Durable dedupe only: no question text, answer text, credentials or native handles are stored. */
import {Database} from 'bun:sqlite';
import {constants,openSync,closeSync,lstatSync,mkdirSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import {TEAM_QUESTION_PROTOCOL,TeamQuestionError,normalizeTeamQuestionBinding,questionFail,questionHash,questionId,type TeamQuestionReceipt} from './teamQuestionProtocol';

export interface TeamQuestionReservation {receipt:TeamQuestionReceipt;fingerprint:string;answerRefDigest:string;bindingDigest:string;at:number}
export interface TeamQuestionJournal {
  reserve(value:TeamQuestionReservation):{created:boolean;receipt:TeamQuestionReceipt};
  get(requestId:string):TeamQuestionReceipt|null;
  settle(requestId:string,receipt:TeamQuestionReceipt):void;
}
export class SqliteTeamQuestionJournal implements TeamQuestionJournal {
  readonly #db:Database;
  constructor(file:string,readonly maxRows=4096){
    if(!Number.isSafeInteger(maxRows)||maxRows<1||maxRows>100_000)throw new TeamQuestionError('QUESTION_JOURNAL_CAPACITY');
    if(file!==':memory:'){
      mkdirSync(dirname(file),{recursive:true,mode:0o700});
      const parent=lstatSync(dirname(file));if(!parent.isDirectory()||parent.isSymbolicLink()||(parent.mode&0o077)!==0)throw new TeamQuestionError('QUESTION_JOURNAL_UNSAFE');
      try{const fd=openSync(file,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);closeSync(fd);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
      const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0)throw new TeamQuestionError('QUESTION_JOURNAL_UNSAFE');
    }
    this.#db=new Database(file,{strict:true});
    this.#db.exec('PRAGMA busy_timeout=250; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS answers(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,answer_ref TEXT NOT NULL UNIQUE,subject TEXT NOT NULL,question TEXT NOT NULL,revision INTEGER NOT NULL,receipt TEXT NOT NULL,at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS question_subject ON answers(subject,question,revision);');
    if(file!==':memory:')chmodSync(file,0o600);
  }
  get(requestId:string):TeamQuestionReceipt|null{
    if(!questionId(requestId))return questionFail('QUESTION_INVALID');
    const row=this.#db.query('SELECT receipt FROM answers WHERE id=?').get(requestId) as {receipt:string}|null;
    return row?JSON.parse(row.receipt) as TeamQuestionReceipt:null;
  }
  reserve(value:TeamQuestionReservation):{created:boolean;receipt:TeamQuestionReceipt}{
    const r=value.receipt;normalizeTeamQuestionBinding(r.binding);
    if(r.protocolVersion!==TEAM_QUESTION_PROTOCOL||r.outcome!=='reserved'||!questionId(r.requestId)||!questionId(r.questionId)||!questionHash(r.optionsHash)||!questionHash(value.fingerprint)||!questionHash(value.answerRefDigest)||!questionHash(value.bindingDigest)||!Number.isSafeInteger(value.at)||value.at<0||!Number.isSafeInteger(r.revision)||r.revision<1||JSON.stringify(r).length>4096)return questionFail('QUESTION_INVALID');
    return this.#db.transaction(()=>{
      const old=this.#db.query('SELECT fingerprint,receipt FROM answers WHERE id=?').get(r.requestId) as {fingerprint:string;receipt:string}|null;
      if(old){if(old.fingerprint!==value.fingerprint)return questionFail('QUESTION_REQUEST_CONFLICT');return {created:false,receipt:JSON.parse(old.receipt) as TeamQuestionReceipt};}
      if(this.#db.query('SELECT id FROM answers WHERE answer_ref=?').get(value.answerRefDigest))return questionFail('QUESTION_ALREADY_SUBMITTED');
      const prior=this.#db.query('SELECT receipt FROM answers WHERE subject=? AND question=? AND revision=?').all(value.bindingDigest,r.questionId,r.revision) as {receipt:string}[];
      if(prior.some(row=>!['not-sent','unsupported','refused'].includes((JSON.parse(row.receipt) as TeamQuestionReceipt).outcome)))return questionFail('QUESTION_ALREADY_SUBMITTED');
      const count=this.#db.query('SELECT count(*) AS n FROM answers').get() as {n:number};if(count.n>=this.maxRows)return questionFail('QUESTION_JOURNAL_FULL');
      this.#db.query('INSERT INTO answers VALUES(?,?,?,?,?,?,?,?)').run(r.requestId,value.fingerprint,value.answerRefDigest,value.bindingDigest,r.questionId,r.revision,JSON.stringify(r),value.at);
      return {created:true,receipt:structuredClone(r)};
    })();
  }
  settle(id:string,next:TeamQuestionReceipt):void{
    this.#db.transaction(()=>{
    const old=this.get(id);if(!old||next.requestId!==id||JSON.stringify({...old,outcome:next.outcome,code:next.code})!==JSON.stringify(next)||!['submitted','confirmed','unknown','not-sent','unsupported','refused'].includes(next.outcome)||!/^[A-Z][A-Z0-9_]{0,79}$/.test(next.code))return questionFail('QUESTION_RECEIPT_CONFLICT');
    if(old.outcome!=='reserved'&&old.outcome!=='submitted')return questionFail('QUESTION_RECEIPT_IMMUTABLE');
    this.#db.query('UPDATE answers SET receipt=? WHERE id=?').run(JSON.stringify(next),id);
    })();
  }
  close():void{this.#db.close();}
}
