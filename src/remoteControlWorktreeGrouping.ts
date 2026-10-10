/**
 * 휴대폰 카드 목록에서 "워크트리 보기"를 만드는 규칙 — 정본은 이 파일 한 곳이다.
 *
 * 호스트는 이미 각 워크트리 카드를 자기 부모 바로 뒤에 놓아서 보낸다
 * (`groupWorktreesUnderParents`, src/remoteControlProcessGateway.ts). 그래서
 * 휴대폰에는 새 데이터가 필요 없고, 연속한 `kind === 'worktree'` 구간을 부모
 * 밑으로 묶어 보여 주기만 하면 된다.
 *
 * ⚠️ 모바일 렌더러가 두 벌이다 — 같은 Wi-Fi QR 페이지(`remoteControlMobilePage.ts`,
 * 손으로 쓴 HTML/JS 문자열)와 인터넷 포털(`RemoteControlProjectCard.tsx` +
 * `remote-control-portal-main.tsx`, React). 한쪽에만 넣으면 그 기능은 다른
 * 화면에서 조용히 없는 것이 된다. 실제로 Git·워크트리 액션이 그렇게 갈렸다.
 * 규칙을 바꾸면 두 렌더러를 함께 고칠 것.
 */

export interface RemoteControlGroupableCard {
  kind: 'main' | 'worktree';
}

export type RemoteControlCardRow<T extends RemoteControlGroupableCard> =
  | { type: 'project'; card: T }
  /**
   * 부모 바로 뒤에 붙은 워크트리 묶음. `parent`가 null이면 부모 카드가 검색으로
   * 걸러졌거나 아직 안 불러온 것이다 — 그래도 카드를 버리지 않는다.
   */
  | { type: 'worktrees'; parent: T | null; cards: T[] };

/**
 * 평평한 카드 목록을 "프로젝트 / 그 아래 워크트리 묶음" 순서로 바꾼다.
 * 입력 순서를 유지하고, 어떤 카드도 잃지 않는다(출력은 입력의 순열이다).
 */
export function groupRemoteControlCards<T extends RemoteControlGroupableCard>(
  cards: readonly T[],
): RemoteControlCardRow<T>[] {
  const rows: RemoteControlCardRow<T>[] = [];
  let index = 0;
  const takeWorktreeRun = (): T[] => {
    const run: T[] = [];
    for (let card = cards[index]; card !== undefined && card.kind === 'worktree'; card = cards[index]) {
      run.push(card);
      index += 1;
    }
    return run;
  };
  while (index < cards.length) {
    const card = cards[index] as T;
    if (card.kind !== 'worktree') {
      rows.push({ type: 'project', card });
      index += 1;
      const run = takeWorktreeRun();
      if (run.length > 0) rows.push({ type: 'worktrees', parent: card, cards: run });
      continue;
    }
    // 부모 없이 시작하는 워크트리 구간 — 목록 맨 앞이거나 부모가 걸러진 경우다.
    rows.push({ type: 'worktrees', parent: null, cards: takeWorktreeRun() });
  }
  return rows;
}

/** 묶음 제목. 부모를 못 찾아도 개수는 말해 준다. */
export function remoteControlWorktreeGroupLabel(count: number): string {
  return `워크트리 ${count}개`;
}
