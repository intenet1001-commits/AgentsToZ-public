import React from 'react';
import {createRoot} from 'react-dom/client';
import {VocOverlay} from '../../src/voc/VocOverlay';
import {PinnedCommandButtons} from '../../src/components/PinnedCommandButtons';
import type {VocAttachment} from '../../src/voc/vocAttachments';
import {buildVocAttachmentPayload} from '../../src/voc/vocAttachments';
import '../../src/index.css';

// Isolated VOC form + tools row. No sidecar, no Workroom: handlers record into window.
declare global { interface Window {
  __submits: Array<Record<string, unknown>>; __workroom: Array<{title: string; prompt: string}>; __closed: number;
} }
window.__submits = []; window.__workroom = []; window.__closed = 0;
const onSubmit = async (input: {comment: string; attachments: VocAttachment[]}) => {
  const body = {comment: input.comment, ...buildVocAttachmentPayload(input.attachments)};
  window.__submits.push(body);
  const count = (body.images?.length ?? 0) + (body.imagePaths?.length ?? 0);
  return {file: '2026-09-27-1200-fixture-target.json', id: 'id-1', attachments: Array.from({length: count}, (_, i) => `/data/voc/attachments/fixture-${i + 1}.png`)};
};
function Host() {
  return <main style={{padding: 24, paddingTop: 60}}>
    <section data-testid="fixture-tools" style={{display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center'}}>
      <PinnedCommandButtons projectPath="/projects/AgentsToZ_byCS" notify={() => {}} onRunInWorkroom={(title, prompt) => window.__workroom.push({title, prompt})} />
    </section>
    <button data-testid="fixture-target" style={{marginTop: 40, padding: '8px 16px'}}>개선할 버튼</button>
    <VocOverlay
      onClose={() => { window.__closed += 1; }}
      onSubmit={onSubmit as never}
      onOpenWorkroom={(title, prompt) => window.__workroom.push({title, prompt})}
      projectPath="/projects/AgentsToZ_byCS"
      onLoadInbox={async () => []}
      onUpdateInboxItem={async () => true}
      onDeleteInboxItem={async () => true}
      onLoadPortalErrors={async () => []}
      tab="projects" appVersion="v0 fixture" remoteUnlimited={false}
    />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Host />);
