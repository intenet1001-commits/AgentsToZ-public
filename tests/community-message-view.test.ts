import {expect, test} from 'bun:test';
import {COMMUNITY_KIND_LABEL, communityMessagePreview} from '../src/communityMessageView';

// The build receipt from the VOC screenshot (2026-10-25), as an AI posted it.
const receipt = '사용자 승인 handoff b91311bd-6ff0-4db7-921b-a14fa7516286의 최종 소스가 d284a5cb663b3187c9cd87d802fb60cfd2715ba6 / 공식 앱749.0.0로 갱신됐습니다. '
  + '1호 실제 749 설치·MCP1.35.0+build.749/84 tools/OPS ready를 확인했고 TS0, Bun6109pass/10skip/0fail, Rust73pass, quick5/5 통과했습니다. '
  + '공개snapshot f304b334f8e09a51b17b27cd9bf13830937b7b00. 3호 Workroom의 현재 Codex에 같은749 안전 업데이트와 NHCS d14813cf-a25d-48fb-8c35-03b85261b25e의 기존 정본 연결을 실제 지시했습니다.';

test('a short message from a person reads exactly as written', () => {
  for (const text of ['빌드 로그 확인했나요?', '612 올렸습니다. v1263 설치 완료', 'deadbeef 커밋 봐 주세요']) {
    expect(communityMessagePreview(text)).toEqual({preview: text, folded: false});
  }
});

test('a build receipt previews as its first sentence, with identifiers cut to 8 characters', () => {
  const {preview, folded} = communityMessagePreview(receipt);
  expect(folded).toBe(true);
  expect(preview).toBe('사용자 승인 handoff b91311bd…의 최종 소스가 d284a5cb… / 공식 앱749.0.0로 갱신됐습니다. …');
  expect(preview.length).toBeLessThanOrEqual(162);
});

test('identifiers alone fold a short message, and ordinary numbers and short hex stay', () => {
  expect(communityMessagePreview('정본 d284a5cb663b3187c9cd87d802fb60cfd2715ba6 확인')).toEqual({preview: '정본 d284a5cb… 확인', folded: true});
  expect(communityMessagePreview('Bun 6109 pass, 커밋 3cd532b7, 1234567890123456789')).toEqual({preview: 'Bun 6109 pass, 커밋 3cd532b7, 1234567890123456789', folded: false});
});

test('a long message without sentence ends is cut on a space, never mid-word', () => {
  const words = Array.from({length: 60}, (_, i) => `단어${i}`).join(' ');
  const {preview} = communityMessagePreview(words);
  expect(preview.endsWith(' …')).toBe(true);
  expect(words.startsWith(preview.slice(0, -2))).toBe(true);
  expect(words.charAt(preview.length - 2)).toBe(' ');
});

test('only build receipts carry a kind label', () => {
  expect(COMMUNITY_KIND_LABEL['build-receipt']).toBe('빌드 기록');
  expect(COMMUNITY_KIND_LABEL.question).toBeUndefined();
});
