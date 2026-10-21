import {WORKROOM_FILE_MAX_BYTES} from './workroomAttachmentRules';
import type {WorkroomImageAttachment} from './workroomImageAttachments';
import {WorkroomAttachmentError, importWorkroomAttachmentPaths, saveWorkroomFile, typeWorkroomDroppedPaths, type WorkroomPathTypingTerminal} from './workroomFiles';
import {handleWorkroomImageRequest, type WorkroomImageHost} from './workroomImages';

/**
 * POST /api/agent-runtime/terminals/images — the management-only route the composer already used for images.
 * The image operations (`save`, `capture`) are unchanged; S3 adds three:
 *   `save-file`  {data, name}         bytes without a path → <appData>/workroom-files
 *   `import`     {paths}               paths this Mac has → image copies or file references
 *   `type-paths` {sessionId, targetId, paths} a drop on the terminal in direct input mode
 * An older sidecar answers the new operations with its legacy "이미지 요청이 올바르지 않습니다." — the client turns
 * that into an update notice (src/workroomAttachmentClient.ts).
 */
export interface WorkroomAttachmentHost extends WorkroomImageHost {
  terminal?: WorkroomPathTypingTerminal;
  awaitsAnswer?: (rows: readonly string[]) => boolean;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const exactKeys = (r: Record<string, unknown>, keys: readonly string[]) => Object.keys(r).every(key => keys.includes(key));

export async function handleWorkroomAttachmentRequest(host: WorkroomAttachmentHost, body: unknown): Promise<WorkroomImageAttachment | {cancelled: true} | {attachments: WorkroomImageAttachment[]; refused: {name: string; reason: string}[]} | {typed: number}> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new WorkroomAttachmentError('WORKROOM_ATTACHMENT_REQUEST_INVALID', '첨부 요청이 올바르지 않습니다.');
  const r = body as Record<string, unknown>;
  if (r.operation === 'save-file' && exactKeys(r, ['operation', 'data', 'name'])) {
    if (typeof r.data !== 'string' || !BASE64.test(r.data) || r.data.length > Math.ceil(WORKROOM_FILE_MAX_BYTES / 3) * 4) {
      throw new WorkroomAttachmentError('WORKROOM_FILE_TOO_LARGE', '경로 없이 넣는 파일은 15MB 이하만 됩니다. 더 큰 파일은 Finder에서 끌어 놓거나 「파일 첨부」로 고르세요.');
    }
    return saveWorkroomFile(host.appDataDir, Buffer.from(r.data, 'base64'), r.name, host.now?.());
  }
  if (r.operation === 'import' && exactKeys(r, ['operation', 'paths'])) return importWorkroomAttachmentPaths(host, r.paths);
  if (r.operation === 'type-paths' && exactKeys(r, ['operation', 'sessionId', 'targetId', 'paths'])) {
    if (typeof r.sessionId !== 'string' || typeof r.targetId !== 'string' || !host.terminal || !host.awaitsAnswer) {
      throw new WorkroomAttachmentError('WORKROOM_ATTACHMENT_REQUEST_INVALID', '경로를 입력할 터미널을 찾지 못했습니다.');
    }
    return typeWorkroomDroppedPaths(host.terminal, host.awaitsAnswer, {sessionId: r.sessionId, targetId: r.targetId, paths: r.paths});
  }
  return handleWorkroomImageRequest(host, body);
}
