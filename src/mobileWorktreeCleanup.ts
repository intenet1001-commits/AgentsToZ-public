import {createHash,randomUUID} from 'node:crypto';
import {realpathSync,existsSync,statSync} from 'node:fs';
import {parseGitWorktreePorcelain} from '../git-worktree-list';
type Git=(path:string,args:string[])=>Promise<{ok:boolean;stdout:string;stderr:string}>;
type Snapshot={path:string;identity:string;primary:string;head:string;primaryHead:string;upstreamHead:string;branch:string};
/** Review is bound to owner, registered target, Git heads and five-minute lifetime. */
export class MobileWorktreeCleanup {
 private reviews=new Map<string,{owner:string;target:string;expires:number;fingerprint:string}>();
 constructor(private git:Git,private idle:(path:string)=>Promise<void>){}
 private async inspect(path:string):Promise<Snapshot>{
  await this.idle(path);
  const read=async(cwd:string,args:string[])=>{const r=await this.git(cwd,args);if(!r.ok)throw new Error('워크트리 Git 상태를 확인하지 못했습니다. 먼저 Mac에서 확인하세요.');return r.stdout.trim()};
  const trees=parseGitWorktreePorcelain(await read(path,['-c','core.quotePath=false','worktree','list','--porcelain']));
  const primary=trees[0];const selected=trees.find(t=>realpathSync(t.path)===path);
  if(!primary||!selected||realpathSync(primary.path)===path||selected.locked)throw new Error('주 작업 공간이나 잠긴 워크트리는 정리할 수 없습니다.');
  if(await read(path,['status','--porcelain=v1','--untracked-files=all']))throw new Error('미커밋 변경이 있습니다. 먼저 커밋·보존하세요.');
  const head=await read(path,['rev-parse','--verify','HEAD']);
  const primaryHead=await read(primary.path,['rev-parse','--verify','HEAD']);
  const upstreamHead=await read(primary.path,['rev-parse','--verify','@{upstream}']);
  const branch=await read(path,['symbolic-ref','--short','HEAD']);
  if(!(await this.git(path,['merge-base','--is-ancestor',head,primaryHead])).ok||!(await this.git(path,['merge-base','--is-ancestor',head,upstreamHead])).ok)throw new Error('기본 브랜치와 마지막으로 확인한 upstream에 반영되지 않은 커밋이 있습니다. 먼저 병합·Push하세요.');
  const stat=statSync(path);
  return {path,identity:`${stat.dev}:${stat.ino}`,primary:realpathSync(primary.path),head,primaryHead,upstreamHead,branch};
 }
 private fingerprint(s:Snapshot){return createHash('sha256').update(JSON.stringify(s)).digest('hex')}
 async review(owner:string,target:string,path:string){
  for(const [id,r] of this.reviews)if(r.expires<Date.now())this.reviews.delete(id);
  if(this.reviews.size>=64)throw new Error('정리 검토가 많습니다. 잠시 후 다시 확인하세요.');
  const snapshot=await this.inspect(path),token=randomUUID();
  this.reviews.set(token,{owner,target,expires:Date.now()+300000,fingerprint:this.fingerprint(snapshot)});
  return {token,branch:snapshot.branch,message:'기본 브랜치와 마지막으로 확인한 upstream에 반영된 워크트리입니다. 폴더를 제거하고 브랜치는 유지합니다.'};
 }
 async remove(owner:string,target:string,path:string,token:string){
  const review=this.reviews.get(token);
  if(!review||review.owner!==owner||review.target!==target||review.expires<Date.now())throw new Error('정리 검토가 만료되었거나 대상이 다릅니다. 다시 확인하세요.');
  const snapshot=await this.inspect(path);
  if(this.fingerprint(snapshot)!==review.fingerprint)throw new Error('검토 이후 Git 상태가 바뀌었습니다. 다시 확인하세요.');
  // A transport retry cannot repeat an uncertain removal.
  this.reviews.delete(token);
  const removed=await this.git(snapshot.primary,['worktree','remove',path]);
  if(!removed.ok)throw new Error('워크트리 정리 결과를 확인하세요. 강제 삭제는 실행하지 않았습니다.');
  const verify=await this.git(snapshot.primary,['-c','core.quotePath=false','worktree','list','--porcelain']);
  if(!verify.ok||existsSync(path)||parseGitWorktreePorcelain(verify.stdout).some(t=>t.path===path))throw new Error('워크트리 정리 완료를 확인하지 못했습니다. 목록을 새로고침하세요.');
  return {token:'',branch:snapshot.branch,message:'워크트리 폴더 제거 완료 · 브랜치 유지. 프로젝트 목록을 새로고침하세요.'};
 }
}
