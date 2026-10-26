import React, {useEffect, useRef} from 'react';
import {createPortal} from 'react-dom';
import {CommunityThreadView} from './CommunityWorkspace';
import type {WorkroomMentionProject} from './workroomProjectMention';
import type {WorkroomTransport} from './WorkroomSessionFooter';
import {localUsePhonesFor} from './serviceUseLocalClient';

/** A USE mention opens the same bounded product conversation used by Community, never a DEV CLI. */
export function WorkroomUseConversation({project,scope,transport,draft,onAccepted,onClose,drafts,recipients,onDraftChange}: {
  project: WorkroomMentionProject; scope: string; transport: WorkroomTransport; draft: string;
  onAccepted: () => void; onClose: () => void;
  drafts: Map<string,string>; recipients: Map<string,string[]>; onDraftChange: () => void;
}) {
  const dialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{dialog.current?.showModal();},[]);
  return createPortal(<dialog ref={dialog} className="community-workroom-dialog" aria-label={project.label+' · 제품 운영'} onCancel={onClose} onClose={onClose}>
    <button type="button" className="ai-terminal-btn" onClick={onClose}>USE 대화 닫기</button>
    <CommunityThreadView scope={scope} targetId={project.targetId} label={project.label} projects={[project]} transport={transport} visible
      initialRole="use" serviceKey={project.serviceKey} initialDraft={draft} drafts={drafts} recipients={recipients}
      onOpen={()=>{}} onAccepted={onAccepted} onDraftChange={onDraftChange} usePhones={localUsePhonesFor(transport)}/>
  </dialog>,document.body);
}
