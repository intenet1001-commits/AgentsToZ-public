import React from 'react';
export type FirstProjectChoice = 'new' | 'existing';
export type ControlCenterChoice = 'create' | 'restore';
export interface FirstProjectActions {
  onStartProject?: (choice: FirstProjectChoice) => void;
  onStartControl?: (choice: ControlCenterChoice) => void;
  onOpenProjects?: () => void;
  onPrepareAI: () => void;
}
/** Rendering is read-only. Creation starts only from the user's explicit button
 * action, and the parent owns folder selection, registration, and receipts. */
export default function OnboardingFirstProject({onStartProject,onStartControl,onOpenProjects,onPrepareAI}:FirstProjectActions) {
  const button='min-h-11 rounded-xl border border-[var(--line)] px-4 py-3 text-left text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]';
  return <section aria-label="첫 프로젝트 시작" className="rounded-2xl border border-[var(--accent-line)] bg-[var(--accent-soft)] p-5">
    <h3 className="text-lg font-bold text-[var(--ink)]">어떤 작업부터 시작할까요?</h3>
    <p className="mt-2 text-sm leading-relaxed text-[var(--ink-2)]">프로젝트는 계정 없이 이 기기에서 시작할 수 있습니다. AI나 GitHub 연결은 필요할 때 추가하세요.</p>
    {onStartControl && <div data-testid="onboarding-control-center" className="mt-4 rounded-xl border border-[var(--accent-line)] bg-[var(--surface)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-extrabold text-[var(--ink)]">먼저 내 Control 관제센터 준비</p>
          <p className="mt-1 text-xs leading-relaxed text-[var(--ink-2)]">프로젝트 사이의 역할과 공동 결정을 기억할 <code>AgentsToZ-Control</code>을 Git과 장기기억까지 함께 만듭니다.</p>
        </div>
        <span className="rounded-full bg-[var(--accent-soft)] px-2 py-1 text-[10px] font-bold text-[var(--accent)]">권장</span>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <button type="button" data-testid="onboarding-create-control" className={`${button} bg-[var(--accent)] text-[var(--on-accent)]`} onClick={()=>onStartControl('create')}>내 Control 자동 만들기</button>
        <button type="button" data-testid="onboarding-restore-control" className={`${button} bg-[var(--surface)] text-[var(--ink)]`} onClick={()=>onStartControl('restore')}>다른 Mac의 Control 복원</button>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-[var(--ink-3)]">처음이면 자동 생성을, 이미 Private GitHub 저장소가 있으면 복원을 선택하세요.</p>
    </div>}
    <div className="mt-4 grid gap-2 sm:grid-cols-2">
      {onStartProject ? <>
        <button type="button" className={`${button} bg-[var(--accent)] text-[var(--on-accent)]`} onClick={()=>onStartProject('new')}>새 프로젝트 만들기</button>
        <button type="button" className={`${button} bg-[var(--surface)] text-[var(--ink)]`} onClick={()=>onStartProject('existing')}>가지고 있는 폴더 열기</button>
      </> : <a className={`${button} bg-[var(--surface)] text-[var(--ink)]`} href="/">앱 작업 공간에서 프로젝트 시작</a>}
      <button type="button" className={button} onClick={onPrepareAI}>AI 연결 준비하기</button>
      {onOpenProjects&&<button type="button" className={button} onClick={onOpenProjects}>등록한 프로젝트 이어서 열기</button>}
    </div>
    <p className="mt-3 text-xs leading-relaxed text-[var(--ink-3)]">폴더를 등록한 뒤 프로젝트 목록에서 다시 열어 보세요. AI 준비 확인과 실제 첫 작업 성공은 각각 확인합니다.</p>
  </section>;
}
