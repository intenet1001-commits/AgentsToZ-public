import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { VocOverlay } from '../../../src/voc/VocOverlay';
declare global { interface Window { __reports: unknown[]; __clipboard: string[]; __configured: (value: boolean | null) => void; } }
window.__reports = []; window.__clipboard = [];
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { window.__clipboard.push(value); } } });
function Host() {
  const [configured, setConfigured] = useState<boolean | null>(false);
  useEffect(() => { window.__configured = setConfigured; }, []);
  return <main style={{ padding: '80px 20px' }}>
    <button data-testid="report-target" style={{ padding: 20 }}>오류가 난 버튼</button>
    <VocOverlay onClose={() => {}} onSubmit={async input => { window.__reports.push(input); return { file: 'fixture.json', id: 'fixture', attachments: [] }; }}
      onLoadInbox={async () => []} onUpdateInboxItem={async () => true} onDeleteInboxItem={async () => true} onLoadPortalErrors={async () => []}
      tab="projects" appVersion="fixture1149" remoteUnlimited={false} remoteConfigured={configured} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Host />);
