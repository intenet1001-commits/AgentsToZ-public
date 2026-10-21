import type {TesterPersonaEvolution} from './testerAgentContract';

/**
 * Discovery stops at the discovered-draft budget (runner 1.7.2+), not the total candidate limit,
 * so the notice names that budget. An older runner does not report it: say no number rather than
 * cite a limit that was not the one applied.
 */
export function personaOverflowNotice(data:Pick<TesterPersonaEvolution,'candidateLimit'|'discoveredLimit'|'additionalCandidates'>|undefined):string|null{
  const skipped=data?.additionalCandidates;
  if(!skipped)return null;
  const limit=data.discoveredLimit?`자동 후보 ${data.discoveredLimit}개 한도로`:'후보 한도로';
  return `${limit} ${skipped}개는 이번 제안에 포함되지 않았습니다. 현재 후보를 검토한 뒤 다시 제안하세요.`;
}
