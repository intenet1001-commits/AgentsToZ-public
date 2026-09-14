import {useEffect, useMemo, useState} from 'react';
import {PromptGuideBar, type PromptGuideBarProps} from './PromptGuideBar';
import {createSharedPromptGuideClient} from './sharedPromptGuideClient';
import {getSupabaseClient} from './lib/supabaseClient';
import {promptGuideClient} from './promptGuideClient';

export function SharedPromptGuideBar({client, desktop = false, loadSuggestions}: {
  client: Parameters<typeof createSharedPromptGuideClient>[0]; desktop?: boolean;
  loadSuggestions?: PromptGuideBarProps['loadSuggestions'];
}) {
  const repository = useMemo(() => createSharedPromptGuideClient(client), [client]);
  return <PromptGuideBar repository={repository} shared loadSuggestions={loadSuggestions}
    importLocal={desktop ? () => promptGuideClient.read() : undefined}
    copyText={desktop ? undefined : async text => {
      try {await navigator.clipboard.writeText(text);}
      catch {throw new Error('복사하지 못했습니다. 해당 가이드를 열고 본문을 길게 눌러 복사해 주세요.');}
    }} />;
}

/** Resolve only the existing configured deployment; opening does not upload local prompts. */
export function DesktopPromptGuideBar({loadSuggestions}: Pick<PromptGuideBarProps, 'loadSuggestions'>) {
  const [config, setConfig] = useState<{supabaseUrl: string; supabaseAnonKey: string} | null | undefined>();
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    void fetch('http://127.0.0.1:3001/api/portal', {signal:controller.signal}).then(r => {
      if(!r.ok) throw new Error('config unavailable'); return r.json();
    }).then(data => {if (active) setConfig(data?.supabaseUrl && data?.supabaseAnonKey ? data : null);}).catch(() => {if (active) setConfig(null);}).finally(() => clearTimeout(timer));
    return () => {active = false; clearTimeout(timer); controller.abort();};
  }, []);
  if(config === undefined) return <span className="text-xs">프롬프트 보관함 연결 중…</span>;
  return config ? <SharedPromptGuideBar client={getSupabaseClient(config.supabaseUrl,config.supabaseAnonKey)} desktop loadSuggestions={loadSuggestions}/>
    : <PromptGuideBar loadSuggestions={loadSuggestions}/>;
}
