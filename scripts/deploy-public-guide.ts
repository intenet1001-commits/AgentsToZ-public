#!/usr/bin/env bun
/**
 * Public onboarding-guide deployment.
 *
 * The personal portal and this public, read-only guide are different Vercel
 * projects. This command builds the guide, audits the resulting static files,
 * and gives Vercel only a disposable directory containing those files.
 *
 *   bun run deploy:guide:dry-run  # build + local audit; no Vercel calls
 *   bun run deploy:guide          # deploy the audited static directory
 */
import {
  accessSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GUIDE_VERCEL_PROJECT = 'agentstoz-guide';
export const GUIDE_CANONICAL_URL = 'https://agentstoz-guide.vercel.app';
export const GUIDE_REMOTE_SCRIPT_PATH = '/agentstoz-remote-device.sh';
export const GUIDE_BUILD_EVIDENCE_PATH = '/agentstoz-guide-build.json';
export const GUIDE_IDENTITY_FILE = '.vercel-guide-identity.json';

const PUBLIC_REPOSITORY_URL = 'https://github.com/intenet1001-commits/AgentsToZ-public';
const TEMP_PREFIX = 'agentstoz-guide-deploy-';
const MAX_ARTIFACT_FILES = 128;
const MAX_ARTIFACT_FILE_BYTES = 12 * 1024 * 1024;
const MAX_ARTIFACT_TOTAL_BYTES = 64 * 1024 * 1024;
const REQUIRED_ROOT_FILES = new Set([
  'agentstoz-remote-device.sh',
  'favicon.svg',
  'guide.html',
  'site.webmanifest',
]);
const ROOT_FILE_ALLOWLIST = new Set(REQUIRED_ROOT_FILES);
const ASSET_ALLOWLIST = /^assets\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:css|js|png|svg|webp|woff2?)$/;
const STATIC_CONFIG_KEYS = new Set(['headers', 'rewrites']);
const TEXT_SECRET_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'Supabase JWT', pattern: /eyJhbGciOi[A-Za-z0-9._-]{140,}/ },
  { name: 'Supabase personal access token', pattern: /\bsbp_[a-f0-9]{40}\b/i },
  { name: 'Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI API key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/ },
  { name: 'GitHub token', pattern: /\b(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}/ },
  { name: 'Vercel token', pattern: /\b(?:vercel_|vcp_)[A-Za-z0-9_-]{20,}/i },
  { name: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Google OAuth client secret', pattern: /\bGOCSPX-[A-Za-z0-9_-]{20,}/ },
  { name: 'Telegram bot token', pattern: /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/ },
  { name: 'PEM private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];
const SUPABASE_PROJECT_HOST = /\b[a-z0-9-]+\.supabase\.co\b/gi;
const VERCEL_APP_HOST = /\b([a-z0-9-]+)\.vercel\.app\b/gi;

export class GuideDeployError extends Error {}

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type CommandRunner = (input: {
  argv: readonly string[];
  cwd: string;
  env: Record<string, string>;
}) => Promise<CommandResult>;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type GuideProjectIdentity = {
  orgId: string;
  projectId: string;
  projectName: string;
};

export type GuideBuildEvidence = {
  schemaVersion: 1;
  marker: string;
  guideSha256: string;
  remoteScriptSha256: string;
};

const fail = (message: string): never => {
  throw new GuideDeployError(message);
};

const defaultProjectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const cleanEnvironment = (overrides: Record<string, string> = {}): Record<string, string> => {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') environment[key] = value;
  }
  // Authentication must come from `vercel login`, never an inherited CI token.
  delete environment.VERCEL_TOKEN;
  delete environment.VERCEL_ORG_ID;
  delete environment.VERCEL_PROJECT_ID;
  return { ...environment, ...overrides };
};

const executable = (path: string, platform = process.platform): boolean => {
  try {
    accessSync(path, platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
    return lstatSync(path).isFile() || lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

const existingFile = (path: string): boolean => {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
};

const lstatOrFail = (path: string, message: string): NonNullable<ReturnType<typeof lstatSync>> => {
  try {
    const stat = lstatSync(path);
    return stat ?? fail(message);
  } catch {
    return fail(message);
  }
};

const findOnPath = (name: string, pathValue: string, platform = process.platform): string | null => {
  const pathDelimiter = platform === 'win32' ? ';' : delimiter;
  const extensions = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const directory of pathValue.split(pathDelimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory.replace(/^"|"$/g, ''), `${name}${extension}`);
      if (executable(candidate, platform)) return candidate;
    }
  }
  return null;
};

const findNode = (pathValue: string, platform: NodeJS.Platform): string | null =>
  findOnPath(platform === 'win32' ? 'node' : 'node', pathValue, platform);

const vercelJavaScriptCandidates = (projectRoot: string, launcherPath: string): string[] => {
  const binDirectory = dirname(launcherPath);
  let resolvedLauncher = launcherPath;
  try {
    resolvedLauncher = realpathSync(launcherPath);
  } catch {
    // The checked launcher path remains the only evidence available.
  }
  return [
    join(projectRoot, 'node_modules', 'vercel', 'dist', 'vc.js'),
    join(binDirectory, 'node_modules', 'vercel', 'dist', 'vc.js'),
    resolve(binDirectory, '..', 'vercel', 'dist', 'vc.js'),
    resolve(binDirectory, '..', 'lib', 'node_modules', 'vercel', 'dist', 'vc.js'),
    resolve(binDirectory, '..', 'install', 'global', 'node_modules', 'vercel', 'dist', 'vc.js'),
    resolvedLauncher.toLowerCase().endsWith(`${sep}vc.js`) ? resolvedLauncher : '',
  ].filter(Boolean);
};

/** Resolve an installed Vercel CLI without a shell or an automatic download. */
export function resolveVercelCommand(input: {
  projectRoot?: string;
  pathValue?: string;
  platform?: NodeJS.Platform;
} = {}): string[] {
  const projectRoot = resolve(input.projectRoot ?? defaultProjectRoot);
  const platform = input.platform ?? process.platform;
  const pathValue = input.pathValue ?? process.env.PATH ?? '';
  const localLauncher = join(projectRoot, 'node_modules', '.bin', platform === 'win32' ? 'vercel.cmd' : 'vercel');
  const launcher = (executable(localLauncher, platform) ? localLauncher : findOnPath('vercel', pathValue, platform))
    ?? fail('Vercel CLI가 없습니다. Node.js 설치 후 `npm install -g vercel`, `vercel login`을 먼저 실행하세요.');
  if (platform !== 'win32' || launcher.toLowerCase().endsWith('.exe')) return [launcher];

  const cliScript = vercelJavaScriptCandidates(projectRoot, launcher).find(existingFile)
    ?? fail('Windows Vercel CLI 패키지를 안전하게 해석하지 못했습니다. `npm install -g vercel` 설치를 확인하세요.');
  const node = findNode(pathValue, platform)
    ?? fail('Windows Node.js 실행 파일을 찾지 못했습니다. Node.js 설치와 PATH를 확인하세요.');
  return [node, cliScript];
}

const defaultRunCommand: CommandRunner = async ({ argv, cwd, env }) => {
  const child = Bun.spawn({
    cmd: [...argv],
    cwd,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

const checkedCommand = async (
  runner: CommandRunner,
  input: { argv: readonly string[]; cwd: string; env: Record<string, string> },
  failureMessage: string,
): Promise<CommandResult> => {
  const result = await runner(input);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim().slice(0, 2000);
    fail(`${failureMessage}${detail ? `\n${detail}` : ''}`);
  }
  return result;
};

const normalizedRelativePath = (root: string, path: string): string =>
  relative(root, path).split(sep).join('/');

const isAllowedArtifactPath = (path: string): boolean =>
  ROOT_FILE_ALLOWLIST.has(path) || ASSET_ALLOWLIST.test(path);

/** Read the Vite output without following symlinks or accepting new file classes. */
export function collectGuideArtifactFiles(distDirectory: string): string[] {
  const expectedRoot = resolve(distDirectory);
  const rootStat = lstatOrFail(expectedRoot, 'dist-guide가 없습니다. `bun run build:guide` 결과를 확인하세요.');
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('dist-guide는 실제 디렉터리여야 합니다.');
  const files: string[] = [];
  let totalBytes = 0;
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      const relativePath = normalizedRelativePath(expectedRoot, absolutePath);
      if (entry.isSymbolicLink()) fail(`심볼릭 링크는 설명서 배포에 포함할 수 없습니다: ${relativePath}`);
      if (entry.isDirectory()) {
        if (relativePath !== 'assets') fail(`허용되지 않은 설명서 디렉터리입니다: ${relativePath}`);
        visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) fail(`일반 파일이 아닌 항목은 배포할 수 없습니다: ${relativePath}`);
      if (!isAllowedArtifactPath(relativePath)) fail(`설명서 파일 허용 목록 밖의 항목입니다: ${relativePath}`);
      const size = lstatSync(absolutePath).size;
      if (size > MAX_ARTIFACT_FILE_BYTES) fail(`설명서 파일이 너무 큽니다: ${relativePath}`);
      totalBytes += size;
      if (totalBytes > MAX_ARTIFACT_TOTAL_BYTES) fail('설명서 배포 크기가 안전 한도를 넘었습니다.');
      files.push(relativePath);
      if (files.length > MAX_ARTIFACT_FILES) fail('설명서 파일 수가 안전 한도를 넘었습니다.');
    }
  };
  visit(expectedRoot);
  for (const required of REQUIRED_ROOT_FILES) {
    if (!files.includes(required)) fail(`필수 설명서 파일이 없습니다: ${required}`);
  }
  return files.sort();
}

const scanText = (path: string, label: string): void => {
  const text = readFileSync(path).toString('latin1');
  const variants = [text];
  let decoded = text;
  for (let pass = 0; pass < 2; pass += 1) {
    const next = decoded.replace(/%([0-9a-f]{2})/gi, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
    if (next === decoded) break;
    variants.push(next);
    decoded = next;
  }
  for (const candidate of variants) {
    for (const { name, pattern } of TEXT_SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(candidate)) fail(`${label}에서 ${name} 형태가 발견됐습니다.`);
    }
    SUPABASE_PROJECT_HOST.lastIndex = 0;
    if (SUPABASE_PROJECT_HOST.test(candidate)) fail(`${label}에 실제 Supabase 프로젝트 주소가 포함됐습니다.`);
    VERCEL_APP_HOST.lastIndex = 0;
    for (const match of candidate.matchAll(VERCEL_APP_HOST)) {
      if (match[1]?.toLowerCase() !== GUIDE_VERCEL_PROJECT) {
        fail(`${label}에 공개 설명서가 아닌 Vercel 주소가 포함됐습니다.`);
      }
    }
  }
};

export function scanGuideArtifact(distDirectory: string, files: readonly string[]): void {
  for (const relativePath of files) scanText(join(distDirectory, relativePath), relativePath);
  const remoteScript = readFileSync(join(distDirectory, GUIDE_REMOTE_SCRIPT_PATH.slice(1)), 'utf8');
  if (!remoteScript.startsWith('#!/usr/bin/env bash\n') || !/\bAGENT_VERSION="\d+"/.test(remoteScript)) {
    fail('AWS 원격 설치 스크립트의 형식 또는 버전을 확인할 수 없습니다.');
  }
}

export function validateGuideVercelConfig(configPath: string): void {
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  } catch {
    fail('vercel.guide.json을 읽을 수 없습니다.');
  }
  const keys = Object.keys(config);
  if (keys.some(key => !STATIC_CONFIG_KEYS.has(key)) || keys.length !== STATIC_CONFIG_KEYS.size) {
    fail('vercel.guide.json에는 정적 배포용 rewrites와 headers만 있어야 합니다.');
  }
  if (!Array.isArray(config.rewrites) || !Array.isArray(config.headers)) {
    fail('vercel.guide.json의 rewrites/headers 형식이 올바르지 않습니다.');
  }
  scanText(configPath, 'vercel.guide.json');
}

export function stageGuideArtifact(input: {
  distDirectory: string;
  configPath: string;
  destination: string;
  files: readonly string[];
}): void {
  for (const relativePath of input.files) {
    const sourcePath = join(input.distDirectory, relativePath);
    const destinationPath = join(input.destination, relativePath);
    mkdirSync(dirname(destinationPath), { recursive: true });
    copyFileSync(sourcePath, destinationPath);
  }
  copyFileSync(input.configPath, join(input.destination, 'vercel.json'));
}

const validIdentityToken = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_:-]{6,200}$/.test(value);

const parsedIdentity = (value: unknown, label: string): GuideProjectIdentity => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} 형식이 올바르지 않습니다.`);
  const candidate = value as Partial<GuideProjectIdentity>;
  const { orgId, projectId, projectName } = candidate;
  if (!validIdentityToken(orgId)) fail(`${label}의 orgId가 올바르지 않습니다.`);
  if (!validIdentityToken(projectId)) fail(`${label}의 projectId가 올바르지 않습니다.`);
  if (projectName !== GUIDE_VERCEL_PROJECT) {
    fail(`${label}의 projectName은 ${GUIDE_VERCEL_PROJECT}여야 합니다.`);
  }
  return {
    orgId: String(orgId),
    projectId: String(projectId),
    projectName: GUIDE_VERCEL_PROJECT,
  };
};

/**
 * Read the maintainer's pre-audited project identity. The file is ignored and
 * is never created or updated by this deployment command, so a same-name link
 * cannot become trusted on first use.
 */
export function readExpectedGuideIdentity(projectRoot: string): GuideProjectIdentity {
  const identityPath = join(resolve(projectRoot), GUIDE_IDENTITY_FILE);
  let value: unknown;
  try {
    const stat = lstatSync(identityPath);
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`${GUIDE_IDENTITY_FILE}은 일반 파일이어야 합니다.`);
    if (process.platform !== 'win32' && (stat.mode & 0o022) !== 0) {
      fail(`${GUIDE_IDENTITY_FILE}에 그룹/전체 쓰기 권한이 있어 신뢰할 수 없습니다.`);
    }
    value = JSON.parse(readFileSync(identityPath, 'utf8')) as unknown;
  } catch (error) {
    if (error instanceof GuideDeployError) throw error;
    fail(
      `${GUIDE_IDENTITY_FILE}이 필요합니다. 이미 만든 공개 설명서 프로젝트를 Vercel Dashboard에서 확인한 뒤 `
      + 'orgId, projectId, projectName 세 값만 이 ignored 로컬 파일에 저장하세요.',
    );
  }
  const identity = parsedIdentity(value, GUIDE_IDENTITY_FILE);
  if (Object.keys(value as Record<string, unknown>).sort().join(',') !== 'orgId,projectId,projectName') {
    fail(`${GUIDE_IDENTITY_FILE}에는 orgId, projectId, projectName만 있어야 합니다.`);
  }
  return identity;
}

export function readLinkedProjectIdentity(
  tempDirectory: string,
  expected: GuideProjectIdentity,
): GuideProjectIdentity {
  const projectFile = join(tempDirectory, '.vercel', 'project.json');
  let value: unknown;
  try {
    const stat = lstatSync(projectFile);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('Vercel project.json이 일반 파일이 아닙니다.');
    value = JSON.parse(readFileSync(projectFile, 'utf8')) as unknown;
  } catch (error) {
    if (error instanceof GuideDeployError) throw error;
    fail('Vercel link 결과의 .vercel/project.json을 확인할 수 없습니다.');
  }
  const linked = parsedIdentity(value, 'Vercel link 결과');
  if (
    linked.orgId !== expected.orgId
    || linked.projectId !== expected.projectId
    || linked.projectName !== expected.projectName
  ) {
    fail('Vercel link 결과의 orgId/projectId/projectName이 사전 승인한 공개 설명서 프로젝트와 일치하지 않습니다.');
  }
  return linked;
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const sha256File = (path: string): string => sha256(readFileSync(path));

export function createGuideBuildEvidence(tempDirectory: string): GuideBuildEvidence {
  const evidence: GuideBuildEvidence = {
    schemaVersion: 1,
    marker: randomUUID(),
    guideSha256: sha256File(join(tempDirectory, 'guide.html')),
    remoteScriptSha256: sha256File(join(tempDirectory, GUIDE_REMOTE_SCRIPT_PATH.slice(1))),
  };
  const evidencePath = join(tempDirectory, GUIDE_BUILD_EVIDENCE_PATH.slice(1));
  writeFileSync(evidencePath, `${JSON.stringify(evidence)}\n`, { mode: 0o644 });
  scanText(evidencePath, GUIDE_BUILD_EVIDENCE_PATH.slice(1));
  return evidence;
}

const normalizeVercelHost = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  try {
    return new URL(value.includes('://') ? value : `https://${value}`).hostname.toLowerCase();
  } catch {
    return '';
  }
};

