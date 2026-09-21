export type TelegramBotNaming = {
  displayName: string;
  username: string;
};

function telegramUsernameSlug(value: string): string {
  const transliterated = value.trim()
    .replaceAll('회사에서받은맥북', 'workmacbook')
    .replaceAll('워크맥북', 'workmacbook')
    .replaceAll('헤르메스', 'hermes')
    .replaceAll('맥북', 'macbook')
    .replaceAll('노트북', 'laptop')
    .replaceAll('단말', 'device');
  return transliterated.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
}

export function suggestTelegramBotNaming(profileName: string, deviceName?: string, projectName?: string): TelegramBotNaming {
  const profile = profileName.trim();
  const device = deviceName?.trim();
  const project = projectName?.trim();
  const profileLabel = profile.toLowerCase() === 'default' ? 'Hermes' : (profile || 'Hermes');
  const botLabel = project || profileLabel;
  const profileSlug = profile.toLowerCase() === 'default' ? 'hermes' : profileLabel;
  const botSlug = project || profileSlug;
  const deviceSlug = device ? telegramUsernameSlug(device) : '';
  const profileSlugValue = telegramUsernameSlug(botSlug);
  const slug = deviceSlug && (deviceSlug === profileSlugValue || deviceSlug.endsWith(`_${profileSlugValue}`))
    ? deviceSlug
    : [deviceSlug, profileSlugValue].filter(Boolean).join('_');
  const usernameBase = (slug || 'hermes').slice(0, 28);
  const username = usernameBase.endsWith('bot') ? usernameBase : `${usernameBase}_bot`;
  return { displayName: `${device ? `${device} ` : ''}${botLabel} Bot`, username };
}

export function isValidTelegramBotUsername(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]{4,31}bot$/.test(value.trim());
}

export const TELEGRAM_BOT_ONBOARDING_MANUAL = 'docs/AGENTSTOZ_TELEGRAM_BOT_ONBOARDING.md';

export type TelegramConnectionMode = 'manual' | 'automatic';

export type TelegramProfileHandoffInput = {
  profileName: string;
  projectName?: string;
  canonicalPath?: string;
  memoryId?: string;
  deviceName?: string;
  deviceId?: string;
  connectionMode?: TelegramConnectionMode;
};

export function buildTelegramProfileHandoffPrompt(input: TelegramProfileHandoffInput): string {
  const profileName = input.profileName.trim();
  const projectName = input.projectName?.trim();
  const canonicalPath = input.canonicalPath?.trim();
  const memoryId = input.memoryId?.trim();
  const deviceName = input.deviceName?.trim();
  const deviceId = input.deviceId?.trim();
  const connectionMode = input.connectionMode ?? 'manual';
  if (!profileName || !deviceId) return '';
  const modeLines = connectionMode === 'automatic'
    ? [
        '연결 방식: Hermes Automatic(QR) — Bot 표시 이름과 username을 이 프롬프트에서 지정하거나 token을 입력하지 않는다.',
        'Hermes 공식 gateway setup에서 Automatic을 선택하고 Telegram의 Create Bot 승인 화면에서 표시 이름을 확인·수정한다. username은 Hermes/Telegram이 자동 생성한 값을 readback한다.',
      ]
    : [
        '연결 방식: Manual — BotFather에서 아래 표시 이름과 username을 사용하고 token은 Hermes 공식 gateway setup에 사용자가 직접 입력한다.',
      ];
  return [
    `로컬 Hermes profile ${profileName}을 Telegram Bot에 연결해줘.`,
    ...modeLines,
    projectName ? `연결 대상 project: ${projectName}` : '',
    deviceName ? `연결 대상 단말: ${deviceName}` : '',
    `authoritative device_id: ${deviceId}`,
    canonicalPath ? `canonical project path: ${canonicalPath}` : '',
    memoryId ? `project-memory ID: ${memoryId}` : '',
    connectionMode === 'manual' ? 'Bot 표시 이름과 username을 먼저 readback하고 BotFather 입력값으로 복사할 수 있게 준비해줘.' : 'Automatic 생성 후 실제 Bot display name·username·profile·gateway 상태를 readback해줘.',
    `먼저 ${TELEGRAM_BOT_ONBOARDING_MANUAL} 파일을 읽고, 이 profile의 실제 gateway 설정과 연결 상태를 readback해줘.`,
    'Telegram BotFather에서 Bot을 만들거나 token을 입력하는 단계는 사용자가 직접 수행한다. token은 이 prompt·파일·로그·Git에 넣지 말고 [REDACTED]로만 취급해.',
    'Telegram 앱에서 그룹을 만드는 작업은 자동화하지 않는다. 사용자가 그룹을 만든 뒤 이 Bot을 직접 추가하고, 필요하면 관리자 권한을 부여한다.',
    '그룹 추가 후 bot username, chat_id 또는 forum topic의 chat_id + thread_id를 readback하고, 선택한 profile/project와 일치하는지 PASS/FAIL/BLOCKED로 보고해줘.',
  ].filter(Boolean).join('\\n');
}
