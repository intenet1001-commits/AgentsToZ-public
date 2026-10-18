import React, {Profiler, useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {PromptGuideBar, type PromptWorkroomBridge} from '../../src/PromptGuideBar';
import {PinnedCommandButtons} from '../../src/components/PinnedCommandButtons';
import type {PromptGuideEntry, PromptGuideSnapshot} from '../../src/promptGuideClient';
import '../../src/index.css';

// Isolated in-memory library. Nothing here reaches a sidecar, Supabase or an AI.
declare global { interface Window {
  __library: PromptGuideSnapshot; __saves: PromptGuideEntry[][]; __workroomOpens: Array<{targetId: string; title: string; prompt: string}>;
  __toasts: string[]; __barRenderMs: number; __tick: () => void;
} }
const params = new URLSearchParams(location.search);
const seed = params.get('seed');
const unstable = params.get('unstable') === '1';
window.__library = {revision: seed ? '11111111-1111-4111-8111-111111111111' : '0', entries: seed ? JSON.parse(seed) : []};
window.__saves = []; window.__workroomOpens = []; window.__toasts = []; window.__barRenderMs = 0;
const repository = {
  async read() { return structuredClone(window.__library); },
  async save(revision: string, entries: PromptGuideEntry[]) {
    if (revision !== window.__library.revision) throw Object.assign(new Error('conflict'), {code: 'PROMPT_GUIDES_CONFLICT'});
    window.__saves.push(structuredClone(entries));
    window.__library = {revision: crypto.randomUUID(), entries: structuredClone(entries)};
    return structuredClone(window.__library);
  },
};
const workroom: PromptWorkroomBridge = {
  projects: [{id: 'project-aaaa-1111', label: '검증 프로젝트'}, {id: 'project-bbbb-2222', label: '다른 프로젝트'}],
  defaultProjectId: 'project-aaaa-1111',
  open: (targetId, title, prompt) => { window.__workroomOpens.push({targetId, title, prompt}); },
};
const copyText = async (text: string) => { (window as any).__copies = [...((window as any).__copies ?? []), text]; };
const notify = (message: string) => { window.__toasts.push(message); };

function Host() {
  // Simulates the App re-rendering (port polling, toasts) while the bar is mounted.
  const [tick, setTick] = useState(0);
  useEffect(() => { window.__tick = () => setTick(value => value + 1); }, []);
  return <main style={{padding: 24}} data-tick={tick}>
    <Profiler id="bar" onRender={(_id, _phase, actual) => { window.__barRenderMs += actual; }}>
      {/* ?unstable=1 reproduces the pre-fix host: a new callback prop on every render. */}
      <PromptGuideBar repository={repository} copyText={unstable ? (text => copyText(text)) : copyText} workroom={workroom} publishToTools />
    </Profiler>
    <section data-testid="fixture-tools" style={{marginTop: 24, display: 'flex', gap: 4, flexWrap: 'wrap'}}>
      <PinnedCommandButtons projectPath="/projects/AgentsToZ_byCS" notify={notify} />
    </section>
  </main>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Host /></React.StrictMode>);
