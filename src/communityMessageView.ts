/**
 * How a 단톡방 message reads at a glance — the Mac panel and the phone show it the same way (2026-10-25).
 *
 * AIs post operational records into the room: build receipts carrying commit hashes, fingerprints and request UUIDs as
 * evidence for other AIs. Shown whole, one of those was a wall of identifiers (VOC 2026-10-25 「여긴 텍스트가 왜
 * 이렇게 지저분하게 많지」). The room now shows a short preview with each identifier cut to its first 8 characters;
 * 「전체 보기」 shows the original unchanged, so nothing is lost and copying still gets the full text.
 */
const PREVIEW_CHARS = 160;
/** Commit SHAs, fingerprints and UUIDs. Twenty hex digits is longer than any word or number a person writes. */
const MACHINE_ID = /\b(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{20,})\b/gi;

/** A label for the kinds people should read differently; ordinary questions and answers get none. */
export const COMMUNITY_KIND_LABEL: Readonly<Record<string, string>> = {'build-receipt': '빌드 기록'};

export interface CommunityMessagePreview {
  preview: string;
  /** The preview differs from the text: offer 「전체 보기」. */
  folded: boolean;
}

export function communityMessagePreview(text: string): CommunityMessagePreview {
  const short = text.replace(MACHINE_ID, id => `${id.slice(0, 8)}…`);
  if (short.length <= PREVIEW_CHARS) return {preview: short, folded: short !== text};
  const head = short.slice(0, PREVIEW_CHARS);
  // End on a sentence when one ends far enough in, otherwise on a space, so no word is cut in half.
  const sentence = Math.max(...[...head.matchAll(/[.!?。](?=\s)/g)].map(match => match.index! + 1), -1);
  const space = head.lastIndexOf(' ');
  const end = sentence >= PREVIEW_CHARS * 0.4 ? sentence : space >= PREVIEW_CHARS * 0.6 ? space : PREVIEW_CHARS;
  return {preview: `${head.slice(0, end).trimEnd()} …`, folded: true};
}
