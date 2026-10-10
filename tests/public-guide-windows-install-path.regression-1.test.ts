import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// Regression: ISSUE-001 — Windows 초보자가 배포 설명서에서 설치 파일과 다음 행동을 찾을 수 없었음
// Found by /qa on 2026-08-29
// Report: .gstack/qa-reports/qa-report-agentstoz-guide-vercel-app-2026-08-29.md
describe('public guide Windows install path', () => {
  test('links the official latest release and names the exact installer pattern', () => {
    const guide = source('src/onboarding-guide-main.tsx');

    expect(guide).toContain('`${PUBLIC_REPOSITORY_URL}/releases/latest`');
    expect(guide).toContain('href={WINDOWS_RELEASES_URL}');
    expect(guide).toContain('최신 Windows 설치 파일 열기');
    expect(guide).toContain('AgentsToZ_byCS_<버전>_x64-setup.exe');
  });

  test('gives a mechanical install flow and keeps local-only use account-free', () => {
    const guide = source('src/onboarding-guide-main.tsx');
    const markdown = source('docs/user-guide/GUIDE.md');

    for (const document of [guide, markdown]) {
      expect(document).toContain('앱을 완전히 종료');
      expect(document).toContain('추가 정보');
      expect(document).toContain('로컬로 바로 시작');
      expect(document).toContain('Supabase');
    }
    expect(guide).toContain('계정 없이 바로 시작');
    expect(markdown).toContain('https://github.com/intenet1001-commits/AgentsToZ-public/releases/latest');
  });
});
