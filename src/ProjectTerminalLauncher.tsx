import {useState} from 'react';
import {Terminal} from 'lucide-react';
import {AI_TERMINAL_AGENTS, type AiTerminalAgent} from './aiTerminalProtocol';

/** Explicit agent selection and launch; viewing a project never starts a CLI. */
export function ProjectTerminalLauncher({onOpen, testId, disabled = false, agents = AI_TERMINAL_AGENTS, label = 'AI 터미널 열기'}: {
  onOpen: (agent: AiTerminalAgent) => Promise<unknown>;
  testId: string;
  disabled?: boolean;
  agents?: readonly AiTerminalAgent[];
  label?: string;
}) {
  const [agent, setAgent] = useState<AiTerminalAgent>('codex');
  const [busy, setBusy] = useState(false);
  return <div className="project-terminal-launcher" data-testid={testId}>
    <select aria-label="실행할 AI 에이전트" value={agent} disabled={busy || disabled}
      onChange={event => setAgent(event.target.value as AiTerminalAgent)}>
      {agents.map(value => <option key={value} value={value}>
        {{claude: 'Claude Code', codex: 'Codex CLI', agy: 'Antigravity', hermes: 'Hermes'}[value]}
      </option>)}
    </select>
    <button type="button" disabled={busy || disabled} onClick={async event => {
      event.stopPropagation();
      setBusy(true);
      try { await onOpen(agent); } finally { setBusy(false); }
    }}><Terminal size={12}/>{busy ? '확인 중…' : label}</button>
  </div>;
}
