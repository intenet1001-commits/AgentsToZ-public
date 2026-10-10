import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readPendingVocFileNoFollow, safePendingVocFile } from './vocFileAccess.server';
import { buildRemoteVocInbox, type RemoteVocInbox } from './vocInboxSummary';

/**
 * 이 Mac의 미처리 VOC(= `voc/` 최상위 JSON)를 최신순으로 읽는다. `GET /api/voc`와 같은 규칙:
 * 이름 검사 + 폴더 바로 아래인지 확인 + 심볼릭 링크를 따라가지 않는 읽기. 못 읽는 파일은
 * `unreadable`로 남긴다(목록에서 사라지게 두면 쌓인 개수가 거짓이 된다).
 */
export function readPendingVocRecords(appDataDir: string): Record<string, unknown>[] {
  const dir = join(appDataDir, 'voc');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(name => name.endsWith('.json'))
    .sort()
    .reverse()
    .map(name => {
      try {
        const file = safePendingVocFile(appDataDir, name);
        if (!file) return { file: name, unreadable: true };
        const record = JSON.parse(readPendingVocFileNoFollow(file));
        return record && typeof record === 'object' && !Array.isArray(record) ? { ...record, file: name } : { file: name, unreadable: true };
      } catch {
        return { file: name, unreadable: true };
      }
    });
}

/** 휴대폰의 「쌓인 VOC」 응답. 요약만 — 절대경로·사진 바이트는 싣지 않는다. */
export function remoteVocInboxSnapshot(appDataDir: string): RemoteVocInbox {
  return buildRemoteVocInbox(readPendingVocRecords(appDataDir));
}
