import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultCodexUsageEnvironment, normalizeCodexRateLimits, readCodexLiveRateLimits } from '../codex-rate-limits';

describe('Codex rate-limit payload normalization', () => {
  test('maps the live app-server camelCase weekly bucket', () => {
    expect(normalizeCodexRateLimits({
      rateLimitsByLimitId: {
        codex: {
          planType: 'pro',
          primary: { usedPercent: 78, windowDurationMins: 10080, resetsAt: 1_786_164_688 },
        },
      },
    })).toEqual({
      primary: { used_percent: 78, window_minutes: 10080, resets_at: 1_786_164_688 },
      secondary: null,
      credits: null,
      plan_type: 'pro',
      limit_id: null,
      limit_name: null,
    });
  });

  test('keeps historical rollout snapshot payloads compatible', () => {
    expect(normalizeCodexRateLimits({
      primary: { used_percent: 42, window_minutes: 300, resets_at: 100 },
      secondary: { used_percent: 6, window_minutes: 10080, resets_at: 200 },
      plan_type: 'plus',
    })).toMatchObject({
      primary: { used_percent: 42, window_minutes: 300, resets_at: 100 },
      secondary: { used_percent: 6, window_minutes: 10080, resets_at: 200 },
      plan_type: 'plus',
    });
  });
});

describe('default Codex usage account', () => {
  const profile = '11111111-2222-4333-8444-555555555555';
  const orcaAccount = (home: string, appdata?: string, xdg?: string) => process.platform === 'darwin'
    ? join(home, 'Library', 'Application Support', 'orca', 'codex-accounts', profile, 'home')
    : process.platform === 'win32'
      ? join(appdata!, 'orca', 'codex-accounts', profile, 'home')
      : join(xdg || join(home, '.config'), 'orca', 'codex-accounts', profile, 'home');

  test('isolates inherited provider settings for a managed profile while retaining proxy and TLS settings', () => {
    const orcaHome = orcaAccount('/fixture/home', '/fixture/appdata');
    const source = {
      HOME: '/fixture/home', APPDATA: '/fixture/appdata', PATH: '/fixture/bin', HTTPS_PROXY: 'http://fixture.proxy',
      CODEX_HOME: orcaHome, CODEX_ACCESS_TOKEN: 'fixture-token',
      OPENAI_API_KEY: 'fixture-key', OPENAI_BASE_URL: 'http://fixture.endpoint',
      CODEX_AUTH_JSON: 'fixture-auth', CODEX_LOGIN_BASE_URL: 'http://fixture.login',
      OPENAI_ORGANIZATION: 'fixture-org', SSL_CERT_FILE: '/fixture/cert',
    };
    expect(defaultCodexUsageEnvironment(source)).toEqual({
      HOME: '/fixture/home', APPDATA: '/fixture/appdata', PATH: '/fixture/bin', HTTPS_PROXY: 'http://fixture.proxy',
      SSL_CERT_FILE: '/fixture/cert',
    });
    expect(source.CODEX_HOME).toBe(orcaHome);
    expect(source.OPENAI_API_KEY).toBe('fixture-key');
  });

  test('preserves explicit non-managed profiles and endpoint settings exactly', () => {
    const source = {HOME:'/fixture/home',CODEX_HOME:'/custom/other-account',OPENAI_API_KEY:'fixture',OPENAI_BASE_URL:'https://fixture.endpoint',CODEX_LOGIN_BASE_URL:'https://fixture.login'};
    expect(defaultCodexUsageEnvironment(source)).toEqual(source);
    expect(defaultCodexUsageEnvironment({...source,CODEX_HOME:''})).toEqual({...source,CODEX_HOME:''});
  });

  test('recognizes this app’s private account directory without matching lookalikes', () => {
    const appData = '/fixture/app-data';
    const managed = join(appData, 'cli-accounts-v1', `acct_${profile}`);
    expect(defaultCodexUsageEnvironment({CODEX_HOME:managed}, appData).CODEX_HOME).toBeUndefined();
    const lookalike = join(appData, 'cli-accounts-v1', 'personal');
    expect(defaultCodexUsageEnvironment({CODEX_HOME:lookalike}, appData).CODEX_HOME).toBe(lookalike);
  });

  test.skipIf(process.platform === 'win32')('real app-server child gets the default account environment while its parent stays unchanged', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'codex-usage-env-'));
    const binary = join(directory, 'codex-fixture');
    writeFileSync(binary, `#!/bin/sh
IFS= read -r request || exit 1
printf '%s\\n' '{"id":1,"result":{}}'
IFS= read -r notification || exit 1
IFS= read -r request || exit 1
if [ -n "\${CODEX_HOME+x}" ] || [ -n "\${OPENAI_API_KEY+x}" ] || [ -n "\${OPENAI_BASE_URL+x}" ] || [ -n "\${CODEX_LOGIN_BASE_URL+x}" ] || [ "\${AGENTSTOZ_USAGE_FIXTURE}" != keep ] || [ "\${SSL_CERT_FILE}" != fixture-cert ]; then
  printf '%s\\n' '{"id":2,"error":{"message":"unexpected child environment"}}'
else
  printf '%s\\n' '{"id":2,"result":{"rateLimits":{"planType":"pro","primary":{"usedPercent":85,"windowDurationMins":10080,"resetsAt":1793774119}}}}'
fi
`);
    chmodSync(binary, 0o700);
    const keys = ['CODEX_HOME', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_LOGIN_BASE_URL', 'SSL_CERT_FILE', 'AGENTSTOZ_USAGE_FIXTURE'] as const;
    const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    const managedHome = orcaAccount(process.env.HOME || '', process.env.APPDATA, process.env.XDG_CONFIG_HOME);
    process.env.CODEX_HOME = managedHome;
    process.env.OPENAI_API_KEY = 'fixture-key';
    process.env.OPENAI_BASE_URL = 'https://fixture.endpoint';
    process.env.CODEX_LOGIN_BASE_URL = 'https://fixture.login';
    process.env.SSL_CERT_FILE = 'fixture-cert';
    process.env.AGENTSTOZ_USAGE_FIXTURE = 'keep';
    try {
      const result = await readCodexLiveRateLimits(binary, 5_000);
      expect(result.rateLimits).toMatchObject({
        plan_type: 'pro', primary: {used_percent: 85, window_minutes: 10080},
      });
      expect(process.env.CODEX_HOME).toBe(managedHome);
      expect(process.env.OPENAI_API_KEY).toBe('fixture-key');
      expect(process.env.OPENAI_BASE_URL).toBe('https://fixture.endpoint');
    } finally {
      for (const key of keys) {
        if (before[key] === undefined) delete process.env[key];
        else process.env[key] = before[key];
      }
      rmSync(directory, {recursive: true, force: true});
    }
  });
});
