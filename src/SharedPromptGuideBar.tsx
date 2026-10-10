import {memo, useEffect, useMemo, useState} from 'react';
import {isTauri} from '@tauri-apps/api/core';
import {PromptGuideBar, type PromptGuideBarProps} from './PromptGuideBar';
import {createSharedPromptGuideClient} from './sharedPromptGuideClient';
import {getSupabaseClient} from './lib/supabaseClient';
import {promptGuideClient} from './promptGuideClient';

const importLocalGuides = () => promptGuideClient.read();
const copyWithBrowserClipboard = async (text: string) => {
  try {await navigator.clipboard.writeText(text);}
  catch {throw new Error('복사하지 못했습니다. 해당 항목을 열고 본문을 길게 눌러 복사해 주세요.');}
};

export function SharedPromptGuideBar({client, desktop = false, loadSuggestions, workroom}: {
  client: Parameters<typeof createSharedPromptGuideClient>[0]; desktop?: boolean;
  loadSuggestions?: PromptGuideBarProps['loadSuggestions'];
  workroom?: PromptGuideBarProps['workroom'];
}) {
  const repository = useMemo(() => createSharedPromptGuideClient(client), [client]);
  // Stable props so the memoized bar skips the host's frequent re-renders.
  return <PromptGuideBar repository={repository} shared loadSuggestions={loadSuggestions} workroom={workroom} publishToTools={desktop}
    importLocal={desktop ? importLocalGuides : undefined}
    copyText={desktop ? undefined : copyWithBrowserClipboard} />;
}

/** Resolve only the existing configured deployment; opening does not upload local prompts. */
export const DesktopPromptGuideBar = memo(function DesktopPromptGuideBar({loadSuggestions, workroom}: Pick<PromptGuideBarProps, 'loadSuggestions' | 'workroom'>) {
  const [config, setConfig] = useState<{supabaseUrl: string; supabaseAnonKey: string} | null | undefined>();
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    void fetch(isTauri()?'http://127.0.0.1:3001/api/portal':'/api/portal', {signal:controller.signal}).then(r => {
      if(!r.ok) throw new Error('config unavailable'); return r.json();
    }).then(data => {if (active) setConfig(data?.supabaseUrl && data?.supabaseAnonKey ? data : null);}).catch(() => {if (active) setConfig(null);}).finally(() => clearTimeout(timer));
    return () => {active = false; clearTimeout(timer); controller.abort();};
  }, []);
  if(config === undefined) return <span className="text-xs">프롬프트 보관함 연결 중…</span>;
  return config ? <SharedPromptGuideBar client={getSupabaseClient(config.supabaseUrl,config.supabaseAnonKey)} desktop loadSuggestions={loadSuggestions} workroom={workroom}/>
    : <PromptGuideBar loadSuggestions={loadSuggestions} workroom={workroom} publishToTools/>;
});
