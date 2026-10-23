import { useEffect, useMemo, useRef, useState } from 'react';
import { ClipboardCopyButton } from '../ClipboardCopyButton';
import { openPreferredBrowser } from '../openPreferredBrowser';
import { buildDeveloperErrorReport, DEVELOPER_ERROR_REPORT_URL } from './developerReportContent';

export function DeveloperErrorReport({ comment, tab, appVersion }: { comment: string; tab: string; appVersion: string }) {
  const preview = useMemo(() => buildDeveloperErrorReport({ comment, tab, appVersion }), [comment, tab, appVersion]);
  const [draft, setDraft] = useState(preview);
  useEffect(() => setDraft(preview), [preview]);
  const [opening, setOpening] = useState(false);
  const openPending = useRef(false);
  const [notice, setNotice] = useState('');
  async function open() {
    if (openPending.current) return;
    openPending.current = true;
    setOpening(true); setNotice('');
    try {
      await openPreferredBrowser(DEVELOPER_ERROR_REPORT_URL);
      setNotice('신고창 열기를 요청했습니다. 복사한 내용을 붙여넣고 직접 제출해 주세요. 이 앱에서는 접수 여부를 확인하지 않습니다.');
    } catch {
      setNotice('신고창을 열지 못했습니다. 아래 주소를 복사해 브라우저에서 열어 주세요. 작성한 내용은 유지됩니다.');
    } finally { openPending.current = false; setOpening(false); }
  }
  return <details data-testid="developer-error-report" style={{ marginTop: 8, fontSize: 11, lineHeight: 1.5 }}>
    <summary style={{ cursor: 'pointer', fontWeight: 600 }}>개발자에게 오류 신고 · GitHub</summary>
    <p>GitHub 계정으로 제출하는 공개 신고입니다. 아래 내용을 확인하고 개인정보를 지운 뒤 복사하세요. 사진·파일·로그는 자동 첨부되지 않습니다.</p>
    <textarea data-testid="developer-error-report-preview" aria-label="개발자 신고 내용 미리보기" value={draft}
      onChange={event => setDraft(event.target.value)} maxLength={8000} style={{ width: '100%', minHeight: 120, boxSizing: 'border-box', background: 'var(--bg-base)', color: 'var(--ink)', border: '1px solid var(--line)', borderRadius: 6, padding: 8, fontSize: 11 }} />
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
      <ClipboardCopyButton value={draft} label="1. 신고 내용 복사" copyingLabel="복사 중…" copiedLabel="신고 내용 복사됨"
        successMessage="복사는 신고 접수가 아닙니다. GitHub 신고창에서 직접 제출해 주세요." errorMessage="미리보기 내용을 직접 선택해 복사해 주세요."
        disabled={!comment.trim() || !draft.trim()} testId="developer-error-report-copy" className="min-h-11 rounded border border-[var(--line)] px-2" />
      <button type="button" data-testid="developer-error-report-open" onClick={() => void open()} disabled={opening} style={{ minHeight: 44, padding: '6px 8px', border: '1px solid var(--line)', borderRadius: 6 }}>
        {opening ? '열기 요청 중…' : '2. GitHub 신고창 열기'}
      </button>
    </div>
    {notice && <p role="status">{notice}</p>}
    <p style={{ overflowWrap: 'anywhere', fontSize: 10 }}><a href={DEVELOPER_ERROR_REPORT_URL} target="_blank" rel="noopener noreferrer">{DEVELOPER_ERROR_REPORT_URL}</a></p>
  </details>;
}
