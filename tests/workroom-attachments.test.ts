import {afterEach, describe, expect, test} from 'bun:test';
import {existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {
  WORKROOM_FILE_MAX_BYTES, addWorkroomAttachments, attachmentBaseName, attachmentLimitMessage, attachmentPathProblem,
  WORKROOM_TYPED_PATHS_MAX, displayAttachmentName, hasUnsafeAttachmentChars, isAbsoluteAttachmentPath, sanitizeWorkroomFileName,
  shellQuoteAttachmentPath, workroomAttachCopy, workroomRouteAttachmentRefusal, workroomTypedPathsText,
} from '../src/workroomAttachmentRules';
import {splitWorkroomAttachmentBlock, withSuffixBeforeWorkroomAttachments, workroomAttachmentMessage, workroomAttachmentsMessage, workroomImageMessage} from '../src/workroomImageAttachments';
import {
  WorkroomAttachmentError, assertWorkroomFileAttachments, importWorkroomAttachmentPaths, inspectWorkroomReferencePath,
  isWorkroomFilePath, pruneWorkroomFiles, saveWorkroomFile, typeWorkroomDroppedPaths, workroomFileRoot,
} from '../src/workroomFiles';
import {handleWorkroomAttachmentRequest} from '../src/workroomAttachmentHost';
import {isWorkroomImagePath} from '../src/workroomImages';
import {normalizeWorkroomImageResponse} from '../src/workroomImageClient';
import {decideDropOwner, dropPointToCss, dropPositionUnit, type DropGeometry, type DropHitElement} from '../src/workroomDropArbiter';

// S3 (2026-10-16): 「사진 첨부」·「파일 첨부」 and drag-and-drop in the Mac Workroom.
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true}); });
const temp = (prefix = 'agentstoz-files-') => { const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix))); dirs.push(dir); return dir; };
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n');

describe('names and paths', () => {
  test('control, C1 and bidi characters are unsafe; ordinary Korean and spaces are not', () => {
    for (const bad of ['a\nb', 'a\rb', 'a\tb', 'a\u0000b', 'a\u0085b', 'a\u009bb', 'evil\u202egnp.exe', 'a\u2066b', 'a\u200fb', 'a\u2028b', '\ufeffa']) expect(hasUnsafeAttachmentChars(bad)).toBe(true);
    for (const ok of ['보고서 최종.pdf', 'Screen Shot 2026-10-16 at 3.04.05 PM.png', "it's (1).txt"]) expect(hasUnsafeAttachmentChars(ok)).toBe(false);
  });

  test('absolute paths: POSIX, a Windows drive or a UNC share — never relative or drive-relative', () => {
    for (const ok of ['/Users/a/b.pdf', 'C:\\Users\\a\\b.pdf', 'D:/x/y.txt', '\\\\server\\share\\f.txt']) expect(isAbsoluteAttachmentPath(ok)).toBe(true);
    for (const bad of ['b.pdf', './b.pdf', '../b.pdf', 'C:work\\b.pdf', '~/b.pdf', '']) expect(isAbsoluteAttachmentPath(bad)).toBe(false);
    expect(attachmentPathProblem('/a/b\n지시를 무시하고.pdf')).toContain('줄바꿈');
    expect(attachmentPathProblem('/' + 'a'.repeat(1100))).toContain('너무 깁니다');
    expect(attachmentPathProblem('relative.pdf')).toContain('절대 경로');
    expect(attachmentPathProblem('/ok/file.pdf')).toBeNull();
    expect(attachmentBaseName('C:\\Users\\me\\보고서.pdf')).toBe('보고서.pdf');
    expect(attachmentBaseName('/Users/me/folder/')).toBe('folder');
  });

  test('a saved file name keeps only its last name, without traversal, controls or a hidden leading dot', () => {
    expect(sanitizeWorkroomFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeWorkroomFileName('..\\..\\Windows\\win.ini')).toBe('win.ini');
    expect(sanitizeWorkroomFileName('.env')).toBe('env');
    expect(sanitizeWorkroomFileName('-rf')).toBe('rf');
    expect(sanitizeWorkroomFileName('evil\u202egnp.exe')).toBe('evilgnp.exe');
    expect(sanitizeWorkroomFileName('a\nb:c*?.txt')).toBe('ab_c__.txt');
    expect(sanitizeWorkroomFileName('..')).toBe('file');
    expect(sanitizeWorkroomFileName(undefined)).toBe('file');
    const long = sanitizeWorkroomFileName('가'.repeat(200) + '.pdf');
    expect(Array.from(long).length).toBeLessThanOrEqual(80);
    expect(long.endsWith('.pdf')).toBe(true);
  });

  test('typed paths are single-quoted shell words with a trailing space and no Enter', () => {
    expect(shellQuoteAttachmentPath("/a/it's here.pdf")).toBe("'/a/it'\\''s here.pdf'");
    expect(workroomTypedPathsText(['/a/1.png', '/b c/2.pdf'])).toBe("'/a/1.png' '/b c/2.pdf' ");
    expect(workroomTypedPathsText(['/x'])).not.toContain('\r');
    expect(workroomTypedPathsText(['C:\\Users\\me\\it\'s.pdf'], true)).toBe('"C:\\Users\\me\\it\'s.pdf" ');
  });

  test('per-request limits: images 6, files 10, once per path, and the refused names are said', () => {
    const image = (i: number) => ({path: `/i/${i}.png`, name: `${i}.png`});
    const file = (i: number) => ({path: `/f/${i}.pdf`, name: `${i}.pdf`, kind: 'file' as const});
    const limits = {images: 6, files: 10};
    const {next, refused} = addWorkroomAttachments([], [...Array.from({length: 8}, (_, i) => image(i)), ...Array.from({length: 12}, (_, i) => file(i)), image(0)], limits);
    expect(next.filter(item => !('kind' in item)).length).toBe(6);
    expect(next.filter(item => 'kind' in item).length).toBe(10);
    expect(refused).toEqual(['6.png', '7.png', '10.pdf', '11.pdf']);
    expect(attachmentLimitMessage(refused, limits)).toContain('이미지는 6개, 파일은 10개');
    expect(attachmentLimitMessage([], limits)).toBeNull();
  });
});

