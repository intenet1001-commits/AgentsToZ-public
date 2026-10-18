import React from 'react';
import { ChevronDown, ChevronUp, Minus } from 'lucide-react';

/**
 * One work-root row, shared by both sidebar layouts so they cannot drift apart
 * again (VOC 2026-09-25: the reorder arrows were 9px chevrons read as part of the
 * count badge, and the × looked like deleting a folder).
 *
 * Reorder sits before the name as a labelled pair of buttons; the count says what
 * it counts; 「−」 only opens the list-only removal confirmation.
 */
export function WorkspaceRootRow({root, index, total, projectCount, monoFont, onMove, onNewFolder, onRemove}: {
  root: {id: string; name: string; path: string};
  index: number;
  total: number;
  projectCount: number;
  monoFont: string;
  onMove: (id: string, direction: -1 | 1) => void;
  onNewFolder: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const arrow = (disabled: boolean): React.CSSProperties => ({
    padding: 0, width: 20, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent', border: '1px solid rgb(var(--surface-highlight-rgb) / 0.12)', borderRadius: 4,
    color: 'var(--text-secondary)', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.35 : 1,
  });
  return (
    <div data-testid={`workspace-root-row-${root.id}`} style={{display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px 4px 12px'}}>
      <div role="group" aria-label={`${root.name} 순서`} style={{display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0}}>
        <button type="button" data-testid={`workspace-root-move-up-${root.id}`} disabled={index === 0}
          onClick={() => onMove(root.id, -1)} title="위로 이동" aria-label={`${root.name} 위로`} style={arrow(index === 0)}>
          <ChevronUp style={{width: 12, height: 12}} />
        </button>
        <button type="button" data-testid={`workspace-root-move-down-${root.id}`} disabled={index === total - 1}
          onClick={() => onMove(root.id, 1)} title="아래로 이동" aria-label={`${root.name} 아래로`} style={arrow(index === total - 1)}>
          <ChevronDown style={{width: 12, height: 12}} />
        </button>
      </div>
      <div style={{flex: 1, minWidth: 0}}>
        <div style={{fontSize: 11, fontFamily: monoFont, color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}}>{root.name}</div>
        <div style={{fontSize: 9.5, fontFamily: monoFont, color: 'var(--text-dim)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}} title={root.path}>{root.path}</div>
      </div>
      {projectCount > 0 && (
        <span title={`이 루트 안의 프로젝트 ${projectCount}개`}
          style={{fontSize: 9, fontFamily: monoFont, color: 'var(--text-dim)', background: 'rgb(var(--surface-highlight-rgb) / 0.06)', padding: '1px 4px', borderRadius: 3, flexShrink: 0}}>
          {projectCount}개
        </span>
      )}
      <button type="button" data-help-key="workspace-new-folder" onClick={() => onNewFolder(root.id)} title="이 루트 안에 새 프로젝트 폴더 만들기"
        style={{padding: '2px 6px', background: 'rgb(var(--accent-rgb) / 0.1)', border: '1px solid rgb(var(--accent-rgb) / 0.2)', borderRadius: 4, color: 'var(--accent)', cursor: 'pointer', fontSize: 10, fontFamily: 'inherit', flexShrink: 0}}>
        새 폴더
      </button>
      <button type="button" data-testid={`workspace-root-remove-${root.id}`} onClick={() => onRemove(root.id)}
        title="목록에서 빼기 · 폴더와 프로젝트는 그대로예요" aria-label={`${root.name} 목록에서 빼기`}
        style={{padding: '2px 4px', background: 'transparent', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', display: 'flex', alignItems: 'center', flexShrink: 0}}>
        <Minus style={{width: 11, height: 11}} />
      </button>
    </div>
  );
}
