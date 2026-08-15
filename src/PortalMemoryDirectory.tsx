/**
 * 배포 포털의 「장기기억」 화면.
 *
 * 이 화면은 기억을 **연동해 주지 않는다.** 브라우저 단독이라 로컬 API(3001)에 닿을 수 없어
 * 파일을 쓸 수 없기 때문이다. 할 수 있는 일은 Supabase 를 직접 읽어 **어떤 기억이 있고 그
 * ID 가 무엇인지** 보여주고, 그 ID 를 복사해 주는 것까지다. 실제 연동은 그 ID 를 다른 기기
 * 앱의 「다른 기억에 합류」 칸이나 Hermes `/memory_link` 에 붙여넣어 일어난다.
 *
 * 저장소가 없는 기억은 `github_url` 로 서로를 찾을 수 없어 이 경로가 **유일한 연결 수단**이다
 * (실측 2026-08-14: 기억 43개 중 36개가 저장소 없음).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Brain, Check, Copy, Github, RefreshCw, Search, X } from 'lucide-react';
import { getSupabaseClient } from './lib/supabaseClient';
import {
  describeMemoryQueryFailure,
  filterMemoryDirectory,
  loadMemoryDirectory,
  MEMORY_LIST_COLUMNS,
  MEMORY_REVISION_WINDOW,
  type MemoryDirectoryEntry,
  type MemoryDirectoryLoad,
} from './projectMemoryDirectory';

interface Props {
  supabaseUrl: string;
  supabaseKey: string;
  /** 포털의 showToast 는 type 을 필수로 받는다 — 시그니처를 넓히면 호출부가 안 맞는다. */
  showToast: (message: string, type: 'success' | 'error') => void;
}

