import { randomUUID } from 'node:crypto';
import { OnboardingProgressStore } from './onboardingProgressStore';
import { GITHUB_RECIPE, parseGithubReceipt, type GithubSetupReceipt } from './onboardingGithub';

/** Single current immutable-recipe receipt. No auth output/code/account/token is durable. */
export class OnboardingGithubStore extends OnboardingProgressStore {
 constructor(directory:string){super(directory);this.db.exec('CREATE TABLE IF NOT EXISTS github_setup(id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL)');}
 receipt():GithubSetupReceipt|null {
  const row=this.db.query('SELECT body FROM github_setup WHERE id=1').get() as {body:string}|null;
  if(!row)return null;
  if(row.body.length>4096)throw new Error('기존 설치 기록을 확인하지 못했습니다.');
  return parseGithubReceipt(JSON.parse(row.body));
 }
 change(expected:string,fn:(r:GithubSetupReceipt|null)=>GithubSetupReceipt):GithubSetupReceipt{
  return this.db.transaction(()=>{
   const r=this.receipt();if((r?.revision??'0')!==expected)throw new Error('준비 상태가 바뀌었습니다. 다시 확인해 주세요.');
   const next=parseGithubReceipt({...fn(r),revision:randomUUID(),updatedAt:new Date().toISOString()});
   this.db.query('INSERT INTO github_setup(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(JSON.stringify(next));
   return next;
  }).immediate();
 }
 review(expected:string):GithubSetupReceipt{
  return this.change(expected,r=>{
   if(r&&['preparing','installing','authenticating'].includes(r.state))throw new Error('이전 작업 결과부터 확인해 주세요.');
   return {schema:1,recipe:GITHUB_RECIPE.id,id:randomUUID(),revision:randomUUID(),state:'reviewed',
    reviewedAt:new Date().toISOString(),updatedAt:new Date().toISOString(),ownerPid:null,guardPid:null};
  });
 }
}
