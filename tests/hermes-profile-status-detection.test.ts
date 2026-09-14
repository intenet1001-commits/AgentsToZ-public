import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { isInstalledHermesProfile } from '../src/hermesProfileInventory';

const api = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
const directory = readFileSync(new URL('../src/PortalMemoryDirectory.tsx', import.meta.url), 'utf8');
const route = api.slice(api.indexOf('if (url.pathname === "/api/hermes/profiles"'));

describe('Hermes profile status detection', () => {
  test('recognizes a newly created profile without config.yaml when its official profile files exist', () => {
    expect(route).toContain('existsSync(join(profileHome, ".env"))');
    expect(route).toContain('existsSync(join(profileHome, "SOUL.md"))');
  });

  test('does not resurrect an incomplete directory as a deleted profile', () => {
    expect(isInstalledHermesProfile({ configYamlPresent: false, envPresent: false, soulPresent: false })).toBe(false);
    expect(isInstalledHermesProfile({ configYamlPresent: false, envPresent: true, soulPresent: false })).toBe(false);
    expect(isInstalledHermesProfile({ configYamlPresent: false, envPresent: true, soulPresent: true })).toBe(true);
    expect(isInstalledHermesProfile({ configYamlPresent: true, envPresent: false, soulPresent: false })).toBe(true);
    expect(route).toContain('if (!configPresent) return;');
  });

  test('does not use a stale CLI list result as gateway evidence', () => {
    expect(route).toContain('gateway_state.json');
    expect(route).toContain('process.kill(pid, 0)');
    expect(route).toContain('localServerRunning: localServerProfiles.has(name)');
    expect(directory).toContain("profile.localServerRunning ? '사용 중'");
  });

  test('manages rename and confirmed delete through the official Hermes CLI', () => {
    expect(api).toContain("runHermesProfileCommand(['rename', profileName, canonicalNewName])");
    expect(api).toContain("runHermesProfileCommand(['delete', '-y', profileName])");
    expect(api).toContain('if (existsSync(profileHome))');
    expect(api).toContain('profileDirectoryRemoved: true');
    expect(api).toContain("if (profileName === 'default')");
    expect(api).toContain('body.confirmed !== true');
    expect(api).toContain("code: 'HERMES_DESKTOP_DELETE_REQUIRED'");
    expect(api).toContain('/api/hermes/profile/open-delete');
  });

  test('shows the current device scope and confirmation UI', () => {
    expect(directory).toContain('data-testid="portal-memory-current-device-scope"');
    expect(directory).toContain('Hermes profile·Gateway·로컬 경로 상태는 이 단말 기준입니다.');
    expect(directory).toContain('data-testid="portal-memory-onboarding-device-scope"');
    expect(directory).toContain('data-testid="hermes-profile-device-scope"');
    expect(directory).toContain('data-testid="hermes-profile-rename-confirm"');
    expect(directory).toContain('data-testid="hermes-profile-delete-confirm"');
    expect(directory).toContain('data-testid="hermes-profile-open-delete"');
    expect(directory).toContain('AI 프롬프트나 외부 CLI 삭제는 사용하지 않습니다.');
    expect(directory).toContain("profile.name !== 'default'");
  });
});