describe('the request text: an image block, then a file block', () => {
  const images = ['/a/1.png'];
  const files = ['/Users/me/보고서.pdf', '/Users/me/project'];

  test('both blocks follow the request in order; image-only output is unchanged from before', () => {
    expect(workroomAttachmentMessage('이 문서 검토해줘  ', images, files)).toBe(
      '이 문서 검토해줘\n\n[첨부 이미지 1개 — 각 파일을 열어 확인하세요]\n/a/1.png\n\n[첨부 파일 2개 — 각 파일을 열어 확인하세요]\n/Users/me/보고서.pdf\n/Users/me/project');
    expect(workroomAttachmentMessage('', [], files)).toBe('[첨부 파일 2개 — 각 파일을 열어 확인하세요]\n/Users/me/보고서.pdf\n/Users/me/project');
    expect(workroomAttachmentMessage('그대로', [], [])).toBe('그대로');
    expect(workroomImageMessage('x', images)).toBe('x\n\n[첨부 이미지 1개 — 각 파일을 열어 확인하세요]\n/a/1.png');
    expect(workroomAttachmentsMessage('x', [{path: '/a/1.png'}, {path: '/f.pdf', kind: 'file'}])).toBe(workroomAttachmentMessage('x', ['/a/1.png'], ['/f.pdf']));
  });

  test('the host splits exactly what the composer wrote; a mere quote is plain text', () => {
    expect(splitWorkroomAttachmentBlock(workroomAttachmentMessage('요청', images, files))).toEqual({text: '요청', paths: images, files});
    expect(splitWorkroomAttachmentBlock(workroomAttachmentMessage('', [], files))).toEqual({text: '', paths: [], files});
    expect(splitWorkroomAttachmentBlock(workroomAttachmentMessage('요청', images, []))).toEqual({text: '요청', paths: images});
    expect(splitWorkroomAttachmentBlock('요청\n\n[첨부 파일 3개 — 각 파일을 열어 확인하세요]\n/a\n/b')).toBeNull();
    expect(splitWorkroomAttachmentBlock('요청\n\n[첨부 파일 1개 — 각 파일을 열어 확인하세요]\nrelative.pdf')).toBeNull();
    expect(splitWorkroomAttachmentBlock(workroomAttachmentMessage('요청', [], ['C:\\Users\\me\\a.pdf']))?.files).toEqual(['C:\\Users\\me\\a.pdf']);
  });

  test('a host suffix lands on the request line, never on a path line', () => {
    for (const enter of ['', '\r']) {
      const out = withSuffixBeforeWorkroomAttachments(workroomAttachmentMessage('요청', images, files) + enter, ' (참고)');
      expect(out).toBe(workroomAttachmentMessage('요청 (참고)', images, files) + enter);
    }
  });
});

