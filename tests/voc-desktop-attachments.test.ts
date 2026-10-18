import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  VOC_MAX_ATTACHMENTS, appendVocAttachments, buildVocAttachmentPayload, isVocImagePath, normalizeVocSubmitResponse,
  pathVocAttachment, planVocImageUpload, scaledSize, base64ByteLength, type VocAttachment,
} from '../src/voc/vocAttachments';
import { beginVocDropCapture, isVocDropCaptureActive } from '../src/voc/vocDropCapture';
import { VOC_WORKROOM_TITLE, buildVocWorkroomHandoff } from '../src/voc/vocWorkroomHandoff';

const overlay = readFileSync(new URL('../src/voc/VocOverlay.tsx', import.meta.url), 'utf8');
const dropZone = readFileSync(new URL('../src/FolderDropZone.tsx', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

const data = (n: number): VocAttachment => ({ kind: 'data', key: `d${n}`, name: `s${n}.png`, mime: 'image/png', dataBase64: 'AAAA', bytes: 3 });

describe('VOC 사진 첨부 — 한도', () => {
  test('최대 5장이고 넘친 개수를 알려 준다', () => {
    expect(VOC_MAX_ATTACHMENTS).toBe(5);
    const four = [1, 2, 3, 4].map(data);
    const { next, rejected } = appendVocAttachments(four, [data(5), data(6), data(7)]);
    expect(next.map(item => item.key)).toEqual(['d1', 'd2', 'd3', 'd4', 'd5']);
    expect(rejected).toBe(2);
  });

  test('같은 경로를 두 번 떨어뜨려도 한 번만 담는다', () => {
    const first = pathVocAttachment('/Users/me/Desktop/a.png');
    const { next, rejected } = appendVocAttachments([first], [pathVocAttachment('/Users/me/Desktop/a.png')]);
    expect(next).toHaveLength(1);
    expect(rejected).toBe(0);
  });

  test('Tauri 드롭 경로는 확장자로 이미지만 고른다', () => {
    expect(isVocImagePath('/a/b/Screen Shot.PNG')).toBe(true);
    expect(isVocImagePath('/a/b/c.jpeg')).toBe(true);
    expect(isVocImagePath('/a/b/c.webp')).toBe(true);
    expect(isVocImagePath('/a/b/c.gif')).toBe(false);
    expect(isVocImagePath('/a/b/project')).toBe(false);
  });
});

describe('VOC 사진 첨부 — 요청 본문', () => {
  test('브라우저 이미지는 images, 앱 드롭 경로는 imagePaths로 간다', () => {
    const payload = buildVocAttachmentPayload([data(1), pathVocAttachment('/tmp/x.jpg'), data(2)]);
    expect(payload).toEqual({
      images: [
        { dataBase64: 'AAAA', mime: 'image/png', name: 's1.png' },
        { dataBase64: 'AAAA', mime: 'image/png', name: 's2.png' },
      ],
      imagePaths: ['/tmp/x.jpg'],
    });
  });

  test('첨부가 없으면 키를 싣지 않는다 (옛 사이드카 호환)', () => {
    expect(buildVocAttachmentPayload([])).toEqual({});
    expect(buildVocAttachmentPayload([pathVocAttachment('/tmp/y.png')])).toEqual({ imagePaths: ['/tmp/y.png'] });
  });

  test('본문에는 5장을 넘겨 싣지 않는다', () => {
    const payload = buildVocAttachmentPayload([1, 2, 3, 4, 5, 6, 7].map(data));
    expect(payload.images).toHaveLength(5);
  });

  test('App의 POST /api/voc가 이 본문을 쓴다', () => {
    // 요청 본문은 App과 워크룸 팝아웃이 함께 쓰는 vocClient가 만든다.
    const client = readFileSync(new URL('../src/voc/vocClient.ts', import.meta.url), 'utf8');
    expect(app).toContain('vocClient.submit(input,');
    expect(client).toContain('...buildVocAttachmentPayload(attachments)');
    expect(client).toContain('return normalizeVocSubmitResponse(data);');
  });

  test('저장 응답에서 파일·id·첨부 경로만 꺼낸다', () => {
    expect(normalizeVocSubmitResponse({ success: true, file: 'a.json', id: 'x', attachments: ['/p/1.png', 3] }))
      .toEqual({ file: 'a.json', id: 'x', attachments: ['/p/1.png'] });
    expect(normalizeVocSubmitResponse({ success: true })).toEqual({ file: '', attachments: [] });
  });
});

describe('VOC 사진 첨부 — 크기 규칙', () => {
  const MB = 1024 * 1024;
  test('8MB 이하 PNG 스크린샷은 그대로 보낸다 (크기와 무관)', () => {
    expect(planVocImageUpload({ mime: 'image/png', bytes: 7 * MB, width: 5120, height: 2880 })).toBe('as-is');
  });
  test('8MB를 넘거나 긴 변이 2400px을 넘는 사진은 줄인다', () => {
    expect(planVocImageUpload({ mime: 'image/png', bytes: 9 * MB, width: 3000, height: 2000 })).toBe('downscale');
    expect(planVocImageUpload({ mime: 'image/jpeg', bytes: 2 * MB, width: 4032, height: 3024 })).toBe('downscale');
    expect(planVocImageUpload({ mime: 'image/jpeg', bytes: 1 * MB, width: 2400, height: 1600 })).toBe('as-is');
  });
  test('지원하지 않는 형식은 거절한다', () => {
    expect(planVocImageUpload({ mime: 'image/gif', bytes: 10, width: 1, height: 1 })).toBe('reject');
  });
  test('긴 변 2400px로 비율을 지켜 줄인다', () => {
    expect(scaledSize(4800, 1200)).toEqual({ width: 2400, height: 600 });
    expect(scaledSize(1000, 3000)).toEqual({ width: 800, height: 2400 });
    expect(scaledSize(800, 600)).toEqual({ width: 800, height: 600 });
  });
  test('base64 길이로 바이트 수를 계산한다', () => {
    expect(base64ByteLength(btoa('abcd'))).toBe(4);
    expect(base64ByteLength(btoa('abcde'))).toBe(5);
  });
});

describe('VOC 사진 첨부 — 폼 표면', () => {
  test('버튼·숨은 입력·썸네일·빼기·개수 표시가 있다', () => {
    for (const id of ['voc-attach-button', 'voc-attach-input', 'voc-attachment-thumb', 'voc-attachment-remove', 'voc-attachment-count']) {
      expect(overlay).toContain(`data-testid="${id}"`);
    }
    expect(overlay).toContain('accept={VOC_IMAGE_ACCEPT}');
    expect(overlay).toContain('사진 {attachments.length}/{VOC_MAX_ATTACHMENTS}');
  });

  test('붙여넣기는 이미지일 때만 가로챈다 — 글 붙여넣기는 그대로', () => {
    expect(overlay).toContain("if (!files.length) return; // 글 붙여넣기는 그대로 둔다");
  });

  test('앱에서는 Tauri onDragDropEvent 경로로 받고, 경로 없는 WebKit 드롭은 버린다', () => {
    expect(overlay).toContain('getCurrentWebview().onDragDropEvent(');
    expect(overlay).toContain('payload.paths.filter(isVocImagePath)');
    expect(overlay).toContain('if (isTauri()) return;');
  });
});

describe('VOC 드롭이 프로젝트 추가로 새지 않는다', () => {
  test('캡처가 켜져 있는 동안만 참이고, 해제는 한 번만 센다', () => {
    expect(isVocDropCaptureActive()).toBe(false);
    const release = beginVocDropCapture();
    expect(isVocDropCaptureActive()).toBe(true);
    release();
    release();
    expect(isVocDropCaptureActive()).toBe(false);
  });

  test('FolderDropZone의 Tauri 드롭 처리기가 VOC 캡처를 먼저 본다', () => {
    const handler = dropZone.slice(dropZone.indexOf('onDragDropEvent('));
    expect(handler.indexOf('isVocDropCaptureActive()')).toBeGreaterThan(-1);
    expect(handler.indexOf('isVocDropCaptureActive()')).toBeLessThan(handler.indexOf('acceptPaths(payload.paths)'));
    expect(overlay).toContain('useEffect(() => beginVocDropCapture(), []);');
  });
});

describe('VOC → 워크룸 인계', () => {
  test('방금 저장한 파일·내용·첨부 경로를 초점으로 한 워크룸용 프롬프트를 만든다', () => {
    const handoff = buildVocWorkroomHandoff({
      projectPath: '/projects/AgentsToZ_byCS',
      saved: { file: '2026-09-27-1010-voc-toggle.json', attachments: ['/data/voc/attachments/a-1.png'] },
      comment: '버튼이 너무 작아요',
    });
    expect(handoff.title).toBe('VOC 처리 · 실행 전 확인');
    expect(handoff.title).toBe(VOC_WORKROOM_TITLE);
    expect(handoff.prompt).toContain('2026-09-27-1010-voc-toggle.json');
    expect(handoff.prompt).toContain('버튼이 너무 작아요');
    expect(handoff.prompt).toContain('/data/voc/attachments/a-1.png');
    expect(handoff.prompt).toContain('/projects/AgentsToZ_byCS');
    // 워크룸 안에서 돈다는 사실(설치가 세션을 끝낸다)이 반영돼야 한다.
    expect(handoff.prompt).toContain('워크룸 안에서 실행 중');
  });

  test('두 워크룸 버튼이 onOpenWorkroom(title, prompt)을 부르고 오버레이를 닫는다', () => {
    expect(overlay).toContain('data-testid="voc-save-and-workroom"');
    expect(overlay).toContain('data-testid="voc-open-workroom"');
    expect(overlay).toContain('onClick={() => void submit(true)}');
    expect(overlay).toContain('onClick={() => openSavedInWorkroom(lastSaved)}');
    expect(overlay).toContain('onOpenWorkroom(handoff.title, handoff.prompt);\n    // 워크룸 탭이 이 오버레이 아래에서 열린다. 덮은 채로 두면 초안이 안 보인다.\n    onClose();');
  });

  test('App은 DEV 프로젝트의 워크룸 초안으로만 연다 (자동 실행 아님)', () => {
    expect(app).toContain('onOpenWorkroom={openVocInWorkroom}');
    expect(app).toContain('openWorkroomDraftRef.current(primaryProjectId, title, prompt);');
    expect(app).toContain('projectPath={primaryProject?.folderPath}');
  });
});
