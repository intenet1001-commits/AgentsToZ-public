import { buildClientErrorReport } from '../clientErrorReport';

/** The public product tracker; no user text, local path or credentials in its URL. */
export const DEVELOPER_ERROR_REPORT_URL = 'https://github.com/intenet1001-commits/AgentsToZ-public/issues/new';

export function buildDeveloperErrorReport(input: { comment: string; tab: string; appVersion: string }): string {
  const report = buildClientErrorReport({ code: 'USER_REPORTED', message: input.comment, detail: input.tab, appVersion: input.appVersion });
  // appVersion is normally trusted build metadata; scrub it as free text too for a safe preview.
  const version = buildClientErrorReport({ code: 'VERSION', message: input.appVersion }).message;
  return `AgentsToZ 오류 신고\n\n앱 버전: ${version}\n화면: ${report.detail ?? '확인 필요'}\n\n문제 설명:\n${report.message}\n\n재현 순서:\n1. \n\n기대한 동작:\n\n실제 동작:\n`;
}
