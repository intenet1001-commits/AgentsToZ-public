import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ErrorVocActions, ErrorVocProvider, RemoteVocComposer, type VocComposerPrefill} from '../../src/RemoteVocComposer';
import '../../src/index.css';
import '../../src/remote-control-portal.css';

// Isolated phone composer: no relay, no Supabase. Submissions and error actions record into window.
declare global { interface Window { __sent: Array<{mode: string; comment: string; images: number; error: string | null; source: string}>; __errorWorkroom: string[]; __share(detail: unknown): void } }
window.__sent = []; window.__errorWorkroom = [];
function Host() {
  const [prefill, setPrefill] = useState<VocComposerPrefill | null>(null);
  window.__share = (detail: {images: {bytes: number[]}[]; comment: string}) => setPrefill({source: 'phone-share', comment: detail.comment, images: detail.images.map(i => ({mime: 'image/png', bytes: new Uint8Array(i.bytes)}))});
  return <ErrorVocProvider value={{compose: error => setPrefill({source: 'phone-error', error, comment: ''}), workroom: error => window.__errorWorkroom.push(error.message)}}>
    <main className="remote-shell" style={{padding: 16}}>
      <button data-testid="fixture-open" onClick={() => setPrefill({source: 'phone', comment: ''})}>VOC</button>
      <div className="remote-task-error" role="alert">Mac이 응답하지 않습니다.<ErrorVocActions message="Mac이 응답하지 않습니다." surface="remote-tasks" /></div>
      {prefill && <RemoteVocComposer prefill={prefill} canUseWorkroom onClose={() => setPrefill(null)}
        onSubmit={async (mode, draft, progress) => { progress('보내는 중'); if (draft.comment === 'fail') throw new Error('사진이 전송 중 손상되어 VOC를 저장하지 않았습니다.'); window.__sent.push({mode, comment: draft.comment, images: draft.images.length, error: draft.error?.message ?? null, source: draft.source}); }} />}
    </main>
  </ErrorVocProvider>;
}
createRoot(document.getElementById('root')!).render(<Host />);
