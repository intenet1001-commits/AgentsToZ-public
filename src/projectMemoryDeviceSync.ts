export type ProjectMemoryDevicePlatform = 'darwin' | 'win32' | 'linux' | 'aws' | 'unknown';

export function normalizeDevicePlatform(value: string | null | undefined): ProjectMemoryDevicePlatform {
  const normalized = (value ?? '').trim().toLowerCase();
  if (normalized === 'darwin' || normalized === 'mac' || normalized === 'macos') return 'darwin';
  if (normalized === 'win32' || normalized === 'windows' || normalized === 'win') return 'win32';
  if (normalized === 'linux') return 'linux';
  if (normalized === 'aws' || normalized === 'aws-ubuntu') return 'aws';
  return 'unknown';
}

/**
 * 포털은 다른 단말의 폴더 경로를 알지 못한다. 따라서 명령은 해당 단말의
 * 프로젝트 폴더에서 실행하면 Git 루트(또는 현재 폴더)를 스스로 검출한다.
 */
export function buildProjectMemorySyncCommand(platform: string | null | undefined): string {
  if (normalizeDevicePlatform(platform) === 'win32') {
    return '$PROJECT_ROOT = (git rev-parse --show-toplevel 2>$null); if (-not $PROJECT_ROOT) { $PROJECT_ROOT = (Get-Location).Path }; curl.exe --fail-with-body -sS -X POST --get --data-urlencode "folderPath=$PROJECT_ROOT" http://127.0.0.1:3001/api/project-memory/sync';
  }
  return 'PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"; curl --fail-with-body -sS -X POST --get --data-urlencode "folderPath=$PROJECT_ROOT" http://127.0.0.1:3001/api/project-memory/sync';
}

function quoteForPosix(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function quoteForPowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * 어느 폴더에서 실행해도 로컬 AgentsToZ 등록 프로젝트를 memoryId로 찾는다.
 * 폴더 경로 자체를 원격 DB에 올리지 않고 해당 단말의 로컬 API가 해석한다.
 */
export function buildProjectMemoryFindCommand(
  memoryId: string,
  platform: string | null | undefined,
): string {
  const body = JSON.stringify({ project: memoryId.trim() });
  if (normalizeDevicePlatform(platform) === 'win32') {
    return `curl.exe --fail-with-body -sS -X POST http://127.0.0.1:3001/api/project-memory/resolve-project -H "Content-Type: application/json" --data ${quoteForPowerShell(body)}`;
  }
  return `curl --fail-with-body -sS -X POST http://127.0.0.1:3001/api/project-memory/resolve-project -H 'Content-Type: application/json' --data ${quoteForPosix(body)}`;
}

export function devicePlatformLabel(platform: string | null | undefined): string {
  switch (normalizeDevicePlatform(platform)) {
    case 'darwin': return 'macOS';
    case 'win32': return 'Windows';
    case 'linux': return 'Linux';
    case 'aws': return 'AWS Ubuntu';
    default: return '플랫폼 미상';
  }
}
