import type {AiTerminalAgent,AiTerminalRequest,AiTerminalResponse,AiTerminalSummary} from './aiTerminalProtocol';
import type {MemorySaveProblem} from './memorySaveProblem';
import {MEMORY_SAVE_PROBLEM_TEXT} from './memorySaveProblem';
import type {WorkroomPopoutRoute} from './workroomPopout';
import {workroomPopoutTitle} from './workroomPopout';

export function memorySaveRecoveryPrompt(problem:MemorySaveProblem):string {
  return `이 프로젝트의 기억 저장 문제를 진단하고 해결 방법을 준비하세요.\n상태: ${MEMORY_SAVE_PROBLEM_TEXT[problem]}\n\n`
    + '기존 기억·최근 저장 영수증·실행 중인 작업과 로컬/Supabase 상태를 먼저 읽기 전용으로 확인하세요. 원문 대화·내부 프롬프트·인증값은 출력하거나 다른 프로젝트에 복사하지 마세요.\n'
    + (problem==='conflict'?'로컬과 원격 기억의 양쪽 원본과 리비전을 보존하고 차이를 비교해 내용이 빠지지 않는 병합안을 준비하세요. 강제 Pull/Push나 한쪽 덮어쓰기로 충돌을 없애지 마세요.\n':'')
    + (problem==='agent'?'기존 저장 AI의 로그인·선택 모델·연결 상태와 설치 CLI를 확인하세요. 모델·계정·전역 설정을 임의로 바꾸지 마세요.\n':'')
    + (problem==='unknown'?'앞 저장은 실행됐을 수 있습니다. 같은 저장이나 AI를 다시 호출하기 전에 원래 요청의 영수증·문서 복구 상태와 실제 결과를 확인하세요.\n':'')
    + (problem==='backup'?'로컬 저장은 완료됐습니다. 기억 정리 AI를 다시 실행하지 말고 백업 결과와 원격 차이만 확인하세요.\n':'')
    + '다른 작업의 잠금을 해제하거나 저장을 반복하지 마세요. 현재 원인·확인한 근거·구체적인 복구안을 설명하고, 필요한 쓰기 동작은 사용자가 확인한 뒤 수행하세요.';
}

export interface MemorySaveRecoveryDependencies {
  resolve(folder:string):Promise<{id:string}>;
  start(request:AiTerminalRequest):Promise<AiTerminalResponse>;
  list(targetId:string,agent:AiTerminalAgent):Promise<readonly AiTerminalSummary[]>;
  open(route:WorkroomPopoutRoute,title:string):Promise<void>;
  newId():string;
}
export type MemoryRecoveryPhase='idle'|'resolving'|'starting'|'unconfirmed'|'started'|'opened';
export const MEMORY_RECOVERY_UNCONFIRMED='워크룸 시작 결과를 확인하지 못했습니다. 다시 시작하지 않고 이 프로젝트의 워크룸 목록에서 확인하세요.';

/** One explicit launch, then only reopens. A lost start reply can never trigger another CLI automatically. */
export class MemorySaveRecoveryAttempt {
  phase:MemoryRecoveryPhase='idle';
  targetId:string|null=null;
  session:AiTerminalSummary|null=null;
  private listed=new Map<string,AiTerminalSummary>();
  private launchAgent:AiTerminalAgent|null=null;
  constructor(private item:{folder:string;name:string;problem:MemorySaveProblem},private dependencies:MemorySaveRecoveryDependencies){}
  async launch(agent:AiTerminalAgent):Promise<void>{
    if(this.session)return this.reopen();
    if(this.phase==='unconfirmed')throw Error(MEMORY_RECOVERY_UNCONFIRMED);
    if(this.phase!=='idle')throw Error('워크룸을 준비 중입니다.');
    this.phase='resolving';
    try{
      const target=await this.dependencies.resolve(this.item.folder);
      if(!/^[A-Za-z0-9_-]{8,128}$/.test(target.id))throw Error();
      this.targetId=target.id;
    }catch{this.phase='idle';throw Error('이 프로젝트의 등록 경로를 확인하지 못했습니다. 프로젝트 화면에서 등록 상태를 확인하세요.');}
    this.phase='starting';
    this.launchAgent=agent;
    try{
      const result=await this.dependencies.start({operation:'start',requestId:this.dependencies.newId(),targetId:this.targetId,agent,
        cols:100,rows:28,prompt:memorySaveRecoveryPrompt(this.item.problem),bypassPermissions:false});
      if(!result.session||result.session.targetId!==this.targetId||result.session.agent!==agent)throw Error();
      this.session=result.session;this.phase='started';
    }catch{
      this.phase='unconfirmed';throw Error(MEMORY_RECOVERY_UNCONFIRMED);
    }
    await this.reopen();
  }
  async reopen():Promise<void>{
    if(!this.session)throw Error(MEMORY_RECOVERY_UNCONFIRMED);
    const session=this.session;
    try{await this.dependencies.open({sessionId:session.id,targetId:session.targetId,agent:session.agent,bypassPermissions:false},workroomPopoutTitle(this.item.name,session.agent));this.phase='opened';}
    catch{this.phase='started';throw Error('워크룸은 시작됐지만 창을 열지 못했습니다. 같은 워크룸을 다시 열어 보세요.');}
  }
  async rooms():Promise<readonly AiTerminalSummary[]>{
    if(!this.targetId||!this.launchAgent)throw Error('확인할 프로젝트가 없습니다.');
    try{
      const rooms=(await this.dependencies.list(this.targetId,this.launchAgent)).filter(room=>room.targetId===this.targetId&&room.agent===this.launchAgent);
      this.listed=new Map(rooms.map(room=>[room.id,room]));return rooms;
    }catch{throw Error('워크룸 목록을 확인하지 못했습니다. 잠시 후 목록만 다시 확인하세요.');}
  }
  async openListed(id:string):Promise<void>{
    const session=this.listed.get(id);
    if(!session||session.targetId!==this.targetId)throw Error('확인한 이 프로젝트의 워크룸을 선택하세요.');
    this.session=session;await this.reopen();
  }
}