export function deploymentUrlFromStdout(stdout: string): string {
  const withoutAnsi = stdout.replace(/\x1b\[[0-9;]*m/g, '');
  const matches = withoutAnsi.match(/https:\/\/[a-z0-9-]+\.vercel\.app\b/gi) ?? [];
  const candidate = matches.at(-1) ?? '';
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' || !url.hostname.toLowerCase().endsWith('.vercel.app')) throw new Error('invalid');
    return url.origin;
  } catch {
    return fail('Vercel deploy stdout에서 새 HTTPS deployment URL을 확인하지 못했습니다.');
  }
}

export function validateDeploymentInspection(
  stdout: string,
  deploymentUrl: string,
  expected: GuideProjectIdentity,
): void {
  let inspection: {
    name?: unknown;
    url?: unknown;
    target?: unknown;
    readyState?: unknown;
    aliases?: unknown;
  } = {};
  try {
    inspection = JSON.parse(stdout.trim()) as typeof inspection;
  } catch {
    fail('Vercel deployment inspect JSON을 읽지 못했습니다.');
  }
  const deploymentHost = normalizeVercelHost(deploymentUrl);
  const inspectedHost = normalizeVercelHost(inspection.url);
  const aliases = Array.isArray(inspection.aliases)
    ? inspection.aliases.map(normalizeVercelHost).filter(Boolean)
    : [];
  const canonicalHost = new URL(GUIDE_CANONICAL_URL).hostname;
  if (
    inspection.name !== expected.projectName
    || inspection.target !== 'production'
    || inspection.readyState !== 'READY'
    || !deploymentHost
    || inspectedHost !== deploymentHost
    || !aliases.includes(canonicalHost)
  ) {
    fail('새 deployment의 프로젝트명, production 상태, stdout URL 또는 canonical alias 증거가 일치하지 않습니다.');
  }
}

