import React, {useState} from 'react';
import type { QrRemoteControlAction, QrRemoteControlProjectCard } from './qrRemoteControlContract';
import {remoteProjectMentionClipboard} from './workroomProjectMention';
import {remoteControlActionLabel, remoteProjectStatusLabel} from './remoteControlScreenText';

// The labels and the status line are shared with the same-Wi-Fi QR page (remoteControlScreenText.ts).
export {remoteControlActionLabel};
const statusLabel = remoteProjectStatusLabel;

const PROCESS_ACTIONS: QrRemoteControlAction[] = ['start', 'stop', 'restart'];
const PROJECT_UTILITY_ACTIONS: QrRemoteControlAction[] = [
  'folder.open', 'localhost.open', 'orca.open',
];
const ORCA_ACTIONS: QrRemoteControlAction[] = [
  'agent.claude', 'agent.codex', 'agent.agy', 'agent.hermes',
  // Paired clients from old builds can still carry app.claude. It now follows
  // the safe Orca CLI route and belongs with these launch surfaces.
  'app.claude',
];
const REOPEN_ACTIONS: QrRemoteControlAction[] = [
  'app.codex', 'app.hermes',
];
const FIRST_CONVERSATION_ACTIONS: QrRemoteControlAction[] = [
  'codex.thread.start',
];
const GIT_ACTIONS: QrRemoteControlAction[] = [
  'git.commit', 'git.pull', 'git.push', 'git.merge', 'worktree.add', 'worktree.add.orca',
];

