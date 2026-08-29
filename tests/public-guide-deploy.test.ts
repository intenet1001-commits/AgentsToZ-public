import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GUIDE_BUILD_EVIDENCE_PATH,
  GUIDE_CANONICAL_URL,
  GUIDE_IDENTITY_FILE,
  GUIDE_VERCEL_PROJECT,
  collectGuideArtifactFiles,
  createGuideBuildEvidence,
  readLinkedProjectIdentity,
  resolveVercelCommand,
  runPublicGuideDeployment,
  scanGuideArtifact,
  stageGuideArtifact,
  validateDeploymentInspection,
  validateGuideVercelConfig,
  verifyPublishedGuide,
  type CommandRunner,
  type GuideProjectIdentity,
} from '../scripts/deploy-public-guide';

const roots: string[] = [];

const makeRoot = (prefix = 'agentstoz-guide-test-'): string => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
};

const staticConfig = {
  rewrites: [
    { source: '/', destination: '/guide.html' },
    { source: '/guide', destination: '/guide.html' },
  ],
  headers: [{ source: '/(.*)', headers: [{ key: 'X-Frame-Options', value: 'DENY' }] }],
};

const expectedIdentity: GuideProjectIdentity = {
  orgId: ['team', 'publicguideowner123'].join('_'),
  projectId: ['prj', 'publicguideproject123'].join('_'),
  projectName: GUIDE_VERCEL_PROJECT,
};

const writeIdentity = (root: string, identity: GuideProjectIdentity = expectedIdentity): void => {
  writeFileSync(join(root, GUIDE_IDENTITY_FILE), `${JSON.stringify(identity)}\n`, { mode: 0o600 });
};

const responseAt = (url: string, body: BodyInit): Response => {
  const response = new Response(body, { status: 200 });
  Object.defineProperty(response, 'url', { value: url });
  return response;
};

const writeArtifact = (root: string): string => {
  const dist = join(root, 'dist-guide');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'guide.html'), '<title>AgentsToZ 공개 설명서</title>');
  writeFileSync(join(dist, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(dist, 'site.webmanifest'), '{"name":"AgentsToZ"}');
  writeFileSync(join(dist, 'agentstoz-remote-device.sh'), '#!/usr/bin/env bash\nAGENT_VERSION="4"\n');
  writeFileSync(join(dist, 'assets', 'guide-ABC123.js'), `const guide=${JSON.stringify(GUIDE_CANONICAL_URL)};`);
  writeFileSync(join(root, 'vercel.guide.json'), `${JSON.stringify(staticConfig, null, 2)}\n`);
  return dist;
};

