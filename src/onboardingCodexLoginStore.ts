import {randomUUID} from 'node:crypto';
import {OnboardingProgressStore} from './onboardingProgressStore';
import {parseCodexLoginReceipt,type CodexLoginReceipt} from './onboardingCodexLogin';
export class CodexLoginStore extends OnboardingProgressStore {
 constructor(directory:string){super(directory);this.db.exec('CREATE TABLE IF NOT EXISTS codex_login(id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL)');}
 receipt():CodexLoginReceipt|null{
  const row=this.db.query('SELECT body FROM codex_login WHERE id=1').get() as {body:string}|null;
  if(!row)return null;if(row.body.length>4096)throw new Error('로그인 기록 확인 필요');return parseCodexLoginReceipt(JSON.parse(row.body));
 }
 change(expected:string,fn:(r:CodexLoginReceipt|null)=>CodexLoginReceipt){
  return this.db.transaction(()=>{
   const r=this.receipt();if((r?.revision??'0')!==expected)throw new Error('로그인 상태 변경됨');
   const next=parseCodexLoginReceipt({...fn(r),revision:randomUUID(),updatedAt:new Date().toISOString()});
   this.db.query('INSERT INTO codex_login(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(JSON.stringify(next));return next;
  }).immediate();
 }
}