const retryDelay = (attempt: number): Promise<void> => Bun.sleep(Math.min(500 * 2 ** attempt, 3000));

export async function verifyPublishedGuide(
  expected: GuideBuildEvidence,
  fetchLike: FetchLike = fetch,
  attempts = 6,
): Promise<void> {
  let lastFailure = '';
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const query = `?build=${encodeURIComponent(expected.marker)}`;
      const [guideResponse, scriptResponse, markerResponse] = await Promise.all([
        fetchLike(`${GUIDE_CANONICAL_URL}/${query}`, {
          redirect: 'error',
          cache: 'no-store',
          signal: AbortSignal.timeout(8000),
        }),
        fetchLike(`${GUIDE_CANONICAL_URL}${GUIDE_REMOTE_SCRIPT_PATH}${query}`, {
          redirect: 'error',
          cache: 'no-store',
          signal: AbortSignal.timeout(8000),
        }),
        fetchLike(`${GUIDE_CANONICAL_URL}${GUIDE_BUILD_EVIDENCE_PATH}${query}`, {
          redirect: 'error',
          cache: 'no-store',
          signal: AbortSignal.timeout(8000),
        }),
      ]);
      const [guideBuffer, scriptBuffer, markerText] = await Promise.all([
        guideResponse.arrayBuffer(),
        scriptResponse.arrayBuffer(),
        markerResponse.text(),
      ]);
      const expectedOrigin = new URL(GUIDE_CANONICAL_URL).origin;
      for (const response of [guideResponse, scriptResponse, markerResponse]) {
        if (!response.ok || !response.url || new URL(response.url).origin !== expectedOrigin) {
          throw new Error(`canonical response HTTP ${response.status}`);
        }
      }
      const marker = JSON.parse(markerText) as Partial<GuideBuildEvidence>;
      if (
        marker.schemaVersion !== expected.schemaVersion
        || marker.marker !== expected.marker
        || marker.guideSha256 !== expected.guideSha256
        || marker.remoteScriptSha256 !== expected.remoteScriptSha256
        || sha256(new Uint8Array(guideBuffer)) !== expected.guideSha256
        || sha256(new Uint8Array(scriptBuffer)) !== expected.remoteScriptSha256
      ) throw new Error('live build marker/hash mismatch');
      return;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
      if (attempt + 1 < attempts) await retryDelay(attempt);
    }
  }
  fail(`배포는 요청됐지만 공개 주소의 설명서/AWS 스크립트 검증에 실패했습니다: ${lastFailure}`);
}

