import {AI_TERMINAL_AGENTS,type AiTerminalAgent} from './aiTerminalProtocol';

/**
 * The AI the OPS workroom opens with when nothing is running there.
 *
 * `openOpsWorkroom` used to pass a literal `'codex'`, so choosing Claude·Hermes·Antigravity in
 * 「아젠투지 설정」 changed the voice host (which reads the stored preference) but not the button —
 * the OPS workroom still came up as Codex. Both paths now read the same remembered choice; codex
 * stays the last resort because a damaged or absent preference must still open something.
 *
 * ⚠️ This lives apart from `opsLaunchPreference.ts` on purpose: that module reads the file with
 * `node:fs`, and the app screen imports this one. Putting it there made `vite build` fail with
 * «"join" is not exported by "__vite-browser-external"» — typecheck and `bun test` run under Bun and
 * do not catch a browser-unsafe import.
 */
export function opsWorkroomAgentFrom(preference:{agent?:unknown}|null|undefined):AiTerminalAgent{
  const agent=preference?.agent;
  return AI_TERMINAL_AGENTS.includes(agent as AiTerminalAgent)?agent as AiTerminalAgent:'codex';
}
