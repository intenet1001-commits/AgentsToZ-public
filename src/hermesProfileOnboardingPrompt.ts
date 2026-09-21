export type HermesProfileChannel = 'local' | 'telegram';
export type HermesProfileModel = 'sol' | 'profile-default';

export const suggestHermesProfileNames = (projectName?: string): string[] => {
  const slug = projectName?.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 54) || 'project';
  return [`${slug}-bot`, slug];
};

export const validateHermesProfileName = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.trim());

export function nextAvailableHermesProfileName(existingProfiles: readonly string[], projectName?: string): string {
  const used = new Set(existingProfiles.map(name => name.trim().toLowerCase()));
  const preferred = projectName ? suggestHermesProfileNames(projectName)[0]! : 'new-agent';
  if (!used.has(preferred.toLowerCase())) return preferred;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const suffixText = `-${suffix}`;
    const candidate = `${preferred.slice(0, 64 - suffixText.length)}${suffixText}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return '';
}

const HERMES_PROFILE_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  default: 'Hermes',
  'cs-ceo': 'CS CEO',
};

/** UI 표시명은 읽기 쉽게 하되, 내부 profile ID는 항상 보존한다. */
export function hermesProfileDisplayName(profileName: string, profileDisplayName?: string): string {
  const canonicalName = profileName.trim();
  const displayName = profileDisplayName?.trim() || HERMES_PROFILE_DISPLAY_NAMES[canonicalName];
  return displayName ? `${displayName} (${canonicalName})` : canonicalName;
}

export type NewHermesProfilePreparationInput = {
  profileName: string;
  existingProfiles: readonly string[];
  channel: HermesProfileChannel;
  model?: HermesProfileModel;
};

export function buildNewHermesProfilePreparationPrompt(input: NewHermesProfilePreparationInput): string {
  const profileName = input.profileName.trim();
  if (!validateHermesProfileName(profileName)) return '';
  if (input.existingProfiles.some(name => name.trim().toLowerCase() === profileName.toLowerCase())) return '';
  const channel = input.channel === 'local' ? '로컬 Hermes Bot Chat' : 'Telegram Bot';
  const model = input.model === 'profile-default' ? 'Hermes 기본 모델 (gpt-5.6-luna, SOL 아님)' : 'Hermes Codex SOL (gpt-5.6-sol)';
  return [
    `새 Hermes profile ${profileName}을 ${channel}용으로 준비해줘.`,
    input.channel === 'local' ? `로컬 Chat 실행 모델은 ${model}로 설정해줘.` : '',
    '사용자 확인 없이 자동으로 profile 디렉터리나 gateway를 생성하지 마. config, 세션, 파일, memory도 자동 생성하거나 덮어쓰지 마.',
    `먼저 ${profileName}이 실제로 존재하는지 다시 조회하고, 존재하면 중복 생성하지 말고 기존 profile 연결 절차로 전환해줘.`,
    input.channel === 'telegram' ? 'Telegram Bot token은 사용자가 직접 입력한다. token을 prompt·파일·로그에 기록하지 말고 [REDACTED]로만 취급해. 그룹 생성과 Bot 추가도 사용자가 직접 수행한다.' : '이 단계에서는 Telegram Bot이나 Telegram 그룹을 만들지 마.',
    '사용자 확인 후에만 Hermes 공식 profile 생성 절차를 실행하고, 생성 뒤 profile 목록과 gateway 상태를 readback해줘.',
  ].join('\n');
}

export type HermesProfileOnboardingInput = {
  profileName: string;
  channel: HermesProfileChannel;
  projectName?: string;
  canonicalPath?: string;
  memoryId?: string;
};

/** Profile is the primary identity; project matching is optional. */
export function buildHermesProfileOnboardingPrompt(input: HermesProfileOnboardingInput): string {
  const profileName = input.profileName.trim();
  if (!profileName) return '';
  const projectName = input.projectName?.trim();
  const canonicalPath = input.canonicalPath?.trim();
  const memoryId = input.memoryId?.trim();
  if ((projectName || canonicalPath || memoryId) && (!projectName || !canonicalPath || !memoryId)) return '';
  const channel = input.channel === 'local' ? '로컬 Hermes Bot Chat' : 'Telegram Bot';
  return [
    `Hermes profile ${profileName}을 ${channel}에 연결해줘.`,
    projectName ? `선택적 project matching: ${projectName}` : '현재는 프로젝트 없이 profile과 채널만 연결해줘.',
    canonicalPath ? `canonical project path: ${canonicalPath}` : '',
    memoryId ? `project-memory ID: ${memoryId}` : '',
    'profile·channel identity를 먼저 readback하고, 기존 profile이면 재사용해줘. profile을 임의로 덮어쓰거나 중복 생성하지 마.',
    '프로젝트 매칭 정보가 있으면 project·canonical path·memory ID·Git identity가 일치하는지 확인하고, 없으면 프로젝트 없이 사용 가능한 상태로 보고해줘.',
    input.channel === 'telegram' ? 'Telegram BotFather token은 사용자가 직접 입력하며, token은 [REDACTED]로만 취급해. Telegram 그룹 생성과 Bot 추가는 사용자가 수동으로 수행한다.' : '이 단계에서는 Telegram Bot이나 Telegram 그룹을 만들지 마.',
    '파일·memory·Git·Telegram 외부 상태를 변경하기 전에는 사용자 확인을 받고, 결과를 PASS/FAIL/BLOCKED로 보고해줘.',
  ].filter(Boolean).join('\n');
}
