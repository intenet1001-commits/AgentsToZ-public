import React from 'react';
import {createRoot} from 'react-dom/client';
import {SharedPromptGuideBar} from '../../src/SharedPromptGuideBar';
import '../../src/index.css';
import '../../src/remote-control-portal.css';

// Isolated transport. The fixture cannot access sidecar credentials or production.
const client = {rpc(name: string, args?: Record<string, unknown>) {
  return {abortSignal: (signal: AbortSignal) => fetch('/fixture-rpc/'+name, {
    method:'POST',body:JSON.stringify(args),signal,
  }).then(r=>r.json())};
}};
createRoot(document.getElementById('root')!).render(<React.StrictMode><main className="workspace-prompt-guides" style={{padding:24}}>
  <SharedPromptGuideBar client={client}/>
</main></React.StrictMode>);
