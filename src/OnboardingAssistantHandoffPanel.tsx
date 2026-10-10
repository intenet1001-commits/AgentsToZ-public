import { useState } from 'react';
import { ONBOARDING_ASSISTANTS, buildPreparationHandoff, type OnboardingAssistantId } from './onboardingAssistantHandoff';
import type { OnboardingProgress } from './onboardingProgress';
import { writeOnboardingClipboard } from './onboardingClipboard';

export default function OnboardingAssistantHandoff({ progress, disabled, onRecheck }: {
  progress: OnboardingProgress | null; disabled: boolean; onRecheck: () => void;
}) {
  const [assistant, setAssistant] = useState<OnboardingAssistantId>('chatgpt');
  const [copiedText, setCopiedText] = useState('');
  const [fallbackText, setFallbackText] = useState('');
  const [copying, setCopying] = useState(false);
  const definition = ONBOARDING_ASSISTANTS.find(item => item.id === assistant)!;
  const prompt = progress ? buildPreparationHandoff(progress, assistant) : '';
  const button = 'min-h-11 rounded-xl border border-[var(--line)] px-4 py-2 text-sm disabled:opacity-50';
  async function copy() {
    setCopying(true);
    const copied = await writeOnboardingClipboard(prompt);
    setCopiedText(copied ? prompt : '');
    setFallbackText(copied ? '' : prompt);
    setCopying(false);
  }
  return <section aria-label="AI에게 이어서 맡기기" className="mt-4 rounded-xl border border-[var(--line)] p-4">
    <h4 className="font-semibold">AI에게 이어서 맡기기</h4>
    <p className="mt-2 text-sm text-[var(--ink-2)]">AI 앱이 없으면 공식 안내에서 설치·로그인하세요. 앱을 열었다는 것만으로 로컬 작업이나 MCP 연결이 확인되지는 않습니다.</p>
    <label className="mt-3 block text-sm">도움을 받을 AI
      <select value={assistant} onChange={event => setAssistant(event.target.value as OnboardingAssistantId)} className="ml-2 min-h-11 max-w-full rounded border border-[var(--line)] bg-[var(--surface)] px-2">
        {ONBOARDING_ASSISTANTS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select>
    </label>
    <p className="mt-2 text-sm text-[var(--ink-2)]">{definition.instruction}</p>
    <div className="mt-3 flex flex-wrap gap-2">
      {definition.url && <a href={definition.url} target="_blank" rel="noopener noreferrer" className={button}>AI 앱 공식 설치 안내</a>}
      <button type="button" disabled={disabled || !progress || copying} onClick={() => void copy()} className={button}>{copiedText && copiedText === prompt ? '현재 단계 복사됨' : '현재 단계 AI 인계문 복사'}</button>
      {progress && <button type="button" disabled={disabled} onClick={onRecheck} className={button}>AI 작업 후 다시 확인</button>}
    </div>
    {!progress && <p className="mt-2 text-sm text-[var(--ink-2)]">먼저 위에서 사용할 도구를 선택하고 준비 목록을 저장하세요.</p>}
    {prompt && <details className="mt-3 text-sm"><summary className="cursor-pointer">AI에 전달할 내용 확인</summary><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs">{prompt}</pre></details>}
    {fallbackText && fallbackText === prompt && <div role="alert" className="mt-3 text-sm">자동 복사가 되지 않았습니다. 아래 내용을 선택해 복사하세요.
      <textarea aria-label="직접 복사할 AI 인계문" readOnly value={prompt} onFocus={event => event.currentTarget.select()} className="mt-2 min-h-32 w-full rounded border border-[var(--line)] bg-[var(--surface)] p-2 text-xs" />
    </div>}
  </section>;
}
