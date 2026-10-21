import {createHash} from 'node:crypto';
import type {VoiceHistoryIdentity} from './voiceHistoryProtocol';
import type {VoiceTarget} from './voiceSessionProtocol';

/**
 * The record scope of 아젠투지 (OPS) voice.
 *
 * It used to hash the Control folder's root path, so renaming AgentsToZ-Control (or cloning it to
 * another path) silently moved every earlier OPS voice session out of scope: 「세션 기억하기」 and the
 * reviewed OPS memory proposal refused them as «a different connection». The scope is now the
 * profile, memory, project and backend — who and what, never where.
 */
export interface OpsVoiceBinding {
  profileId:string;memoryId:string;root:string;projectId:string|null;backend:string;
  /** Former Control roots recorded when the folder was renamed or moved (optional). */
  legacyRoots?:unknown;
}

const sha=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function opsVoiceBindingHash(binding:OpsVoiceBinding):string{
  return sha(['agentstoz-ops-voice-v2',binding.profileId,binding.memoryId,binding.projectId,binding.backend]);
}

/** The path-bound scopes earlier builds sealed, for the current root and every recorded former root. */
export function legacyOpsVoiceBindingHashes(binding:OpsVoiceBinding):string[]{
  const former=Array.isArray(binding.legacyRoots)?binding.legacyRoots.filter((root):root is string=>typeof root==='string'&&root.length>0&&root.length<=4096).slice(0,32):[];
  return [...new Set([binding.root,...former].map(root=>sha([binding.profileId,binding.memoryId,root,binding.projectId,binding.backend])))];
}

export function opsVoiceIdentity(target:VoiceTarget,binding:OpsVoiceBinding,memoryId:string|null):VoiceHistoryIdentity{
  return {target,memoryScope:'ops',memoryId,binding:opsVoiceBindingHash(binding),formerBindings:legacyOpsVoiceBindingHashes(binding)};
}

/** A sealed session still belongs to the current identity: same memory, same or a recorded former scope. */
export function sameVoiceScope(current:VoiceHistoryIdentity,sealed:Pick<VoiceHistoryIdentity,'binding'|'memoryId'>):boolean{
  return current.memoryId===sealed.memoryId&&(sealed.binding===current.binding||!!current.formerBindings?.includes(sealed.binding));
}
