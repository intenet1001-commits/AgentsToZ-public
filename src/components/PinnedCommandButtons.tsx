import { memo, useMemo, useSyncExternalStore } from 'react';
import { Copy, ListChecks, Play } from 'lucide-react';
import { BUILTIN_COMMAND_TEST_IDS, pinnedCommands, withBuiltinCommands, workroomCommandBody } from '../promptLibrary';
import { promptLibraryHub } from '../promptLibraryHub';
import { copyAgentsToZPrompt } from '../whatISaidPromptOriginClient';
import { usePromptPreview } from './PromptPreview';

// 한 명령 = 붙어 있는 두 칸. 넓은 칸은 복사(예전 버튼 그대로), 작은 아이콘 칸은 워크룸 초안.
// 색은 의미 토큰만 쓴다(src/index.css) — 새 hex/rgba 리터럴 금지.
const groupClass = 'inline-flex items-stretch rounded-lg border border-[var(--line)] hover:border-[var(--line-2)] bg-[var(--bg-card)] overflow-hidden transition-colors';
const segmentClass = 'flex items-center gap-1 px-2 py-1.5 text-[10px] whitespace-nowrap text-[var(--ink-2)] hover:text-[var(--ink)] hover:bg-[var(--sunken)] transition-colors';
const iconSegmentClass = 'flex items-center justify-center px-1.5 border-l border-[var(--line)] text-[var(--ink-3)] hover:text-[var(--accent)] hover:bg-[var(--sunken)] transition-colors';
const manageClass = 'flex items-center gap-1 px-1.5 py-1.5 rounded-lg border border-dashed border-[var(--line)] hover:border-[var(--line-2)] text-[10px] whitespace-nowrap text-[var(--ink-3)] hover:text-[var(--ink)] transition-colors';

/**
 * 「도구 및 설정 → 도구·연결」의 규격 명령 복사 버튼. 목록의 주인은 「자주 쓰는 프롬프트」 저장본이고
 * 여기는 그 중 고정한 규격 명령만 저장 순서대로 그린다. 예전의 두 하드코딩 버튼은 기본 규격 명령이 되었고,
 * 사용자가 아직 손대지 않았으면 예전과 똑같이 현재 프로젝트 경로를 넣어 만든다. 같은 test id를 유지한다.
 * 저장본을 아직 못 읽었으면(연결 중·실패) 기본 명령만 보여 준다 — 예전 화면과 같다.
 */
export const PinnedCommandButtons = memo(function PinnedCommandButtons({ projectPath, notify, onRunInWorkroom }: {
  projectPath?: string;
  notify: (message: string, type: 'success' | 'error') => void;
  /** Opens the AgentsToZ DEV Workroom with the command as a draft; the user still presses start. */
  onRunInWorkroom?: (title: string, body: string) => void;
}) {
  const stored = useSyncExternalStore(promptLibraryHub.subscribe, promptLibraryHub.snapshot, promptLibraryHub.snapshot);
  const commands = useMemo(() => pinnedCommands(withBuiltinCommands(stored ?? [], { projectPath })), [stored, projectPath]);
  const preview = usePromptPreview();
  return <>
    {/* data-command-id는 두 칸(버튼)에만 둔다 — 그룹에도 달면 명령 순서를 읽는 쪽이 같은 id를 두 번 센다. */}
    {commands.map(command => <span key={command.id} role="group" data-testid="pinned-command-control"
      aria-label={`${command.title} 규격 명령`} className={groupClass}>
      <button type="button"
        data-testid={BUILTIN_COMMAND_TEST_IDS[command.id] ?? 'pinned-command-copy'} data-command-id={command.id}
        aria-label={`${command.title} 규격 명령 복사`}
        onClick={() => { void copyAgentsToZPrompt(command.body).then(
          () => notify(`「${command.title}」 규격 명령을 복사했습니다`, 'success'),
          () => notify(`「${command.title}」 복사에 실패했습니다`, 'error')); }}
        {...preview.bind('tool:' + command.id, command.title, command.body)}
        className={segmentClass}>
        <Copy className="w-3 h-3" />
        {command.title}
      </button>
      {onRunInWorkroom && <button type="button"
        data-testid="pinned-command-workroom" data-command-id={command.id}
        aria-label={`${command.title} — 워크룸에서 실행`}
        title={`워크룸에서 실행 — 「${command.title}」을 AgentsToZ DEV 워크룸에 초안으로 채워 엽니다. 「선택한 AI로 시작」을 눌러야 실행됩니다.`}
        onClick={() => onRunInWorkroom(command.title, workroomCommandBody(command, { projectPath }))}
        className={iconSegmentClass}>
        <Play className="w-3 h-3" />
      </button>}
    </span>)}
    <button type="button" data-testid="pinned-commands-manage" aria-label="규격 명령 관리 — 추가·수정·순서·고정"
      title="규격 명령 관리 — 추가·수정·순서 바꾸기·고정 해제, AI로 새로 만들기"
      onClick={() => { if (!promptLibraryHub.requestOpen('command')) notify('자주 쓰는 프롬프트를 아직 불러오는 중입니다. 잠시 후 다시 눌러 주세요.', 'error'); }}
      className={manageClass}>
      <ListChecks className="w-3 h-3" />
      명령 관리
    </button>
    {preview.popover}
  </>;
});