const makeDeploymentTemp = (): string => mkdtempSync(join(tmpdir(), TEMP_PREFIX));

const removeDeploymentTemp = (tempDirectory: string): void => {
  const resolvedTemp = resolve(tempDirectory);
  if (dirname(resolvedTemp) !== resolve(tmpdir()) || !basename(resolvedTemp).startsWith(TEMP_PREFIX)) {
    fail('안전하게 생성한 설명서 임시 폴더가 아니므로 삭제하지 않았습니다.');
  }
  rmSync(resolvedTemp, { recursive: true, force: true, maxRetries: 3 });
};

export async function runPublicGuideDeployment(options: {
  projectRoot?: string;
  dryRun?: boolean;
  runCommand?: CommandRunner;
  fetchLike?: FetchLike;
  vercelCommand?: readonly string[];
  log?: (message: string) => void;
} = {}): Promise<void> {
  const projectRoot = resolve(options.projectRoot ?? defaultProjectRoot);
  const distDirectory = join(projectRoot, 'dist-guide');
  const configPath = join(projectRoot, 'vercel.guide.json');
  const runCommand = options.runCommand ?? defaultRunCommand;
  const log = options.log ?? console.log;
  const buildEnvironment = cleanEnvironment({
    VITE_ALLOWED_EMAIL: '',
    VITE_ONBOARDING_GUIDE_URL: GUIDE_CANONICAL_URL,
    VITE_PORTAL_URL: '',
    VITE_REPO_URL: PUBLIC_REPOSITORY_URL,
    VITE_SUPABASE_ANON_KEY: '',
    VITE_SUPABASE_URL: '',
  });

  log('▸ 공개 설명서 빌드 중...');
  const build = await checkedCommand(
    runCommand,
    { argv: [process.execPath, 'run', 'build:guide'], cwd: projectRoot, env: buildEnvironment },
    '`bun run build:guide`가 실패했습니다.',
  );
  if (build.stdout.trim()) log(build.stdout.trim());

  const files = collectGuideArtifactFiles(distDirectory);
  scanGuideArtifact(distDirectory, files);
  validateGuideVercelConfig(configPath);

  const tempDirectory = makeDeploymentTemp();
  try {
    stageGuideArtifact({ distDirectory, configPath, destination: tempDirectory, files });
    scanText(join(tempDirectory, 'vercel.json'), 'staged vercel.json');
    const buildEvidence = createGuideBuildEvidence(tempDirectory);
    log(`▸ 허용된 정적 파일 ${files.length}개 검사 완료`);

    if (options.dryRun) {
      log('✓ dry-run 완료: Vercel 로그인·link·deploy를 호출하지 않았습니다.');
      return;
    }

    const expectedIdentity = readExpectedGuideIdentity(projectRoot);
    const vercelCommand = [...(options.vercelCommand ?? resolveVercelCommand({ projectRoot }))];
    const vercelEnvironment = cleanEnvironment();
    const whoami = await runCommand({ argv: [...vercelCommand, 'whoami'], cwd: tempDirectory, env: vercelEnvironment });
    if (whoami.exitCode !== 0 || !whoami.stdout.trim()) {
      fail('Vercel 로그인이 필요합니다. 이 터미널에서 `vercel login`을 완료한 뒤 다시 실행하세요.');
    }
    log(`▸ Vercel 로그인 확인: ${whoami.stdout.trim().split(/\r?\n/).at(-1)}`);

    await checkedCommand(
      runCommand,
      {
        argv: [
          ...vercelCommand,
          'link',
          '--project', GUIDE_VERCEL_PROJECT,
          '--scope', expectedIdentity.orgId,
          '--yes',
        ],
        cwd: tempDirectory,
        env: vercelEnvironment,
      },
      '공개 설명서 Vercel 프로젝트를 연결하지 못했습니다.',
    );
    readLinkedProjectIdentity(tempDirectory, expectedIdentity);

    const deployment = await checkedCommand(
      runCommand,
      {
        argv: [...vercelCommand, 'deploy', '--prod', '--scope', expectedIdentity.orgId, '--yes'],
        cwd: tempDirectory,
        env: vercelEnvironment,
      },
      '공개 설명서 production 배포가 실패했습니다.',
    );
    const deploymentUrl = deploymentUrlFromStdout(deployment.stdout);
    if (deployment.stdout.trim()) log(deployment.stdout.trim());
    const inspection = await checkedCommand(
      runCommand,
      {
        argv: [
          ...vercelCommand,
          'inspect', deploymentUrl,
          '--wait',
          '--timeout', '45s',
          '--json',
          '--scope', expectedIdentity.orgId,
        ],
        cwd: tempDirectory,
        env: vercelEnvironment,
      },
      '새 공개 설명서 deployment의 alias를 확인하지 못했습니다.',
    );
    validateDeploymentInspection(inspection.stdout, deploymentUrl, expectedIdentity);
    await verifyPublishedGuide(buildEvidence, options.fetchLike ?? fetch);
    log(`✓ 공개 설명서 배포·검증 완료: ${GUIDE_CANONICAL_URL}`);
    log(`✓ AWS 설치 스크립트 정상: ${GUIDE_CANONICAL_URL}${GUIDE_REMOTE_SCRIPT_PATH}`);
  } finally {
    removeDeploymentTemp(tempDirectory);
  }
}

if (import.meta.main) {
  try {
    await runPublicGuideDeployment({ dryRun: process.argv.includes('--dry-run') });
  } catch (error) {
    if (!(error instanceof GuideDeployError)) throw error;
    console.error(`\n✗ ${error.message}\n`);
    process.exitCode = 1;
  }
}
