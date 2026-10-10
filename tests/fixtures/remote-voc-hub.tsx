import React, {useEffect, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {RemoteVocComposer, type VocComposerPrefill} from '../../src/RemoteVocComposer';
import {RemoteVocHub, type RemoteVocInboxState} from '../../src/RemoteVocHub';
import {memoryVocShareBackend, openIndexedDbVocShareBackend, receiveVocShareDelivery, VocShareCaptureStore, type VocShareCapture} from '../../src/vocShareCaptureStore';
import {buildVocInboxWorkroomHandoff, buildVocItemWorkroomHandoff} from '../../src/voc/vocWorkroomHandoff';
import '../../src/index.css';
import '../../src/remote-control-portal.css';

// Isolated 「VOC」 hub: the real capture store (IndexedDB), the real share-intake order, the real
// Workroom drafts. No relay, no Supabase, no Mac — the inbox state is set from the test.
declare global { interface Window {
  __hubAcks: string[]; __hubSent: {comment: string; images: number}[]; __hubWorkroom: string[]; __hubNotices: string[];
  __hubDeliver(detail: unknown): Promise<string>; __hubSetInbox(state: RemoteVocInboxState): void; __hubCaptureIds(): Promise<string[]>;
} }
window.__hubAcks = []; window.__hubSent = []; window.__hubWorkroom = []; window.__hubNotices = [];
const storePromise = openIndexedDbVocShareBackend().then(b => new VocShareCaptureStore(b ?? memoryVocShareBackend()));
window.__hubCaptureIds = async () => (await (await storePromise).list()).map(c => c.id);

function Host() {
  const [prefill, setPrefill] = useState<VocComposerPrefill | null>(null);
  const [hub, setHub] = useState(false);
  const [captures, setCaptures] = useState<VocShareCapture[]>([]);
  const [inbox, setInbox] = useState<RemoteVocInboxState>({kind: 'offline'});
  const [notice, setNotice] = useState('');
  const openRef = useRef(false); openRef.current = !!prefill;
  const refresh = async () => setCaptures(await (await storePromise).list());
  useEffect(() => { void refresh(); }, []);
  const openCapture = (c: VocShareCapture) => { setHub(false); setPrefill({source: 'phone-share', comment: c.comment, images: c.images, screen: '사진 공유', captureId: c.id}); };
  const say = (m: string) => { window.__hubNotices.push(m); setNotice(m); };
  window.__hubSetInbox = setInbox;
  window.__hubDeliver = async detail => receiveVocShareDelivery({store: await storePromise, detail, ack: id => window.__hubAcks.push(id),
    composerOpen: () => openRef.current, openComposer: openCapture, notice: say, refresh});
  return <main className="remote-shell" style={{padding: 16}}>
    <button type="button" className="remote-voc-open" data-testid="remote-voc-open" onClick={() => { setHub(true); }}>VOC
      {captures.length > 0 && <b className="remote-voc-open-badge" data-testid="remote-voc-open-badge">{captures.length}</b>}</button>
    <p data-testid="fixture-notice">{notice}</p>
    {prefill && <RemoteVocComposer prefill={prefill} canUseWorkroom onClose={() => setPrefill(null)}
      onDismiss={draft => { const id = prefill.captureId; if (id) void storePromise.then(s => s.keep(id, {comment: draft.comment, images: draft.images})).then(refresh); }}
      onSubmit={async (_mode, draft) => { window.__hubSent.push({comment: draft.comment, images: draft.images.length}); if (prefill.captureId) { await (await storePromise).remove(prefill.captureId); await refresh(); } }} />}
    {hub && <RemoteVocHub onClose={() => setHub(false)} onCompose={() => { setHub(false); setPrefill({source: 'phone', comment: ''}); }}
      captures={captures} capturesPersistent onResumeCapture={id => void storePromise.then(s => s.get(id)).then(c => c && openCapture(c))}
      onDeleteCapture={async id => { await (await storePromise).remove(id); await refresh(); }}
      inbox={inbox} onRefreshInbox={() => {}} canUseWorkroom
      onProcessInbox={async () => { window.__hubWorkroom.push(buildVocInboxWorkroomHandoff().prompt); setHub(false); }}
      onProcessInboxItem={async item => { window.__hubWorkroom.push(buildVocItemWorkroomHandoff({file: item.file, comment: item.summary, source: item.source, photoCount: item.photos, commentIsSummary: true}).prompt); setHub(false); }} />}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Host />);
