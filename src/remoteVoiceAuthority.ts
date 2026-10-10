/**
 * Which projects a phone's voice request may reach (api-server performMobileWorkspace).
 *
 * Only `prepare` names a target, so it decides the session's reach: an OPS conversation gets the
 * device's current grant, a workroom conversation only its own project. Every later request carries
 * the grant as it is *now*, so the host's check (the session's projects ⊆ this request's) means "the
 * grant has not shrunk since the start" for both. Passing only the OPS id to later requests — what the
 * code did — made every connect/partner/say/caption of an OPS voice on a phone allowed more than OPS
 * fail with 「음성 세션의 프로젝트가 요청과 다릅니다」 (review 2026-09-30; the phone's 「무반응」).
 */
export function remoteVoiceAllowedTargets(voice:{action:string;target?:{kind:string}},targetId:string,granted?:ReadonlySet<string>):ReadonlySet<string>{
  if(!granted)return new Set([targetId]);
  return voice.action!=='prepare'||voice.target?.kind==='ops'?granted:new Set([targetId]);
}
