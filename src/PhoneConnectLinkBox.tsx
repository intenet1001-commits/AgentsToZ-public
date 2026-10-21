/**
 * 「① 데이터 연결 · 폰 연결 링크」 box of the Internet remote-control dialog.
 *
 * Split out so the QR dialog itself keeps its rule of never touching the clipboard: this box
 * can only receive a PhoneConnectLinkText (public Supabase URL, anon key, portal origin, Mac
 * label — no pairing secret), never the QR's pairing URL.
 */
import type { PhoneConnectLinkText } from './phoneConnectLink';

export function PhoneConnectLinkBox({ link, unavailable, onNotice }: {
  link: PhoneConnectLinkText | null;
  unavailable: string;
  onNotice: (notice: { kind: 'success' | 'error'; message: string }) => void;
}) {
  const copy = () => {
    if (!link) return;
    void navigator.clipboard?.writeText(link).then(
      () => onNotice({ kind: 'success', message: '폰 연결 링크를 복사했습니다. 카카오톡 「나와의 채팅」 등으로 iPhone에 보내세요. 이 링크로는 Mac을 제어할 수 없습니다.' }),
      () => onNotice({ kind: 'error', message: '복사하지 못했습니다. 아래 링크를 직접 선택해 복사하세요.' }),
    );
  };
  return <div className="mt-2 rounded-lg border border-[rgb(var(--surface-highlight-rgb))]/10 p-2" data-testid="phone-connect-link">
    <span className="block text-zinc-300"><strong className="text-zinc-200">① 데이터 연결 · 폰 연결 링크</strong> — Mac 앞이 아니어도 됩니다.
      카카오톡 「나와의 채팅」 등으로 iPhone에 보내 누르거나, 앱 첫 화면의 「연결 링크 붙여넣기」에 붙여 넣으세요.
      이메일 코드로 로그인하면 프로젝트 현황·북마크·기록·장기기억을 볼 수 있습니다.</span>
    <span className="mt-1 block text-zinc-500">링크에는 Supabase 주소·공개 키·포털 주소·Mac 이름만 들어 있습니다. 이 링크로는 Mac을 제어할 수 없습니다 — ② Mac 제어는 이 화면의 QR을 스캔하고 6자리 코드를 승인해야 합니다.</span>
    {link ? <>
      <code data-testid="phone-connect-link-text" className="mt-1 block max-h-16 overflow-auto break-all rounded-lg bg-[rgb(var(--surface-shade-rgb))]/30 px-2 py-1 text-sky-200">{link}</code>
      <button type="button" data-testid="phone-connect-link-copy" onClick={copy}
        className="mt-1 flex min-h-11 items-center gap-1.5 rounded-xl border border-[rgb(var(--surface-highlight-rgb))]/10 px-3 text-xs text-zinc-200 hover:bg-[rgb(var(--surface-highlight-rgb))]/5">폰 연결 링크 복사</button>
    </> : <span className="mt-1 block text-zinc-500" data-testid="phone-connect-link-unavailable">{unavailable}</span>}
  </div>;
}
