/**
 * A community member's endpoint name is «<기기 이름> / 아젠투지(OPS)» (or «/ <프로젝트>») so peers can
 * tell what they are talking to. In a 「기기」 list the device is the point, so only its name is shown.
 */
export function communityDeviceLabel(displayName:string):string{
  const name=displayName.replace(/[\u0000-\u001f\u007f]/g,' ').trim();
  const slash=name.lastIndexOf(' / ');
  return (slash>0?name.slice(0,slash).trim():name).slice(0,60)||'다른 기기';
}

/**
 * The other Mac refuses a bypassed start from a community peer (agentDialogueControl.ts) — joining the
 * community grants control, not «run without asking». A panel driving another Mac starts without bypass
 * and shows this instead of failing the start with that refusal (3호 → 1호, 2026-10-07).
 */
export const COMMUNITY_BYPASS_UNAVAILABLE='다른 Mac의 워크룸은 권한 우회 없이 열립니다 — 그 Mac이 다른 기기의 권한 우회를 받지 않습니다. 승인 질문은 이 화면의 터미널에서 답하면 됩니다.';