export function RemoteControlProjectCard(props: {
  project: QrRemoteControlProjectCard;
  busy: boolean;
  onWorkroom?(project: QrRemoteControlProjectCard): void;
  onManage?(project: QrRemoteControlProjectCard): void;
  onAction(project: QrRemoteControlProjectCard, action: QrRemoteControlAction): void;
}) {
  const { project, busy, onAction, onWorkroom, onManage } = props;
  const [copyState,setCopyState]=useState<'idle'|'copied'|'failed'>('idle');
  const copyMention=async()=>{
    try{
      await navigator.clipboard.writeText(remoteProjectMentionClipboard(project.name,project.controlId));
      setCopyState('copied');
    }catch{setCopyState('failed');}
    window.setTimeout(()=>setCopyState('idle'),1600);
  };
  return (
    <article className="remote-project" data-testid="remote-project-card">
      <div className="remote-project-title"><h2>{project.name}</h2><span>{project.kind === 'worktree' ? 'WORKTREE' : 'PROJECT'}</span></div>
      {project.alias && <p className="remote-project-alias" data-testid="remote-project-alias">별명 · {project.alias}</p>}
      {project.workspaceRoot && <p className="remote-project-root" data-testid="remote-project-root">작업 루트 · {project.workspaceRoot}</p>}
      {project.branch && (
        <p className="remote-project-branch" data-testid="remote-project-branch">
          {project.kind === 'worktree' ? '워크트리 브랜치' : '메인트리 브랜치'} · {project.branch}
        </p>
      )}
      <p className={`remote-project-status remote-project-status--${project.status}`}>{statusLabel(project)}</p>
      {/* One primary action stays open; the rest fold (VOC 2026-10-02 iPhone 17: ~10 buttons a card made 20 cards
          dozens of screens tall, read as 「Mac엔 100개인데 폰엔 몇 개뿐」). Process start/stop stays out — it is the
          one thing a running project needs at a glance. */}
      {onWorkroom && <div className="remote-actions remote-actions--primary">
        <button type="button" disabled={busy} onClick={()=>onWorkroom(project)}>워크룸에서 작업</button>
      </div>}

      {project.actions.some(action => PROCESS_ACTIONS.includes(action)) && <>
        <p className="remote-action-heading">프로세스</p>
        <div className="remote-actions remote-actions--process">
          {PROCESS_ACTIONS.map(action => (
            <button
              type="button"
              key={action}
              data-action={action}
              disabled={busy || !project.actions.includes(action)}
              onClick={() => onAction(project, action)}
            >{remoteControlActionLabel(action)}</button>
          ))}
        </div>
      </>}
      <details className="remote-project-more" data-testid="remote-project-more"><summary>더 보기 · 코드 복사·기억·Git·워크트리</summary>
      {onWorkroom && <div className="remote-actions remote-actions--secondary">
        <button type="button" disabled={busy} onClick={()=>void copyMention()}>{copyState==='copied'?'복사됨':copyState==='failed'?'복사 실패 · 다시 시도':'#프로젝트명 + 코드 복사'}</button>
        {onManage && <button type="button" disabled={busy} onClick={()=>onManage(project)}>기억·정리·테스트</button>}
      </div>}
      {project.actions.some(action => GIT_ACTIONS.includes(action)) && <>
        <p className="remote-action-heading">Git · 워크트리</p>
        {project.kind === 'main' && project.actions.some(action => action === 'worktree.add' || action === 'worktree.add.orca') && (
          <p className="remote-action-help">두 버튼은 중복이 아닙니다. 둘 다 같은 Git 워크트리를 만들지만, “Orca 등록”만 Orca 사이드바에 카드도 추가합니다. 한 종류만 선택하세요.</p>
        )}
        <div className="remote-actions remote-actions--git">
          {GIT_ACTIONS.filter(action => project.actions.includes(action)).map(action => (
            <button
              type="button"
              key={action}
              data-action={action}
              disabled={busy}
              onClick={() => onAction(project, action)}
            >{remoteControlActionLabel(action)}</button>
          ))}
        </div>
      </>}
      </details>
      <details className="remote-mac-actions"><summary>Mac에서 앱·폴더 열기</summary>
      {project.actions.some(action => FIRST_CONVERSATION_ACTIONS.includes(action)) && <>
        <p className="remote-action-heading">새 대화</p>
        <p className="remote-action-help">이 프로젝트·워크트리의 연결용 대화를 준비하고 Mac의 Codex 앱에 열기를 요청합니다. 실제 화면은 Mac에서 확인하세요.</p>
        <div className="remote-actions remote-actions--first-conversation">
          {FIRST_CONVERSATION_ACTIONS.filter(action => project.actions.includes(action)).map(action => (
            <button
              type="button"
              key={action}
              data-action={action}
              disabled={busy}
              onClick={() => onAction(project, action)}
            >{remoteControlActionLabel(action)}</button>
          ))}
        </div>
      </>}
      {project.actions.some(action => REOPEN_ACTIONS.includes(action)) && <>
        <p className="remote-action-heading">최근 대화 다시 열기</p>
        <p className="remote-action-help">정확히 연결된 최근 대화만 요청합니다. Hermes는 Desktop 실행과 딥링크 전달까지만 확인하며, 실제 대화 선택은 Mac의 앱에서 확인해야 합니다.</p>
        <div className="remote-actions remote-actions--reopen">
          {REOPEN_ACTIONS.filter(action => project.actions.includes(action)).map(action => (
            <button
              type="button"
              key={action}
              data-action={action}
              disabled={busy}
              onClick={() => onAction(project, action)}
            >{remoteControlActionLabel(action)}</button>
          ))}
        </div>
      </>}
      {project.actions.some(action => PROJECT_UTILITY_ACTIONS.includes(action)) && <>
        <p className="remote-action-heading">폴더 · localhost</p>
        <div className="remote-actions remote-actions--project">
          {PROJECT_UTILITY_ACTIONS.filter(action => project.actions.includes(action)).map(action => (
            <button
              type="button"
              key={action}
              data-action={action}
              disabled={busy}
              onClick={() => onAction(project, action)}
            >{remoteControlActionLabel(action)}</button>
          ))}
        </div>
      </>}
      {project.actions.some(action => ORCA_ACTIONS.includes(action)) && <>
        <p className="remote-action-heading">Orca에서 열기</p>
        <p className="remote-action-help">Claude · Codex · AGY · Hermes를 이 프로젝트에서 엽니다. 최초 로그인·약관 동의·폴더 신뢰 확인은 Mac의 Orca 화면에서 사용자가 한 번 직접 완료해야 합니다.</p>
        <div className="remote-actions remote-actions--orca">
        {ORCA_ACTIONS.filter(action => project.actions.includes(action)).map(action => (
          <button
            type="button"
            key={action}
            data-action={action}
            disabled={busy}
            onClick={() => onAction(project, action)}
          >{remoteControlActionLabel(action)}</button>
        ))}
        </div>
      </>}
      </details>
    </article>
  );
}