describe('the host: saved files, referenced paths, imports', () => {
  test('a pasted file is saved privately under today\'s workroom-files folder with a sanitised name', () => {
    const dir = temp(), now = new Date(2026, 9, 16, 9, 8, 7);
    const saved = saveWorkroomFile(dir, PDF, '../../보고서.pdf', now);
    expect(saved).toMatchObject({kind: 'file', name: '보고서.pdf', bytes: PDF.byteLength});
    expect(dirname(saved.path)).toBe(join(workroomFileRoot(dir), '2026-10-16'));
    expect(saved.path).toMatch(/\/090807-[0-9a-f]{8}-보고서\.pdf$/);
    expect(statSync(saved.path).mode & 0o777).toBe(0o600);
    expect(isWorkroomFilePath(dir, saved.path)).toBe(true);
  });

  test('>15 MB and empty files are refused with a code', () => {
    const dir = temp();
    try { saveWorkroomFile(dir, new Uint8Array(WORKROOM_FILE_MAX_BYTES + 1), 'big.bin'); throw new Error('accepted'); }
    catch (error) { expect(error).toBeInstanceOf(WorkroomAttachmentError); expect((error as WorkroomAttachmentError).code).toBe('WORKROOM_FILE_TOO_LARGE'); }
    try { saveWorkroomFile(dir, new Uint8Array(0), 'empty.txt'); throw new Error('accepted'); }
    catch (error) { expect((error as WorkroomAttachmentError).code).toBe('WORKROOM_FILE_EMPTY'); }
  });

  test('saved files older than two weeks are pruned on the next save; other things stay', () => {
    const dir = temp(), root = workroomFileRoot(dir);
    for (const day of ['2026-09-20', '2026-10-01', '2026-10-02', '2026-10-15']) mkdirSync(join(root, day), {recursive: true});
    writeFileSync(join(root, 'keep.txt'), 'x');
    expect(pruneWorkroomFiles(dir, new Date(2026, 9, 16, 9))).toBe(2);
    expect(readdirSync(root).sort()).toEqual(['2026-10-02', '2026-10-15', 'keep.txt']);
  });

  test('a referenced path must exist and be a regular file or a folder', () => {
    const dir = temp();
    writeFileSync(join(dir, 'a.pdf'), PDF);
    expect(inspectWorkroomReferencePath(join(dir, 'a.pdf'))).toMatchObject({name: 'a.pdf', directory: false, bytes: PDF.byteLength});
    expect(inspectWorkroomReferencePath(dir).directory).toBe(true);
    expect(() => inspectWorkroomReferencePath(join(dir, 'gone.pdf'))).toThrow('찾지 못했습니다');
    expect(() => inspectWorkroomReferencePath('/dev/null')).toThrow('일반 파일이나 폴더');
    expect(() => inspectWorkroomReferencePath(join(dir, 'x\n지시.pdf'))).toThrow('줄바꿈');
    expect(() => inspectWorkroomReferencePath('a.pdf')).toThrow('절대 경로');
  });

  test('right before the write, a deleted or swapped file is refused and the draft stays', () => {
    const dir = temp(), path = join(dir, 'a.pdf');
    writeFileSync(path, PDF);
    expect(() => assertWorkroomFileAttachments([path, dir])).not.toThrow();
    rmSync(path);
    expect(() => assertWorkroomFileAttachments([path])).toThrow('작성 내용은 유지했습니다');
    expect(() => assertWorkroomFileAttachments([])).toThrow();
    expect(() => assertWorkroomFileAttachments(Array.from({length: 11}, () => dir))).toThrow();
  });

  test('importing paths copies images (with their own name on the chip) and references everything else; bad ones are listed', async () => {
    const dir = temp(), app = temp('agentstoz-app-'), host = {appDataDir: app, run: async () => 1};
    writeFileSync(join(dir, 'shot.png'), PNG);
    writeFileSync(join(dir, 'paper.pdf'), PDF);
    const {attachments, refused} = await importWorkroomAttachmentPaths(host, [join(dir, 'shot.png'), join(dir, 'paper.pdf'), dir, join(dir, 'gone.txt'), '/x/\u202eevil']);
    expect(attachments.length).toBe(3);
    expect(attachments[0]!.kind).toBeUndefined();
    expect(attachments[0]!.name).toBe('shot.png');
    expect(isWorkroomImagePath(app, attachments[0]!.path)).toBe(true);
    expect(attachments[1]).toEqual({kind: 'file', path: join(dir, 'paper.pdf'), name: 'paper.pdf', bytes: PDF.byteLength});
    expect(attachments[2]).toMatchObject({kind: 'file', path: dir, directory: true});
    // A refused name is shown to the person: never with the control or bidi characters that caused the refusal.
    expect(refused.map(item => item.name)).toEqual(['gone.txt', 'evil']);
    expect(existsSync(join(app, 'workroom-files'))).toBe(false);
  });

  test('the route accepts exactly the three new operations and still the old two', async () => {
    const app = temp(), host = {appDataDir: app, run: async () => 1};
    const saved = await handleWorkroomAttachmentRequest(host, {operation: 'save-file', data: Buffer.from(PDF).toString('base64'), name: 'a.pdf'});
    expect('kind' in saved && saved.kind).toBe('file');
    const image = await handleWorkroomAttachmentRequest(host, {operation: 'save', data: Buffer.from(PNG).toString('base64')});
    expect('path' in image && isWorkroomImagePath(app, image.path)).toBe(true);
    for (const body of [{operation: 'save-file', data: 'x!', name: 'a'}, {operation: 'save-file', data: 'aGk=', name: 'a', path: '/etc/x'},
      {operation: 'import', paths: []}, {operation: 'import', paths: 'x'}, {operation: 'type-paths', sessionId: 's', targetId: 't', paths: ['/x']},
      {operation: 'delete'}]) {
      await expect(handleWorkroomAttachmentRequest(host, body)).rejects.toThrow();
    }
  });
});

