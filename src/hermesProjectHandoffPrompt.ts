export const HERMES_PROJECT_HANDOFF_MANUAL = 'docs/AGENTSTOZ_HERMES_NEW_DEVICE_SETUP.md';

export type HermesProjectHandoffInput = {
  projectName?: string;
  canonicalPath?: string;
  memoryId?: string;
  githubUrl?: string;
  profileName: string;
};

function required(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function buildHermesProjectHandoffPrompt(input: HermesProjectHandoffInput): string {
  const projectName = required(input.projectName);
  const canonicalPath = required(input.canonicalPath);
  const memoryId = required(input.memoryId);
  const profileName = required(input.profileName);
  if (!projectName || !canonicalPath || !memoryId || !profileName) return '';

  return [
    `선택한 프로젝트 ${projectName}를 로컬 Hermes profile ${profileName}에 연동해줘.`,
    'Telegram 그룹이나 Telegram Bot은 만들지 말고, 이 단계에서는 로컬 Hermes profile·프로젝트 binding만 처리해줘.',
    `project name: ${projectName}`,
    `canonical project path: ${canonicalPath}`,
    `memory_id: ${memoryId}`,
    `Hermes profile: ${profileName}`,
    input.githubUrl?.trim() ? `Git remote: ${input.githubUrl.trim()}` : 'Git remote: 확인 가능한 경우 readback해줘.',
    `먼저 ${HERMES_PROJECT_HANDOFF_MANUAL}을 읽고, 기존 profile이면 재사용하고 없을 때만 사용자 확인 후 생성해줘.`,
    'profile·project·memory·Git identity가 모두 일치하는지 readback한 뒤 PASS/FAIL/BLOCKED로 보고해줘.',
    'token·API key·password·connection string은 출력하거나 저장하지 마.',
  ].join('\n');
}
