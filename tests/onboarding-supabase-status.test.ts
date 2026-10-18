import { describe, expect, test } from 'bun:test';
import { createSupabaseStatusReader, probeSupabaseProjects, supabaseStatusFromProbe } from '../src/onboardingSupabaseStatus';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('bounded Supabase onboarding status', () => {
  test('network/permission/output failures preserve unknown and do not recommend login', () => {
    for (const stderr of ['network failed: login', 'permission denied', 'new unexpected output']) {
      const result = supabaseStatusFromProbe('/cli', { ok: false, timedOut: false, stdout: '', stderr });
      expect(result).toMatchObject({ installed: true, loggedIn: null, state: 'unknown' });
      expect(result.loginCmd).toBeUndefined(); expect(JSON.stringify(result)).not.toContain(stderr);
    }
    expect(supabaseStatusFromProbe('/cli', { ok: false, timedOut: false, stdout: '', stderr: 'Access token not provided' }))
      .toMatchObject({ installed: true, loggedIn: false, state: 'needs-login' });
  });
  test('only recognized complete JSON lists are ready; credentials and extra fields never escape', () => {
    const row = { id: 'abcdefghijklmnopqrst', name: 'Example workspace', region: 'ap-northeast-2', database: { password: 'secret-test' } };
    const make = (stdout: string) => supabaseStatusFromProbe('/cli', { ok: true, stdout, stderr: 'private diagnostic', timedOut: false });
    expect(make(JSON.stringify([row]))).toMatchObject({ state: 'ready', projects: [{ ref: row.id, name: row.name, region: row.region }] });
    expect(JSON.stringify(make(JSON.stringify([row])))).not.toContain('secret-test');
    expect(make('[]')).toMatchObject({ state: 'ready', projects: [] });
    for (const value of ['format changed', '{}', JSON.stringify([row, {}]), JSON.stringify([row, row])]) {
      expect(make(value)).toMatchObject({ state: 'unknown', loggedIn: null });
      expect(make(value).projects).toBeUndefined();
    }
  });
  test('concurrent reads share a probe; next check reads fresh account state', async () => {
    let count = 0;
    let finish!: (value: { ok: boolean; stdout: string; stderr: string; timedOut: boolean }) => void;
    const read = createSupabaseStatusReader(() => { count++; return new Promise(resolve => { finish = resolve; }); });
    const first = read('/cli'), second = read('/cli');
    expect(count).toBe(1); finish({ ok: true, stdout: '[]', stderr: '', timedOut: false });
    expect(await first).toEqual(await second);
    const third = read('/cli'); expect(count).toBe(2);
    finish({ ok: false, stdout: '', stderr: 'not logged in', timedOut: false });
    expect((await third).loggedIn).toBe(false);
  });
  test.skipIf(process.platform === 'win32')('a stalled process is killed and remains unknown', async () => {
    const root = mkdtempSync(join(tmpdir(), 'supabase-probe-'));
    try {
      const executable = join(root, 'supabase'); writeFileSync(executable, '#!/bin/sh\nexec sleep 30\n'); chmodSync(executable, 0o700);
      const start = performance.now();
      const probe = await probeSupabaseProjects(executable, 100);
      expect(performance.now() - start).toBeLessThan(3000); expect(probe.timedOut).toBe(true);
      expect(supabaseStatusFromProbe(executable, probe)).toMatchObject({ installed: true, loggedIn: null, state: 'unknown' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
