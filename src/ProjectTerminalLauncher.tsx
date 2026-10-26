import {useState} from 'react';
import {Terminal} from 'lucide-react';
import {AI_TERMINAL_AGENTS, type AiTerminalAgent} from './aiTerminalProtocol';
import {launchChoiceLabel, launchChoiceTarget, workroomLaunchChoices, type HermesVariant} from './hermesVariants';
import {useHermesVariants} from './hermesVariantsClient';
import {hermesVariantCopy} from './i18n';
import {useAppLanguage} from './useAppLanguage';

/** Explicit agent selection and launch; viewing a project never starts a CLI. */
export function ProjectTerminalLauncher({onOpen, testId, disabled = false, agents = AI_TERMINAL_AGENTS, label = '워크룸 열기'}: {
  /** 「Hermes · Claude」/「Hermes · Codex」 (src/hermesVariants.ts) pass the variant; every other AI passes none. */
  onOpen: (agent: AiTerminalAgent, variant?: HermesVariant) => Promise<unknown>;
  testId: string;
  disabled?: boolean;
  agents?: readonly AiTerminalAgent[];
  label?: string;
}) {
  const [lang] = useAppLanguage(), copy = hermesVariantCopy(lang);
  const [choice, setChoice] = useState<string>('codex');
  const [busy, setBusy] = useState(false);
  const variants = useHermesVariants();
  const choices = workroomLaunchChoices(agents);
  const itemOf = (value: string) => variants.items.find(item => item.choice === value);
  const picked = itemOf(choice);
  return <div className="project-terminal-launcher" data-testid={testId}>
    <select aria-label="실행할 AI 에이전트" value={choice} disabled={busy || disabled}
      onChange={event => setChoice(event.target.value)}>
      {choices.map(value => {
        const item = itemOf(value);
        return <option key={value} value={value} disabled={item ? !item.available : false}>
          {launchChoiceLabel(value)}{item && !item.available ? ` · ${copy.missingShort.replace('{provider}', item.provider)}` : ''}
        </option>;
      })}
    </select>
    <button type="button" disabled={busy || disabled || (picked ? !picked.available : false)} onClick={async event => {
      event.stopPropagation();
      setBusy(true);
      try { const target = launchChoiceTarget(choice); await onOpen(target.agent, target.variant); } finally { setBusy(false); }
    }}><Terminal size={12}/>{busy ? '확인 중…' : label}</button>
  </div>;
}
