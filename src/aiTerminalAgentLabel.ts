import type {AiTerminalAgent} from './aiTerminalProtocol';
/** 화면에 쓰는 AI 이름 한 곳 — 예전에는 같은 삼항식이 여러 군데 복사돼 있었다. */
export function aiTerminalAgentLabel(agent:AiTerminalAgent):string{
  return agent==='claude'?'Claude Code':agent==='codex'?'Codex CLI':agent==='agy'?'Antigravity':'Hermes';
}