export default function PortalMemoryDirectory({ supabaseUrl, supabaseKey, showToast }: Props) {
  const [loadedDirectory, setLoaded] = useState<MemoryDirectoryLoad | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ entry: MemoryDirectoryEntry; content: string } | null>(null);
  const [viewLoading, setViewLoading] = useState(false);
  // 화면 게이트는 localStorage 플래그만 본다 — 세션이 만료돼도 앱은 렌더된다.
  // 그래서 "로그인했는지"를 여기서 직접 확인해야 실패 원인을 바르게 말할 수 있다.
  const [hasSession, setHasSession] = useState<boolean | undefined>(undefined);

  const sb = useCallback(() => getSupabaseClient(supabaseUrl, supabaseKey), [supabaseUrl, supabaseKey]);

  const load = useCallback(async (force = false) => {
    setLoading(true);
    setError('');
    try {
      // ⚠️ 세션 복원을 **기다린 뒤에** 쿼리한다. supabase-js 는 저장소에서 세션을
      // 비동기로 되살리는데, 화면 게이트는 localStorage 플래그로 즉시 통과시키므로
      // 마운트 직후에 쏘면 JWT 가 붙기 전이라 anon 으로 나간다. 포트는 anon 에게도
      // 열려 있어 멀쩡히 보이고 이 테이블만 42501 로 거부된다 — "로그인했는데 안 된다"의
      // 정체가 이것이다. getSession() 은 복원이 끝난 뒤 resolve 한다.
      const { data: sessionData } = await sb().auth.getSession();
      setHasSession(!!sessionData.session);
      // 기기로 거르지 않는다 — 다른 기기의 기억을 찾는 것이 이 화면의 목적이다.
      // 프로젝트 행의 칩과 같은 결과를 공유한다(중복 조회 방지).
      const loaded = await loadMemoryDirectory(`${supabaseUrl}::${supabaseKey}`, () => sb()
        .from('portmgr_project_memory_revisions')
        .select(MEMORY_LIST_COLUMNS)
        .order('created_at', { ascending: false })
        .limit(MEMORY_REVISION_WINDOW), { force });
      setLoaded(loaded);
    } catch (e: any) {
      let session: boolean | undefined;
      try {
        const { data: sessionData } = await sb().auth.getSession();
        session = !!sessionData.session;
      } catch { /* 세션 조회 실패는 "모름"으로 남긴다 — 원인을 지어내지 않는다 */ }
      setHasSession(session);
      setError(describeMemoryQueryFailure(e, session));
      setLoaded(null);
    } finally {
      setLoading(false);
    }
  }, [sb]);

  const signIn = async () => {
    try {
      await sb().auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.origin + '/' },
      });
    } catch (e: any) {
      showToast(`로그인을 시작하지 못했습니다: ${e?.message ?? String(e)}`, 'error');
    }
  };

  useEffect(() => { void load(); }, [load]);

  // 로그인/토큰 갱신이 늦게 도착해도 목록이 스스로 채워지게 한다. 이게 없으면 사용자가
  // 로그인한 뒤 탭을 다시 열어야만 보인다.
  useEffect(() => {
    const { data: { subscription } } = sb().auth.onAuthStateChange((event) => {
      // TOKEN_REFRESHED 는 뺀다 — 토큰 갱신으로 기억 목록이 바뀌지 않는다.
      if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') void load();
    });
    return () => subscription.unsubscribe();
  }, [sb, load]);

  const entries = loadedDirectory?.entries ?? [];
  const visible = useMemo(() => filterMemoryDirectory(entries, query), [loadedDirectory, query]);
  const windowFull = loadedDirectory?.windowFull ?? false;

  const copyMemoryId = async (memoryId: string) => {
    try {
      await navigator.clipboard.writeText(memoryId);
      setCopied(memoryId);
      setTimeout(() => setCopied(current => (current === memoryId ? null : current)), 2000);
      showToast('장기기억 ID를 복사했습니다', 'success');
    } catch {
      showToast('클립보드에 복사하지 못했습니다', 'error');
    }
  };

  const openContent = async (entry: MemoryDirectoryEntry) => {
    setViewLoading(true);
    try {
      // 목록에서는 content 를 받지 않는다 — 문서 하나가 수십 KB라 목록 전체를 끌면 느려진다.
      const { data, error: queryError } = await sb()
        .from('portmgr_project_memory_revisions')
        .select('content')
        .eq('memory_id', entry.memoryId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (queryError) throw queryError;
      setViewing({ entry, content: (data as { content?: string } | null)?.content ?? '' });
    } catch (e: any) {
      showToast(`기억 내용을 불러오지 못했습니다: ${e?.message ?? String(e)}`, 'error');
    } finally {
      setViewLoading(false);
    }
  };

  return (
    <div data-testid="portal-memory-directory" className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-2 text-sm text-zinc-200">
          <Brain className="w-4 h-4 text-teal-400" />
          장기기억 <span className="text-zinc-500 text-xs">{entries.length}개</span>
        </div>
        <div className="relative ml-auto">
          <Search className="w-3.5 h-3.5 text-zinc-600 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            data-testid="portal-memory-search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="이름 · ID · 저장소 · 기기"
            className="pl-8 pr-3 py-1.5 w-56 bg-zinc-900 border border-zinc-800 rounded-lg text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-teal-500/50"
          />
        </div>
        <button
          onClick={() => void load(true)}
          disabled={loading}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-zinc-400 border border-zinc-800 rounded-lg hover:text-zinc-200 hover:bg-zinc-800/60 disabled:opacity-40">
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
          새로고침
        </button>
      </div>

      <p className="text-[11px] text-zinc-500 leading-relaxed">
        이 화면은 ID를 건네주는 곳입니다. 여기서 기억이 기기에 설치되지는 않습니다 — 복사한 ID를
        상대 기기의 AgentsToZ 앱 「다른 기억에 합류」 칸이나 Hermes <code className="text-zinc-400">/memory_link</code>에 붙여넣으세요.
        저장소가 없는 기억은 이 ID가 유일한 연결 수단입니다.
      </p>

      {error && (
        <div data-testid="portal-memory-error" className="text-xs text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg p-3">
          <span className="whitespace-pre-wrap">장기기억 목록을 불러오지 못했습니다: {error}</span>
          {hasSession === false && (
            <div className="mt-2">
              <button
                data-testid="portal-memory-signin"
                onClick={() => void signIn()}
                className="px-2.5 py-1.5 text-xs text-teal-200 border border-teal-500/30 bg-teal-500/10 rounded-lg hover:bg-teal-500/20">
                Google로 다시 로그인
              </button>
            </div>
          )}
        </div>
      )}

      {windowFull && (
        <div data-testid="portal-memory-window-warning" className="text-[11px] text-amber-300/90 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
          최근 리비전 {MEMORY_REVISION_WINDOW}건만 조회했습니다. 오래된 기억은 이 목록에 없을 수 있습니다.
        </div>
      )}

      {!error && !loading && entries.length === 0 && (
        <p className="text-xs text-zinc-500">아직 Supabase에 백업된 장기기억이 없습니다.</p>
      )}

      <div className="space-y-1.5">
        {visible.map(entry => (
          <div
            key={entry.memoryId}
            data-testid="portal-memory-row"
            data-memory-id={entry.memoryId}
            className="border border-zinc-800/80 rounded-lg px-3 py-2.5 bg-zinc-900/40 hover:border-zinc-700 transition-colors">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm text-zinc-100 font-medium">{entry.projectName}</span>
              {entry.githubUrl ? (
                <a href={entry.githubUrl} target="_blank" rel="noreferrer"
                  className="flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-300">
                  <Github className="w-3 h-3" />저장소
                </a>
              ) : (
                <span className="text-[10px] text-amber-300/70 border border-amber-500/20 rounded px-1.5 py-0.5">저장소 없음 · ID로만 연결</span>
              )}
              <span className="ml-auto text-[10px] text-zinc-600">
                {entry.updatedAt ? new Date(entry.updatedAt).toLocaleString('ko-KR') : '시각 미상'}
                {entry.lastDeviceName ? ` · ${entry.lastDeviceName}` : ''}
                {entry.deviceCountInWindow > 1 ? ` 외 ${entry.deviceCountInWindow - 1}대` : ''}
              </span>
            </div>
            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
              <code className="text-[11px] text-zinc-400 font-mono break-all">{entry.memoryId}</code>
              <button
                data-testid="portal-memory-copy-id"
                onClick={() => void copyMemoryId(entry.memoryId)}
                title="이 ID를 다른 기기의 앱이나 Hermes /memory_link 에 붙여넣으세요"
                className="flex items-center gap-1 px-2 py-1 text-[10px] text-teal-300 border border-teal-500/25 bg-teal-500/5 rounded hover:bg-teal-500/10">
                {copied === entry.memoryId ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                ID 복사
              </button>
              <button
                data-testid="portal-memory-view"
                onClick={() => void openContent(entry)}
                disabled={viewLoading}
                className="px-2 py-1 text-[10px] text-zinc-400 border border-zinc-800 rounded hover:text-zinc-200 hover:bg-zinc-800/60 disabled:opacity-40">
                내용 보기
              </button>
            </div>
          </div>
        ))}
        {!loading && entries.length > 0 && visible.length === 0 && (
          <p className="text-xs text-zinc-500">검색 결과가 없습니다.</p>
        )}
      </div>

      {viewing && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={() => setViewing(null)}>
          <div
            data-testid="portal-memory-viewer"
            className="bg-[#111113] border border-zinc-800 rounded-xl w-full max-w-3xl max-h-[80vh] flex flex-col"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-800">
              <Brain className="w-4 h-4 text-teal-400" />
              <span className="text-sm text-zinc-100">{viewing.entry.projectName}</span>
              <code className="text-[10px] text-zinc-600 font-mono">{viewing.entry.memoryId}</code>
              <button onClick={() => setViewing(null)} className="ml-auto text-zinc-500 hover:text-zinc-200">
                <X className="w-4 h-4" />
              </button>
            </div>
            <pre className="flex-1 overflow-auto px-4 py-3 text-[11px] text-zinc-300 whitespace-pre-wrap break-words">
              {viewing.content || '(내용이 비어 있습니다)'}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
