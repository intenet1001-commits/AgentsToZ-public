export const CONTROL_CENTER_PROJECT_NAME = "AgentsToZ-Control";

type ControlCenterCandidate = {
  name?: string;
  aiName?: string;
  folderPath?: string;
};

export function resolveControlCenterProject<T extends ControlCenterCandidate>(projects: readonly T[]): T | null {
  return projects.find(project => {
    const folderName = project.folderPath?.trim().replace(/[/\\]+$/, "").split(/[/\\]/).pop();
    return folderName?.toLocaleLowerCase() === CONTROL_CENTER_PROJECT_NAME.toLocaleLowerCase()
      || project.name?.trim().toLocaleLowerCase() === CONTROL_CENTER_PROJECT_NAME.toLocaleLowerCase()
      || project.aiName?.trim().toLocaleLowerCase() === CONTROL_CENTER_PROJECT_NAME.toLocaleLowerCase();
  }) ?? null;
}

export type ControlCenterTemplateFile = {
  relativePath: string;
  content: string;
};

export function controlCenterTemplateFiles(projectName = CONTROL_CENTER_PROJECT_NAME): ControlCenterTemplateFile[] {
  const name = projectName.trim() || CONTROL_CENTER_PROJECT_NAME;
  return [
    {
      relativePath: "README.md",
      content: `# ${name}\n\nAgentsToZ 관제센터 프로젝트입니다. 여러 프로젝트가 함께 수행하는 업무의 목표, 역할, 공통 결정과 인수인계를 이 폴더에서 관리합니다.\n\n## 다른 Mac에서 이어서 사용하기\n\n1. 이 프로젝트를 Private GitHub 저장소에 push합니다.\n2. 다른 Mac의 AgentsToZ에서 **새 프로젝트 → GitHub 주소**에 같은 저장소 주소를 넣어 clone합니다.\n3. **처음부터 프로젝트 장기기억 사용**과 **Supabase 백업**을 켭니다.\n4. clone이 끝나면 AgentsToZ가 저장소 계보와 \`.agent-memory/config.json\`의 동일한 \`memoryId\`를 확인하고 원격 기억을 먼저 Pull합니다.\n\nGit은 이 폴더의 문서와 변경 이력을 동기화합니다. Supabase는 같은 \`memoryId\`의 장기기억 리비전을 동기화합니다. 새 Mac에서 장기기억을 다시 초기화하거나 새 ID로 바꾸지 마세요.\n`,
    },
    {
      relativePath: "CONTROL.md",
      content: `# Control Center\n\n## 역할\n\n- 새 프로젝트를 열기 전 목표와 담당 프로젝트를 정합니다.\n- 여러 프로젝트가 함께 일할 때 공통 결정과 완료 조건을 기록합니다.\n- 각 프로젝트의 구현 세부사항은 해당 프로젝트 장기기억에 남깁니다.\n- 실행 중 상태와 터미널 이벤트는 AgentsToZ 미션·워크룸 런타임에서 관리합니다.\n\n## 기억 경계\n\n- 관제센터 기억: 프로젝트 별칭, 관계, 반복되는 오케스트레이션 방식, 공통 결정\n- 프로젝트 기억: 해당 프로젝트의 설계, 변경, 검증 결과\n- 미션 저장소: 현재 진행 상태, 세션, 이벤트, 재개 지점\n\n## 운영 원칙\n\n1. 작업 전 AgentsToZ의 등록 프로젝트 목록에서 정확한 프로젝트 ID를 조회합니다.\n2. 경로와 ID를 추측하지 않습니다.\n3. 실제 변경·결정·검증 결과만 해당 프로젝트 기억 후보로 전달합니다.\n4. 완료는 도구가 반환한 성공 결과와 검증 근거로 판단합니다.\n`,
    },
    {
      relativePath: "PROJECTS.md",
      content: "# Projects\n\nAgentsToZ에서 조회한 등록 프로젝트의 표시 이름, 역할, 관계를 기록합니다. 로컬 절대경로, 토큰, 비밀번호는 기록하지 않습니다.\n\n| 프로젝트 | 역할 | 관계/메모 |\n|---|---|---|\n| | | |\n",
    },
    {
      relativePath: ".agents/rules/agentstoz-control.md",
      content: `# AgentsToZ control-center rule\n\nWhen the user addresses AgentsToZ, use the installed AgentsToZ MCP tools to resolve registered project and workspace-root IDs. Use this control-center memory for cross-project intent and stable relationships. Keep project-specific implementation decisions in each target project's memory, and keep live mission state in the AgentsToZ mission store. Never guess local paths or identifiers.\n`,
    },
  ];
}