describe('a drop on the terminal in direct input mode', () => {
  const terminal = (rows: string[] | null, bracketed: boolean) => {
    const writes: string[] = [];
    return {writes, terminal: {screenRows: async () => rows, bracketedPaste: async () => bracketed, write: async (_: string, data: string) => { writes.push(data); }}};
  };
  const awaits = (rows: readonly string[]) => rows.some(row => row.includes('(y/n)'));

  test('types the quoted paths as one bracketed paste when the CLI enabled it, else as text; never Enter', async () => {
    const dir = temp(); writeFileSync(join(dir, 'a b.pdf'), PDF);
    const on = terminal(['> '], true);
    expect(await typeWorkroomDroppedPaths(on.terminal, awaits, {sessionId: 's', targetId: 't', paths: [join(dir, 'a b.pdf')]})).toEqual({typed: 1});
    expect(on.writes).toEqual([`\x1b[200~'${join(dir, 'a b.pdf')}' \x1b[201~`]);
    const off = terminal(['> '], false);
    await typeWorkroomDroppedPaths(off.terminal, awaits, {sessionId: 's', targetId: 't', paths: [dir]});
    expect(off.writes).toEqual([`'${dir}' `]);
  });

  test('refused while the screen waits for an answer, when the screen is unreadable, or for an unsafe path', async () => {
    const dir = temp();
    const asking = terminal(['Proceed? (y/n)'], true);
    await expect(typeWorkroomDroppedPaths(asking.terminal, awaits, {sessionId: 's', targetId: 't', paths: [dir]})).rejects.toThrow('답을 기다리는 화면');
    expect(asking.writes).toEqual([]);
    const gone = terminal(null, true);
    await expect(typeWorkroomDroppedPaths(gone.terminal, awaits, {sessionId: 's', targetId: 't', paths: [dir]})).rejects.toThrow('읽지 못해');
    const fine = terminal(['> '], true);
    await expect(typeWorkroomDroppedPaths(fine.terminal, awaits, {sessionId: 's', targetId: 't', paths: [join(dir, '1\n2')]})).rejects.toThrow();
    expect(fine.writes).toEqual([]);
  });
});