const tempDeployDirectories = (): Set<string> => new Set(
  readdirSync(tmpdir()).filter(name => name.startsWith('agentstoz-guide-deploy-')),
);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('public guide deploy artifact boundary', () => {
  test('stages only the audited dist-guide files plus the static Vercel config', () => {
    const root = makeRoot();
    const dist = writeArtifact(root);
    const destination = makeRoot('agentstoz-guide-stage-');
    const files = collectGuideArtifactFiles(dist);

    scanGuideArtifact(dist, files);
    validateGuideVercelConfig(join(root, 'vercel.guide.json'));
    stageGuideArtifact({
      distDirectory: dist,
      configPath: join(root, 'vercel.guide.json'),
      destination,
      files,
    });

    expect(files).toEqual([
      'agentstoz-remote-device.sh',
      'assets/guide-ABC123.js',
      'favicon.svg',
      'guide.html',
      'site.webmanifest',
    ]);
    expect(readdirSync(destination).sort()).toEqual([
      'agentstoz-remote-device.sh',
      'assets',
      'favicon.svg',
      'guide.html',
      'site.webmanifest',
      'vercel.json',
    ]);
    expect(readFileSync(join(destination, 'vercel.json'), 'utf8')).toBe(readFileSync(join(root, 'vercel.guide.json'), 'utf8'));
    expect(existsSync(join(destination, 'src'))).toBe(false);
    expect(existsSync(join(destination, 'tests'))).toBe(false);
    expect(existsSync(join(destination, '.env'))).toBe(false);
  });

  test.each(['.env', 'src/private.ts', 'tests/private.test.ts'])('rejects a forbidden output path: %s', forbidden => {
    const root = makeRoot();
    const dist = writeArtifact(root);
    const forbiddenPath = join(dist, ...forbidden.split('/'));
    mkdirSync(join(forbiddenPath, '..'), { recursive: true });
    writeFileSync(forbiddenPath, 'must not deploy');
    expect(() => collectGuideArtifactFiles(dist)).toThrow(/허용되지 않은 설명서 디렉터리|허용 목록/);
  });

  test('rejects personal deployment URLs, actual Supabase projects, and secret-shaped values', () => {
    const samples = [
      `https://${['portmanager', 'portal'].join('-')}.vercel.app`,
      encodeURIComponent(`https://${['portmanager', 'portal'].join('-')}-preview.vercel.app`),
      `https://${['private', 'project', 'ref'].join('-')}.supabase.co`,
      `ghp_${'A'.repeat(30)}`,
    ];
    for (const sample of samples) {
      const root = makeRoot();
      const dist = writeArtifact(root);
      writeFileSync(join(dist, 'assets', 'guide-ABC123.js'), sample);
      const files = collectGuideArtifactFiles(dist);
      expect(() => scanGuideArtifact(dist, files)).toThrow();
    }
  });

  test('requires a static-only Vercel guide configuration', () => {
    const root = makeRoot();
    const config = join(root, 'vercel.guide.json');
    writeFileSync(config, JSON.stringify({ ...staticConfig, outputDirectory: 'dist-guide' }));
    expect(() => validateGuideVercelConfig(config)).toThrow(/rewrites와 headers만/);
  });

  test('dry-run builds and scans without Vercel calls or root .vercel changes', async () => {
    const root = makeRoot();
    mkdirSync(join(root, '.vercel'), { recursive: true });
    const sentinel = '{"projectName":"personal-portal"}\n';
    writeFileSync(join(root, '.vercel', 'project.json'), sentinel);
    writeFileSync(join(root, 'vercel.guide.json'), `${JSON.stringify(staticConfig)}\n`);
    const calls: string[][] = [];
    const beforeTemps = tempDeployDirectories();
    const runner: CommandRunner = async ({ argv }) => {
      calls.push([...argv]);
      writeArtifact(root);
      return { exitCode: 0, stdout: 'guide built', stderr: '' };
    };

    await runPublicGuideDeployment({ projectRoot: root, dryRun: true, runCommand: runner, log: () => {} });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(-2)).toEqual(['run', 'build:guide']);
    expect(readFileSync(join(root, '.vercel', 'project.json'), 'utf8')).toBe(sentinel);
    expect(tempDeployDirectories()).toEqual(beforeTemps);
  });
});

