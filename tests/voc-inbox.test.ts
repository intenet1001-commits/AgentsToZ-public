import { describe, expect, test } from 'bun:test';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeVocInbox,
  isPendingVocFileName,
} from '../src/vocFileAccess';
import {
  readPendingVocFileNoFollow,
  safePendingVocFile,
  writePendingVocFileAtomic,
} from '../src/vocFileAccess.server';
import { describeVocAnchor, normalizeVocAnchor } from '../src/vocAnchor';

const overlaySource = readFileSync(new URL('../src/voc/VocOverlay.tsx', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
const sharedFileAccessSource = readFileSync(new URL('../src/vocFileAccess.ts', import.meta.url), 'utf8');

const describe1 = (anchor: unknown) => describeVocAnchor(normalizeVocAnchor(anchor));

describe('VOC 2026-09-01 15:39 — 남긴 개선 요청을 그 자리에서 보고 고친다', () => {
  test('파일 이름은 voc 폴더 바로 아래의 .json 한 건만 가리킨다', () => {
    expect(isPendingVocFileName('2026-09-01-1539-영역-top-level.json')).toBe(true);
    // 한글 앵커를 그대로 쓰므로 ASCII 로 좁히면 실제 파일을 못 집는다.
    expect(isPendingVocFileName('2026-08-27-1101-새-프로필-이름.json')).toBe(true);

    // 경로가 될 수 있는 것은 전부 막는다 — 이 값으로 파일을 지운다.
    expect(isPendingVocFileName('../portal.json')).toBe(false);
    expect(isPendingVocFileName('done/2026-09-01-1539-x.json')).toBe(false);
    expect(isPendingVocFileName('..\\ports.json')).toBe(false);
    expect(isPendingVocFileName('a\0b.json')).toBe(false);
    expect(isPendingVocFileName('.hidden.json')).toBe(false);
    expect(isPendingVocFileName('notes.txt')).toBe(false);
    expect(isPendingVocFileName('')).toBe(false);
    expect(isPendingVocFileName('   ')).toBe(false);
    expect(isPendingVocFileName(null)).toBe(false);
    expect(isPendingVocFileName(`${'x'.repeat(200)}.json`)).toBe(false);
  });

  test('목록은 읽을 수 없는 파일도 버리지 않는다 — 감추면 폴더에 남아 계속 걸린다', () => {
    const items = normalizeVocInbox({
      items: [
        {
          file: '2026-09-01-1539-영역-a.json',
          id: 'one',
          createdAt: '2026-09-01T06:39:13.550Z',
          comment: '우측 하단에 쌓인 목록이 있으면 좋겠다',
          tab: 'what-i-said',
          appVersion: 'v347',
          anchor: { testId: 'what-i-said-panel', tag: 'section', text: '', path: [] },
        },
        { file: '2026-08-30-1200-broken.json', unreadable: true },
        // 폴더 밖을 가리키는 이름은 목록에서도 만들지 않는다.
        { file: '../portal.json', id: 'bad', comment: 'x' },
      ],
    }, describe1);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      file: '2026-09-01-1539-영역-a.json',
      comment: '우측 하단에 쌓인 목록이 있으면 좋겠다',
      anchorLabel: 'what-i-said-panel',
      unreadable: false,
    });
    expect(items[1]).toMatchObject({ file: '2026-08-30-1200-broken.json', unreadable: true, anchorLabel: '' });
  });

  test('응답이 목록 모양이 아니면 빈 목록이다 — 상자가 고장으로 보이면 안 된다', () => {
    expect(normalizeVocInbox(null, describe1)).toEqual([]);
    expect(normalizeVocInbox({ items: 'nope' }, describe1)).toEqual([]);
    expect(normalizeVocInbox({ items: [null, 3, 'x'] }, describe1)).toEqual([]);
  });

  test('서버는 이름 검사와 결합된 경로를 둘 다 확인한 뒤에야 파일에 손댄다', () => {
    const block = apiSource.slice(
      apiSource.indexOf('if (url.pathname === "/api/voc" && (req.method === "PATCH" || req.method === "DELETE"))'),
      apiSource.indexOf('// 공개 VOC 수집 설정은 receiver 프로젝트의'),
    );
    expect(block).toContain('isPendingVocFileName(body.file)');
    expect(block).toContain('dirname(lexicalFile) !== resolve(dir)');
    // 이름 검사 → 경로 확인 → 그 다음에야 삭제. 순서가 뒤집히면 검사가 무의미하다.
    expect(block.indexOf('isPendingVocFileName')).toBeLessThan(block.indexOf('unlinkSync(file)'));
    expect(block.indexOf('dirname(lexicalFile) !== resolve(dir)')).toBeLessThan(block.indexOf('unlinkSync(file)'));
    expect(block).toContain('safePendingVocFile(APP_DATA_DIR, body.file.trim())');
    expect(block).toContain('readPendingVocFileNoFollow(file)');
    expect(block).toContain('writePendingVocFileAtomic(file,');
    // 내용을 못 읽는 파일을 고쳐 쓰면 앵커와 전송 결과가 통째로 날아간다.
    expect(block).toContain('이 파일은 내용을 읽을 수 없어 수정할 수 없습니다.');
    // 파일 이름은 시간+앵커로 만들어지므로 내용을 고쳐도 바뀌지 않는다.
    expect(block).not.toContain('vocFileName(');
    expect(block).toContain('const updated = { ...record, comment, updatedAt:');
  });

  test('실제 파일 가드는 symlink·directory symlink·hard link를 거부하고 정상 JSON만 원자 교체한다', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentstoz-voc-file-guard-'));
    try {
      const appData = join(root, 'app-data');
      const voc = join(appData, 'voc');
      mkdirSync(voc, { recursive: true });
      const normal = join(voc, 'normal.json');
      writeFileSync(normal, '{"comment":"before"}\n');
      expect(safePendingVocFile(appData, 'normal.json')).toBe(normal);
      expect(readPendingVocFileNoFollow(normal)).toContain('before');
      writePendingVocFileAtomic(normal, '{"comment":"after"}\n');
      expect(readFileSync(normal, 'utf8')).toContain('after');

      const outside = join(root, 'outside.json');
      writeFileSync(outside, '{"secret":"unchanged"}\n');
      symlinkSync(outside, join(voc, 'link.json'));
      expect(() => safePendingVocFile(appData, 'link.json')).toThrow('VOC_PATH_UNSAFE');
      expect(readFileSync(outside, 'utf8')).toContain('unchanged');

      linkSync(outside, join(voc, 'hard.json'));
      expect(() => safePendingVocFile(appData, 'hard.json')).toThrow('VOC_PATH_UNSAFE');

      const linkedAppData = join(root, 'linked-app-data');
      const outsideVoc = join(root, 'outside-voc');
      mkdirSync(linkedAppData);
      mkdirSync(outsideVoc);
      writeFileSync(join(outsideVoc, 'dir-link.json'), '{}\n');
      symlinkSync(outsideVoc, join(linkedAppData, 'voc'));
      expect(() => safePendingVocFile(linkedAppData, 'dir-link.json')).toThrow('VOC_PATH_UNSAFE');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('브라우저 공유 모듈은 node builtins 없이 유지하고 서버만 filesystem guard를 import한다', () => {
    expect(sharedFileAccessSource).not.toContain("from 'node:");
    expect(apiSource).toContain('from "./src/vocFileAccess.server"');
    expect(apiSource).toContain('from "./src/vocFileAccess"');
  });

  test('상자는 선택용 오버레이보다 위에 있다 — 같은 층이면 클릭이 오버레이로 내려간다', () => {
    expect(overlaySource).toContain('data-testid="voc-inbox-toggle"');
    expect(overlaySource).toContain('data-testid="voc-inbox-panel"');
    expect(overlaySource).toContain('data-testid="voc-inbox-count"');
    const toggleBlock = overlaySource.slice(overlaySource.indexOf("position: 'fixed', right: 16, bottom: 16"));
    expect(toggleBlock).toContain('zIndex: GUIDE_Z.tooltip');
    expect(overlaySource).not.toContain("bottom: 16, zIndex: GUIDE_Z.overlay");
  });

  test('목록에서 고치고 지울 수 있고, 삭제는 한 번 더 묻는다', () => {
    expect(overlaySource).toContain('data-testid="voc-inbox-edit"');
    expect(overlaySource).toContain('data-testid="voc-inbox-edit-save"');
    expect(overlaySource).toContain('data-testid="voc-inbox-edit-cancel"');
    expect(overlaySource).toContain('data-testid="voc-inbox-delete"');
    expect(overlaySource).toContain('data-testid="voc-inbox-delete-confirm"');
    expect(overlaySource).toContain('data-testid="voc-inbox-delete-cancel"');
    // 되돌릴 수 없는 동작이라 곧바로 지우지 않는다.
    expect(overlaySource).toContain('onClick={() => setConfirmDeleteFile(item.file)}');
    // 수정 실패는 편집 상태를 유지한다 — 고쳐 쓴 글을 잃는 것이 가장 나쁜 실패다.
    expect(overlaySource).toContain('if (!ok) return;\n    setEditingFile(null);');
  });

  test('375px에서도 모든 inbox 동작은 최소 44px 터치 타깃이고 행은 줄바꿈할 수 있다', () => {
    for (const testId of [
      'voc-inbox-close',
      'voc-inbox-edit-save',
      'voc-inbox-edit-cancel',
      'voc-inbox-edit',
      'voc-inbox-delete',
      'voc-inbox-delete-confirm',
      'voc-inbox-delete-cancel',
      'voc-inbox-toggle',
    ]) expect(overlaySource).toContain(`data-testid="${testId}"`);
    expect((overlaySource.match(/minHeight: 44/g) ?? []).length).toBeGreaterThanOrEqual(8);
    expect(overlaySource).toContain("display: 'flex', flexWrap: 'wrap', gap: 6");
    expect(overlaySource).toContain("width: 'min(380px, calc(100vw - 32px))'");
  });

  test('Esc 는 바깥부터 하나씩 닫는다', () => {
    expect(overlaySource).toContain('if (inboxOpen) setInboxOpen(false);\n        else if (picked) repick();\n        else onClose();');
  });

  test('목록을 못 읽어도 개선 요청 남기기 자체는 막히지 않는다', () => {
    expect(overlaySource).toContain('setInbox(current => current ?? []);');
    expect(overlaySource).toContain('data-testid="voc-inbox-error"');
  });

  test('앱은 세 동작을 모두 넘겨준다', () => {
    expect(appSource).toContain('onLoadInbox={loadVocInbox}');
    expect(appSource).toContain('onUpdateInboxItem={updateVoc}');
    expect(appSource).toContain('onDeleteInboxItem={deleteVoc}');
    expect(appSource).toContain("method: 'PATCH',");
    expect(appSource).toContain("method: 'DELETE',");
  });
});
