import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// docs/ui-glossary.md is the rule; this test keeps the source honest.
// fileURLToPath, not .pathname: on Windows a file URL's pathname keeps a leading
// slash before the drive letter ("/D:/..."), and every read then fails ENOENT.
const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const read = (path: string) => readFileSync(join(SRC, path), 'utf8');

function sourceFiles(dir = SRC): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) ? [relative(SRC, full)] : [];
  });
}

// Applied DB definitions are copies of migrations; they change with a migration.
const SQL_COPY = /(^|\/)(schemaSql|[A-Za-z]+Sql)\.ts$/;
const HANGUL = /[가-힣]/;

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');
}

/** Runs of literal text (between quotes, JSX tags or braces) that contain a word. */
function visibleSegmentsWith(text: string, word: RegExp): string[] {
  return stripComments(text).split('\n').flatMap(line =>
    (line.match(/[^"'`<>{}()]+/g) ?? []).filter(segment => word.test(segment) && HANGUL.test(segment)),
  );
}

describe('UI glossary', () => {
  // 한 기능을 버튼에서는 「새 터미널」, 목록에서는 「작업 세션」이라 불러서 처음 쓰는 사람이 서로 다른
  // 기능으로 읽었다(VOC 2026-10-05). 시작하는 **버튼 이름**은 「작업」을 쓴다. CLI가 그려지는 화면
  // 영역을 가리키는 말(「하단 터미널 펼치기」·「터미널이 종료되었습니다」)은 그대로 둔다.
  test('a button that starts work is named 작업, not 새 터미널', () => {
    const buttonish = /새 터미널/;
    const offenders = ['AiTerminalPanel.tsx', 'remoteControlMobilePage.ts', 'WorkroomPopoutApp.tsx', 'WorkroomDeviceSwitch.tsx']
      .flatMap(file => visibleSegmentsWith(read(file), buttonish).map(segment => `${file}: ${segment.trim()}`))
      // 설명문에서 「새 터미널을 여세요」처럼 동작을 서술하는 문장은 버튼 이름이 아니다.
      .filter(line => !/여세요|열 수 있습니다|연 뒤/.test(line));
    expect(offenders).toEqual([]);
  });

  test('기기, not 단말, everywhere in the app source', () => {
    const offenders = sourceFiles()
      .filter(file => !SQL_COPY.test(file))
      .flatMap(file => read(file).split('\n').map((line, index) => ({ file, line, index })))
      // A device *name* typed by the user is transliterated for Telegram usernames.
      .filter(({ line }) => line.includes('단말') && !line.includes("replaceAll('단말'"))
      .map(({ file, index }) => `${file}:${index + 1}`);
    expect(offenders).toEqual([]);
  });

  test('워크룸, not Workroom, in Korean UI copy', () => {
    const offenders = sourceFiles()
      .filter(file => file.endsWith('.tsx') || file === 'controlProfileSurface.ts')
      .flatMap(file => visibleSegmentsWith(read(file), /(?<![A-Za-z])Workroom(?![A-Za-z])/).map(segment => `${file}: ${segment.trim()}`));
    expect(offenders).toEqual([]);
  });

  test('아젠투지 names the OPS profile, voice and call surfaces', () => {
    const voice = read('VoiceSessionPanel.tsx');
    const profile = read('ControlProfilePanel.tsx');
    const app = read('App.tsx');
    expect(voice).not.toContain("'OPS 음성'");
    expect(voice).not.toContain('총괄과 프로젝트 담당자');
    expect(voice).toContain('아젠투지 호출');
    expect(profile).not.toContain('AgentsToZ OPS · 운영 프로필');
    expect(profile).toContain('아젠투지 설정');
    expect(app).not.toContain('>AgentsToZ OPS · 운영 프로필<');
    expect(app).toContain('label="아젠투지"');
  });

  test('the voice panel never prints the runtime label «AgentsToZ OPS» raw', () => {
    // The runtime keeps 'AgentsToZ OPS' as its internal target label; every place the
    // panel prints a session or target label must go through voiceTargetDisplayLabel.
    const voice = read('VoiceSessionPanel.tsx');
    expect(voice).not.toMatch(/\{session\.activeTarget\.label\}/);
    expect(voice).not.toMatch(/[:?]session\?\.label\?\?label\}/);
    expect(voice).toContain('voiceTargetDisplayLabel(session.activeTarget.label)');
    expect(voice).toContain("'연결 준비 중':voiceTargetDisplayLabel(session?.label??label)");
  });

  test('Supabase 올리기/받기 keep Push/Pull only as a parenthetical', () => {
    const app = read('App.tsx');
    expect(app).not.toContain('>Supabase Push</span>');
    expect(app).not.toContain('>Supabase Pull</span>');
    expect(app).not.toContain('<span className="text-xs font-medium">Push</span>');
    expect(app).not.toContain('<span className="text-xs font-medium">Pull</span>');
    expect(app).toContain('올리기 (Push)');
    expect(app).toContain('받기 (Pull)');
  });

  test('승인 없이 실행 (권한 우회), not «Bypass ON», and it is styled as a warning', () => {
    const panel = read('AiTerminalPanel.tsx');
    expect(panel).not.toContain('Bypass {bypassPermissions');
    expect(panel).toContain("승인 없이 실행 (권한 우회) · {bypassUnavailable?'이 기기에서는 꺼짐':bypassPermissions?'켜짐':'꺼짐'}");
    expect(panel).toContain("ai-terminal-btn--warn");
    expect(read('AiTerminalPanel.css')).toContain('.ai-terminal-btn--warn { color: var(--warn);');
  });

  test('프로젝트 코드, not 해시, on copy buttons (the clipboard wire format is unchanged)', () => {
    for (const file of ['App.tsx', 'RemoteControlProjectCard.tsx', 'remoteControlMobilePage.ts']) {
      const source = read(file);
      expect(source).not.toContain('해시 복사');
      expect(source).toContain('#프로젝트명 + 코드 복사');
    }
    expect(read('App.tsx')).not.toContain('>로컬프로젝트해시</span>');
    // Telegram and routing parse this exact label inside the copied text.
    expect(read('projectCode.ts')).toContain('로컬프로젝트해시');
  });
});