describe('public guide Vercel identity gate', () => {
  test('uses argv commands in the disposable directory and verifies health after production deploy', async () => {
    const root = makeRoot();
    writeFileSync(join(root, 'vercel.guide.json'), `${JSON.stringify(staticConfig)}\n`);
    writeIdentity(root);
    const calls: Array<{ argv: string[]; cwd: string; hasToken: boolean }> = [];
    let stagedDirectory = '';
    const deploymentUrl = 'https://agentstoz-guide-build123.vercel.app';
    const runner: CommandRunner = async ({ argv, cwd, env }) => {
      calls.push({ argv: [...argv], cwd, hasToken: Object.hasOwn(env, 'VERCEL_TOKEN') });
      if (argv.includes('build:guide')) writeArtifact(root);
      if (argv.includes('whoami')) return { exitCode: 0, stdout: 'guide-owner\n', stderr: '' };
      if (argv.includes('link')) {
        stagedDirectory = cwd;
        expect(existsSync(join(cwd, GUIDE_IDENTITY_FILE))).toBe(false);
        mkdirSync(join(cwd, '.vercel'), { recursive: true });
        writeFileSync(join(cwd, '.vercel', 'project.json'), JSON.stringify(expectedIdentity));
      }
      if (argv.includes('deploy')) return { exitCode: 0, stdout: `${deploymentUrl}\n`, stderr: '' };
      if (argv.includes('inspect')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            name: GUIDE_VERCEL_PROJECT,
            url: new URL(deploymentUrl).hostname,
            target: 'production',
            readyState: 'READY',
            aliases: [new URL(GUIDE_CANONICAL_URL).hostname],
          }),
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const fetchLike = async (url: string) => {
      const path = new URL(url).pathname;
      const localPath = path === '/'
        ? join(stagedDirectory, 'guide.html')
        : join(stagedDirectory, path.slice(1));
      return responseAt(url, readFileSync(localPath));
    };

    await runPublicGuideDeployment({
      projectRoot: root,
      runCommand: runner,
      vercelCommand: ['/safe/vercel'],
      fetchLike,
      log: () => {},
    });

    const vercelCalls = calls.slice(1);
    expect(vercelCalls.map(call => call.argv.slice(1))).toEqual([
      ['whoami'],
      ['link', '--project', GUIDE_VERCEL_PROJECT, '--scope', expectedIdentity.orgId, '--yes'],
      ['deploy', '--prod', '--scope', expectedIdentity.orgId, '--yes'],
      ['inspect', deploymentUrl, '--wait', '--timeout', '45s', '--json', '--scope', expectedIdentity.orgId],
    ]);
    expect(vercelCalls.every(call => call.cwd !== root && !call.hasToken)).toBe(true);
    expect(existsSync(vercelCalls[0]!.cwd)).toBe(false);
  });

  test('never calls production deploy when linked projectName is not exact', async () => {
    const root = makeRoot();
    writeFileSync(join(root, 'vercel.guide.json'), `${JSON.stringify(staticConfig)}\n`);
    writeIdentity(root);
    const calls: string[][] = [];
    let stagedDirectory = '';
    const runner: CommandRunner = async ({ argv, cwd }) => {
      calls.push([...argv]);
      if (argv.includes('build:guide')) writeArtifact(root);
      if (argv.includes('whoami')) return { exitCode: 0, stdout: 'guide-owner\n', stderr: '' };
      if (argv.includes('link')) {
        stagedDirectory = cwd;
        mkdirSync(join(cwd, '.vercel'), { recursive: true });
        writeFileSync(join(cwd, '.vercel', 'project.json'), JSON.stringify({
          ...expectedIdentity,
          projectName: 'personal-portal',
        }));
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    await expect(runPublicGuideDeployment({
      projectRoot: root,
      runCommand: runner,
      vercelCommand: ['/safe/vercel'],
      log: () => {},
    })).rejects.toThrow(/projectName|사전 승인/);
    expect(calls.some(argv => argv.includes('deploy'))).toBe(false);
    expect(existsSync(stagedDirectory)).toBe(false);
  });

  test('requires a pre-existing ignored identity and never trusts the current link on first use', async () => {
    const root = makeRoot();
    writeFileSync(join(root, 'vercel.guide.json'), `${JSON.stringify(staticConfig)}\n`);
    const calls: string[][] = [];
    const runner: CommandRunner = async ({ argv }) => {
      calls.push([...argv]);
      if (argv.includes('build:guide')) writeArtifact(root);
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    await expect(runPublicGuideDeployment({
      projectRoot: root,
      runCommand: runner,
      vercelCommand: ['/safe/vercel'],
      log: () => {},
    })).rejects.toThrow(GUIDE_IDENTITY_FILE);
    expect(calls).toHaveLength(1);
    expect(calls.some(argv => argv.includes('link') || argv.includes('deploy'))).toBe(false);
  });

  test.each([
    ['orgId', { ...expectedIdentity, orgId: ['team', 'otherowner123456'].join('_') }],
    ['projectId', { ...expectedIdentity, projectId: ['prj', 'otherproject123456'].join('_') }],
    ['projectName', { ...expectedIdentity, projectName: 'other-guide' }],
  ] as const)('rejects a linked project with a mismatched %s', (_field, linkedIdentity) => {
    const temp = makeRoot('agentstoz-guide-link-');
    mkdirSync(join(temp, '.vercel'), { recursive: true });
    writeFileSync(join(temp, '.vercel', 'project.json'), JSON.stringify(linkedIdentity));
    expect(() => readLinkedProjectIdentity(temp, expectedIdentity)).toThrow();
  });

  test('requires deployment stdout and inspect evidence to point to the canonical production alias', () => {
    const deploymentUrl = 'https://agentstoz-guide-build123.vercel.app';
    const validInspection = {
      name: GUIDE_VERCEL_PROJECT,
      url: new URL(deploymentUrl).hostname,
      target: 'production',
      readyState: 'READY',
      aliases: [new URL(GUIDE_CANONICAL_URL).hostname],
    };
    expect(() => validateDeploymentInspection(
      JSON.stringify(validInspection),
      deploymentUrl,
      expectedIdentity,
    )).not.toThrow();
    expect(() => validateDeploymentInspection(
      JSON.stringify({ ...validInspection, aliases: ['other-guide.vercel.app'] }),
      deploymentUrl,
      expectedIdentity,
    )).toThrow(/canonical alias/);
  });

  test('rejects an old canonical response whose marker is not from this build', async () => {
    const temp = makeRoot('agentstoz-guide-evidence-');
    writeFileSync(join(temp, 'guide.html'), '<title>AgentsToZ 공개 설명서</title>');
    writeFileSync(join(temp, 'agentstoz-remote-device.sh'), '#!/usr/bin/env bash\nAGENT_VERSION="4"\n');
    const evidence = createGuideBuildEvidence(temp);
    const oldEvidence = { ...evidence, marker: '00000000-0000-4000-8000-000000000000' };
    const fetchLike = async (url: string) => {
      const path = new URL(url).pathname;
      if (path === GUIDE_BUILD_EVIDENCE_PATH) return responseAt(url, JSON.stringify(oldEvidence));
      return responseAt(url, readFileSync(join(temp, path === '/' ? 'guide.html' : path.slice(1))));
    };

    await expect(verifyPublishedGuide(evidence, fetchLike, 1)).rejects.toThrow(/marker\/hash/);
  });

  test('rejects live guide or AWS script bytes that do not match this build evidence', async () => {
    const temp = makeRoot('agentstoz-guide-live-hash-');
    writeFileSync(join(temp, 'guide.html'), '<title>AgentsToZ 공개 설명서</title>');
    writeFileSync(join(temp, 'agentstoz-remote-device.sh'), '#!/usr/bin/env bash\nAGENT_VERSION="4"\n');
    const evidence = createGuideBuildEvidence(temp);
    const fetchLike = async (url: string) => {
      const path = new URL(url).pathname;
      if (path === GUIDE_BUILD_EVIDENCE_PATH) return responseAt(url, JSON.stringify(evidence));
      if (path.endsWith('.sh')) return responseAt(url, '#!/usr/bin/env bash\nAGENT_VERSION="3"\n');
      return responseAt(url, readFileSync(join(temp, 'guide.html')));
    };

    await expect(verifyPublishedGuide(evidence, fetchLike, 1)).rejects.toThrow(/marker\/hash/);
  });

  test('resolves a Windows npm .cmd launcher to node plus vc.js without a shell', () => {
    const root = makeRoot();
    const bin = join(root, 'npm-bin');
    const cli = join(bin, 'node_modules', 'vercel', 'dist', 'vc.js');
    const launcher = join(bin, 'vercel.cmd');
    const node = join(bin, 'node.exe');
    mkdirSync(join(bin, 'node_modules', 'vercel', 'dist'), { recursive: true });
    writeFileSync(cli, 'console.log("vercel")');
    writeFileSync(launcher, '@node node_modules\\vercel\\dist\\vc.js %*');
    writeFileSync(node, 'node fixture');
    chmodSync(launcher, 0o644);
    chmodSync(node, 0o644);

    expect(resolveVercelCommand({ projectRoot: root, pathValue: bin, platform: 'win32' })).toEqual([node, cli]);
  });
});
