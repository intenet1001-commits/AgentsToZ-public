import type { PromptGuideEntry } from './promptGuideClient';
import type { PromptKind } from './promptLibrary';

/**
 * 상단 「자주 쓰는 프롬프트」 막대(저장본의 주인)와 「도구 및 설정 → 도구·연결」의 규격 명령 버튼을 잇는 작은 연결부.
 * 저장본은 막대가 읽고 여기에 알리기만 한다 — 도구 영역이 따로 읽으면 같은 목록을 두 번 부르고
 * (로컬은 키체인 조회, 공유는 Supabase 왕복) 두 화면이 서로 다른 순간의 목록을 보여 줄 수 있다.
 */
type Listener = () => void;
let entries: readonly PromptGuideEntry[] | null = null;
const listeners = new Set<Listener>();
let openHandler: ((kind: PromptKind) => void) | null = null;

export const promptLibraryHub = {
  publish(next: readonly PromptGuideEntry[] | null) { entries = next; for (const listener of listeners) listener(); },
  snapshot: () => entries,
  subscribe(listener: Listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  /** Returns false when no library dialog is mounted (e.g. still connecting). */
  requestOpen(kind: PromptKind): boolean { if (!openHandler) return false; openHandler(kind); return true; },
  setOpenHandler(handler: ((kind: PromptKind) => void) | null) { openHandler = handler; },
};
