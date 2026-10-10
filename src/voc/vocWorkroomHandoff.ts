import { buildVocWorkflowPrompt } from '../vocWorkflowPrompt';
import type { VocSubmitResult } from './vocAttachments';

/** 워크룸 초안의 제목. 「규격 명령 → 워크룸에서 실행」과 같은 꼬리말을 쓴다. */
export const VOC_WORKROOM_TITLE = 'VOC 처리 · 실행 전 확인';

/**
 * 방금 저장한 개선 요청 하나를 출발점으로 하는 VOC 처리 초안.
 * 워크룸에는 **초안으로만** 채운다 — 실행은 사용자가 「선택한 AI로 시작」을 눌러야 한다.
 */
export function buildVocWorkroomHandoff(input: { projectPath?: string; saved: VocSubmitResult; comment: string }): { title: string; prompt: string } {
  return {
    title: VOC_WORKROOM_TITLE,
    prompt: buildVocWorkflowPrompt({
      projectPath: input.projectPath,
      runsInWorkroom: true,
      focusVoc: { file: input.saved.file, comment: input.comment, attachmentPaths: input.saved.attachments },
    }),
  };
}

/**
 * 쌓인 VOC 전체를 처리하는 초안. 특정 VOC를 지목하지 않으므로 프롬프트가 `GET /api/voc`(미처리 전체)와
 * `GET /api/client-errors`(휴대폰 오류 보고)를 읽어 최신순으로 다룬다. 실행은 사용자가 누를 때만.
 */
export function buildVocInboxWorkroomHandoff(input: { projectPath?: string } = {}): { title: string; prompt: string } {
  return { title: VOC_WORKROOM_TITLE, prompt: buildVocWorkflowPrompt({ projectPath: input.projectPath, runsInWorkroom: true }) };
}

/**
 * 쌓인 목록에서 고른 VOC 한 건의 초안. 목록은 요약만 갖고 있을 수 있으므로(휴대폰) 사진 경로 대신
 * 개수만 넘기면 AI가 `GET /api/voc`에서 경로와 전체 내용을 읽는다.
 */
export function buildVocItemWorkroomHandoff(input: {
  projectPath?: string;
  file: string;
  comment: string;
  source?: string;
  photoCount?: number;
  attachmentPaths?: readonly string[];
  commentIsSummary?: boolean;
}): { title: string; prompt: string } {
  return {
    title: VOC_WORKROOM_TITLE,
    prompt: buildVocWorkflowPrompt({
      projectPath: input.projectPath,
      runsInWorkroom: true,
      focusVoc: {
        file: input.file,
        comment: input.comment,
        ...(input.source ? { source: input.source } : {}),
        ...(input.attachmentPaths?.length ? { attachmentPaths: input.attachmentPaths } : {}),
        ...(input.photoCount ? { photoCount: input.photoCount } : {}),
        ...(input.commentIsSummary ? { commentIsSummary: true } : {}),
      },
    }),
  };
}