describe('review fixes (2026-10-16)', () => {
  test('a refused name is displayed without control or bidi characters and cut by code points', () => {
    expect(displayAttachmentName('/tmp/report\u202efdp.exe')).toBe('reportfdp.exe');
    expect(displayAttachmentName('/tmp/a\nb')).toBe('ab');
    expect(displayAttachmentName('/tmp/\u202e\u2066')).toBe('이름에 제어·방향 문자가 있는 항목');
    const emoji = displayAttachmentName('/x/' + '😀'.repeat(100));
    expect(Array.from(emoji).length).toBe(80);
    expect(emoji.endsWith('\ud83d')).toBe(false);
  });

  test('more than 16 typed paths is its own refusal, not 「입력할 경로가 없습니다」', async () => {
    const dir = temp();
    const paths = Array.from({length: 17}, (_, i) => { const path = join(dir, `${i}.txt`); writeFileSync(path, 'x'); return path; });
    const writes: string[] = [];
    const terminal = {screenRows: async () => ['> '], bracketedPaste: async () => false, write: async (_: string, data: string) => { writes.push(data); }};
    const refusal = typeWorkroomDroppedPaths(terminal, () => false, {sessionId: 's', targetId: 't', paths});
    await expect(refusal).rejects.toThrow(`한 번에 ${WORKROOM_TYPED_PATHS_MAX}개까지`);
    await expect(typeWorkroomDroppedPaths(terminal, () => false, {sessionId: 's', targetId: 't', paths})).rejects.toMatchObject({code: 'WORKROOM_TYPED_PATHS_TOO_MANY'});
    await expect(typeWorkroomDroppedPaths(terminal, () => false, {sessionId: 's', targetId: 't', paths: []})).rejects.toThrow('입력할 경로가 없습니다');
    expect(writes).toEqual([]);
  });

  test('a route to another AgentsToZ refuses a draft with attachments; this Mac and an app route do not', () => {
    const file = [{kind: 'file' as const, path: '/Users/me/notes.md', name: 'notes.md'}];
    const image = [{path: '/Users/me/Library/Application Support/x/workroom-images/1.png', name: '1.png'}];
    for (const attachments of [file, image]) {
      const refusal = workroomRouteAttachmentRefusal(attachments, {crossDevice: true, machine: '이 Mac'});
      expect(refusal).toContain('이 Mac에만 있어 다른 아젠투지로 보낼 수 없습니다');
    }
    expect(workroomRouteAttachmentRefusal(file, {crossDevice: false, machine: '이 Mac'})).toBeNull();
    expect(workroomRouteAttachmentRefusal([], {crossDevice: true, machine: '이 Mac'})).toBeNull();
    expect(workroomRouteAttachmentRefusal(file, {crossDevice: true, machine: '이 PC'})).toContain('이 PC에만');
  });

  test('copy names the paste key and the machine for the platform', () => {
    const mac = workroomAttachCopy(false), win = workroomAttachCopy(true);
    expect(mac.paste).toBe('⌘V'); expect(win.paste).toBe('Ctrl+V');
    for (const text of Object.values(win)) { expect(text).not.toContain('⌘'); expect(text).not.toContain('Mac'); }
    expect(win.legacy).toContain('이 PC의 앱');
    expect(mac.legacy).toBe('이 Mac의 앱이 아직 파일 첨부를 지원하지 않습니다. 앱을 업데이트하세요 — 이미지 붙여넣기와 화면 캡처는 그대로 쓸 수 있습니다.');
    expect(mac.fileTitle).toContain('이 Mac에 있는 파일');
    expect(win.fileTitle).toContain('이 PC에 있는 파일');
  });
});

describe('composer records from the host', () => {
  test('file records and Windows paths are accepted; unsafe names and malformed kinds are not', () => {
    expect(normalizeWorkroomImageResponse({kind: 'file', path: '/a/b.pdf', name: 'b.pdf', bytes: 3})).toEqual({kind: 'file', path: '/a/b.pdf', name: 'b.pdf', bytes: 3});
    expect(normalizeWorkroomImageResponse({kind: 'file', path: '/a/dir', name: 'dir', bytes: 0, directory: true})).toMatchObject({directory: true});
    expect(normalizeWorkroomImageResponse({path: 'C:\\x\\1.png', name: '1.png', bytes: 1})).toEqual({path: 'C:\\x\\1.png', name: '1.png', bytes: 1});
    for (const bad of [{kind: 'other', path: '/a', name: 'a', bytes: 1}, {path: '/a', name: 'a\u202e', bytes: 1}, {path: 'rel', name: 'a', bytes: 1}, {path: '/a', name: 'a', bytes: 1, directory: false}]) {
      expect(() => normalizeWorkroomImageResponse(bad)).toThrow();
    }
  });
});

