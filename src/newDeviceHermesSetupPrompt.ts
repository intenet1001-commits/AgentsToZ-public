export const NEW_DEVICE_HERMES_SETUP_MANUAL = 'docs/AGENTSTOZ_HERMES_NEW_DEVICE_SETUP.md';

/**
 * Short clipboard handoff for a new device. The detailed procedure stays in
 * the repository manual so the app prompt remains stable and reviewable.
 */
export const buildNewDeviceHermesSetupPrompt = () => [
  '새 단말 AgentsToZ + Hermes Bot 2개 + 3명 단체톡 온보딩을 진행해줘.',
  `먼저 저장소의 ${NEW_DEVICE_HERMES_SETUP_MANUAL} 파일을 읽고, 그 매뉴얼의 순서·검증·중단 규칙을 그대로 따라줘.`,
  'agentstoz-bot과 cs-ceo를 설정한 뒤 Hermes + agentstoz-bot + cs-ceo 3명 단체톡을 Hermes Desktop에서 생성하고, 3 bots / 3 of 3 available 및 smoke test까지 확인해줘.',
  `macOS/Linux/Git Bash: sed -n '1,260p' ${NEW_DEVICE_HERMES_SETUP_MANUAL}`,
  `Windows PowerShell: Get-Content ${NEW_DEVICE_HERMES_SETUP_MANUAL}`,
  '설치 설명만 하지 말고 실제 명령·API·Hermes Desktop 화면·파일·memory·Git readback을 수행해 PASS/FAIL/BLOCKED로 보고해줘.',
].join('\n');
