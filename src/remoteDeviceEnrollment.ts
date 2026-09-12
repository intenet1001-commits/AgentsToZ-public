import { ONBOARDING_GUIDE_URL } from './onboardingInfrastructure';

export type RemoteEnvironmentKind = 'aws' | 'linux' | 'cloud' | 'container' | 'wsl';
export type RemoteProjectActionKind = 'clone' | 'memory' | 'new';

export const REMOTE_DEVICE_AGENT_VERSION = '4';
export const DEFAULT_REMOTE_DEVICE_SCRIPT_URL =
  new URL('/agentstoz-remote-device.sh', ONBOARDING_GUIDE_URL).toString();

export function remoteEnrollmentTokenFromBytes(bytes: Uint8Array): string {
  if (bytes.length !== 32) throw new Error('원격 단말 등록 토큰은 32바이트여야 합니다.');
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}

export function createRemoteEnrollmentToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return remoteEnrollmentTokenFromBytes(bytes);
}

export function normalizeRemoteDeviceName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, 80);
}

export function normalizeRemoteProjectPath(value: string): string {
  const path = value.trim().replace(/\/+$/, '') || '/';
  if (!path.startsWith('/') || path.includes('\0') || path.length > 1024) {
    throw new Error('AWS/Linux 프로젝트의 절대경로를 입력하세요.');
  }
  return path;
}

export function normalizeRemoteProjectName(value: string): string {
  const name = value.trim().replace(/\s+/g, ' ').slice(0, 120);
  if (!name || name === '.' || name === '..' || /[\\/\0]/.test(name)) {
    throw new Error('프로젝트 이름에는 경로 구분자를 사용할 수 없습니다.');
  }
  return name;
}

export function inferGitHubRepositoryName(value: string): string {
  const input = value.trim();
  const match = input.match(/^https:\/\/github\.com\/[^/?#]+\/([^/?#]+)/i)
    ?? input.match(/^git@github\.com:[^/?#]+\/([^/?#]+)/i);
  return (match?.[1] ?? '').replace(/\.git$/i, '');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function buildRemoteDeviceEnrollmentCommand(input: {
  scriptUrl?: string;
  token: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  deviceName: string;
  environmentKind: RemoteEnvironmentKind;
  workspaceRoot?: string;
  projectPath?: string;
  forceNewDevice?: boolean;
}): string {
  if (!/^[0-9a-f]{64}$/.test(input.token)) throw new Error('등록 토큰 형식이 올바르지 않습니다.');
  const scriptUrl = new URL(input.scriptUrl || DEFAULT_REMOTE_DEVICE_SCRIPT_URL);
  if (scriptUrl.protocol !== 'https:') throw new Error('등록 스크립트는 HTTPS 주소여야 합니다.');
  const supabaseUrl = new URL(input.supabaseUrl);
  if (supabaseUrl.protocol !== 'https:') throw new Error('Supabase HTTPS 주소가 필요합니다.');
  const name = normalizeRemoteDeviceName(input.deviceName);
  if (!name) throw new Error('원격 단말 이름을 입력하세요.');
  const workspaceRoot = normalizeRemoteProjectPath(input.workspaceRoot || '/home/ubuntu/projects');
  const projectPath = input.projectPath ? normalizeRemoteProjectPath(input.projectPath) : null;
  const continuation = ' \\' + '\n  ';
  const run = [
    `bash "$tmp_script" --token ${shellQuote(input.token)}`,
    `--supabase-url ${shellQuote(supabaseUrl.toString().replace(/\/$/, ''))}`,
    `--anon-key ${shellQuote(input.supabaseAnonKey.trim())}`,
    `--name ${shellQuote(name)}`,
    `--environment ${shellQuote(input.environmentKind)}`,
    `--workspace-root ${shellQuote(workspaceRoot)}`,
    ...(projectPath ? [`--project ${shellQuote(projectPath)}`] : []),
    ...(input.forceNewDevice ? ['--force-new-device'] : []),
  ].join(continuation);
  return [
    '(',
    '  set -e',
    `  tmp_script="$(mktemp -t agentstoz-remote-device.XXXXXX)"`,
    `  trap 'rm -f "$tmp_script"' EXIT`,
    `  curl --fail --silent --show-error --location --connect-timeout 10 --max-time 60 ${shellQuote(scriptUrl.toString())} --output "$tmp_script"`,
    `  ${run}`,
    ')',
  ].join('\n');
}

/** Upgrade an already-registered headless host without rotating its identity. */
export function buildRemoteDeviceUpgradeCommand(scriptUrl = DEFAULT_REMOTE_DEVICE_SCRIPT_URL): string {
  const url = new URL(scriptUrl);
  if (url.protocol !== 'https:') throw new Error('업데이트 스크립트는 HTTPS 주소여야 합니다.');
  return [
    '(',
    '  set -e',
    '  config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/agentstoz"',
    '  installed="$config_dir/agentstoz-remote-device.sh"',
    '  staged="$config_dir/.agentstoz-remote-device.sh.new"',
    '  tmp_script="$(mktemp -t agentstoz-remote-device.XXXXXX)"',
    '  trap \'rm -f "$tmp_script" "$staged"\' EXIT',
    '  mkdir -p "$config_dir"',
    `  curl --fail --silent --show-error --location --connect-timeout 10 --max-time 60 ${shellQuote(url.toString())} --output "$tmp_script"`,
    '  install -m 700 "$tmp_script" "$staged"',
    '  mv -f -- "$staged" "$installed"',
    '  "$installed" --sync',
    ')',
  ].join('\n');
}

export function buildRemoteHostProjectCommand(input: {
  action: RemoteProjectActionKind;
  projectName: string;
  workspaceRoot: string;
  repositoryUrl?: string;
  memoryId?: string;
}): string {
  const projectName = normalizeRemoteProjectName(input.projectName);
  const workspaceRoot = normalizeRemoteProjectPath(input.workspaceRoot);
  const args = [
    `--project-action ${shellQuote(input.action)}`,
    `--project-name ${shellQuote(projectName)}`,
    `--workspace-root ${shellQuote(workspaceRoot)}`,
  ];
  if (input.action === 'clone') {
    const repositoryUrl = input.repositoryUrl?.trim() ?? '';
    if (!/^https:\/\/github\.com\/[^/]+\/[^/]+(?:\.git)?(?:[?#].*)?$/i.test(repositoryUrl)
      && !/^git@github\.com:[^/]+\/[^/]+(?:\.git)?$/i.test(repositoryUrl)) {
      throw new Error('복제할 GitHub 저장소 URL을 입력하세요.');
    }
    args.push(`--repository-url ${shellQuote(repositoryUrl)}`);
  }
  if (input.action === 'memory') {
    const memoryId = input.memoryId?.trim() ?? '';
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(memoryId)) throw new Error('연결할 장기기억 ID를 선택하세요.');
    args.push(`--memory-id ${shellQuote(memoryId)}`);
  }
  return [
    '(',
    '  set -e',
    '  agent_script="${XDG_CONFIG_HOME:-$HOME/.config}/agentstoz/agentstoz-remote-device.sh"',
    '  test -x "$agent_script"',
    `  "$agent_script" ${args.join(' ')}`,
    ')',
  ].join('\n');
}