describe('the drop arbiter: exactly one owner', () => {
  // A tiny DOM: each element knows its ancestors' selectors.
  const element = (matches: Record<string, string | null>): DropHitElement => ({
    closest: selector => (selector in matches ? element(matches) : null),
    getAttribute: name => matches[`[${name}]`] ?? null,
  });
  const live = new Set(['zone-1']);
  const composer = element({'[data-workroom-drop-zone]': 'zone-1'});
  const terminal = element({'[data-workroom-drop-zone]': 'zone-1', '.ai-terminal-surface': ''});
  const modal = element({});

  test('composer → workroom; terminal area → workroom terminal; VOC on → VOC; modal or outside → FolderDropZone', () => {
    expect(decideDropOwner({vocActive: false, hit: composer, liveZones: live})).toEqual({kind: 'workroom', zoneId: 'zone-1', area: 'composer'});
    expect(decideDropOwner({vocActive: false, hit: terminal, liveZones: live})).toEqual({kind: 'workroom', zoneId: 'zone-1', area: 'terminal'});
    expect(decideDropOwner({vocActive: true, hit: composer, liveZones: live})).toEqual({kind: 'voc'});
    expect(decideDropOwner({vocActive: false, hit: modal, liveZones: live})).toEqual({kind: 'folder'});
    expect(decideDropOwner({vocActive: false, hit: null, liveZones: live})).toEqual({kind: 'folder'});
    // A stale zone attribute (a panel that unregistered) does not own drops.
    expect(decideDropOwner({vocActive: false, hit: composer, liveZones: new Set()})).toEqual({kind: 'folder'});
  });

  test('an open modal dialog drawn inside the Workroom (its backdrop or its contents) does not hand the drop to the hidden composer', () => {
    const backdrop = element({'[data-workroom-drop-zone]': 'zone-1', 'dialog:modal': ''});
    expect(decideDropOwner({vocActive: false, hit: backdrop, liveZones: live})).toEqual({kind: 'folder'});
    // A drop zone that itself lies inside the dialog still owns its drops.
    const zoneInDialog = element({'[data-workroom-drop-zone]': 'zone-1', 'dialog:modal': '', 'dialog:modal [data-workroom-drop-zone]': 'zone-1'});
    expect(decideDropOwner({vocActive: false, hit: zoneInDialog, liveZones: live})).toEqual({kind: 'workroom', zoneId: 'zone-1', area: 'composer'});
  });

  test('never two owners: every combination yields one kind', () => {
    for (const vocActive of [false, true]) for (const hit of [composer, terminal, modal, null]) {
      const owner = decideDropOwner({vocActive, hit, liveZones: live});
      expect(['voc', 'workroom', 'folder']).toContain(owner.kind);
      if (vocActive) expect(owner.kind).toBe('voc');
    }
  });

  test('drop positions map to CSS pixels under app zoom 0.9, 1.0 and 1.25 on a Retina Mac and on Windows', () => {
    // A panel element at CSS (100..500, 200..600); the user drops on CSS (300, 400).
    const css = {x: 300, y: 400};
    for (const zoom of [0.9, 1, 1.25]) {
      const viewPoints = 1000; // the window's logical width
      const mac: DropGeometry = {unit: dropPositionUnit('MacIntel'), scaleFactor: 2, logicalWidth: viewPoints, cssWidth: viewPoints / zoom};
      const atMac = dropPointToCss({x: css.x * zoom, y: css.y * zoom}, mac);
      expect(atMac.x).toBeCloseTo(css.x, 6); expect(atMac.y).toBeCloseTo(css.y, 6);
      const win: DropGeometry = {unit: dropPositionUnit('Win32'), scaleFactor: 1.5, logicalWidth: viewPoints, cssWidth: viewPoints / zoom};
      const atWin = dropPointToCss({x: css.x * zoom * 1.5, y: css.y * zoom * 1.5}, win);
      expect(atWin.x).toBeCloseTo(css.x, 6); expect(atWin.y).toBeCloseTo(css.y, 6);
    }
    expect(dropPositionUnit('MacIntel')).toBe('logical');
    expect(dropPositionUnit('Win32')).toBe('physical');
    expect(dropPositionUnit('Linux x86_64')).toBe('physical');
    // Unmeasured: physical still loses the scale factor; logical stays as is.
    expect(dropPointToCss({x: 300, y: 300}, {unit: 'physical', scaleFactor: 2, logicalWidth: 0, cssWidth: 0})).toEqual({x: 150, y: 150});
    expect(dropPointToCss({x: 300, y: 300}, {unit: 'logical', scaleFactor: 2, logicalWidth: 0, cssWidth: 0})).toEqual({x: 300, y: 300});
  });
});

