import type {AiTerminalSummary} from './aiTerminalProtocol';

const same=(a:AiTerminalSummary,b:AiTerminalSummary)=>a.id===b.id&&a.targetId===b.targetId
  &&a.agent===b.agent&&a.state===b.state&&a.createdAt===b.createdAt&&a.exitCode===b.exitCode
  &&a.cols===b.cols&&a.rows===b.rows;

/** Do not repaint the Workroom when a polling response repeats the same inventory. */
export function reconcileTerminalSummaries(previous:readonly AiTerminalSummary[],incoming:readonly AiTerminalSummary[]):AiTerminalSummary[]{
  const byId=new Map(previous.map(session=>[session.id,session]));
  const next=incoming.map(session=>{
    const prior=byId.get(session.id);
    const candidate=prior?.state==='exited'?prior:session;
    return prior&&same(prior,candidate)?prior:candidate;
  });
  return next.length===previous.length&&next.every((session,index)=>session===previous[index])?previous as AiTerminalSummary[]:next;
}
