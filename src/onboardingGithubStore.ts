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
 /**
  * `recipeId` records WHICH reviewed install the user agreed to, and the host
  * refuses to act on a receipt from a different one. It must therefore be the
  * recipe that will actually run.
  *
  * ⚠️ This used to be hardcoded to the macOS recipe. On Windows the panel showed
  * the winget text while the receipt stored `github-macos-arm64-...`, so the
  * record disagreed with what was reviewed, bumping the macOS recipe would
  * invalidate Windows receipts for a reason that does not apply to them, and
  * bumping the Windows recipe would invalidate nothing.
  */
 review(expected:string,recipeId:string=GITHUB_RECIPE.id):GithubSetupReceipt{
  if(typeof recipeId!=='string'||!recipeId||recipeId.length>80)throw new Error('설치 내용을 다시 검토해 주세요.');
  return this.change(expected,r=>{
   if(r&&['preparing','installing','authenticating'].includes(r.state))throw new Error('이전 작업 결과부터 확인해 주세요.');
   return {schema:1,recipe:recipeId,id:randomUUID(),revision:randomUUID(),state:'reviewed',
    reviewedAt:new Date().toISOString(),updatedAt:new Date().toISOString(),ownerPid:null,guardPid:null};
  });
 }
}
