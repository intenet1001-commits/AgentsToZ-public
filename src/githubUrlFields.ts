/**
 * Row model for the per-repository GitHub editors.
 *
 * The stored value is a newline-joined list that drops blank entries, so an empty
 * row exists only in the editor. Deriving rows from the stored value on every
 * render therefore erases the row the "+ GitHub 주소 추가" button just added —
 * the editors keep the rows in their own state and use these helpers to decide
 * when an incoming value should replace them.
 */
import { parseGitHubRepositoryUrls } from './githubUrls';

/**
 * Rows for a newline-joined editor value; always at least one so the field stays
 * visible. The value is parsed as text — passing it through the record helpers
 * treats the whole multi-line string as a single repository.
 */
export const githubRepositoryUrlRows = (value: string): string[] => {
  const urls = parseGitHubRepositoryUrls(value);
  return urls.length > 0 ? urls : [''];
};

/** Appends a blank row to type the next repository into. */
export const appendBlankGitHubRepositoryUrlRow = (rows: readonly string[]): string[] => [...rows, ''];

export const removeGitHubRepositoryUrlRow = (rows: readonly string[], index: number): string[] =>
  rows.length <= 1 ? [...rows] : rows.filter((_, rowIndex) => rowIndex !== index);

export const replaceGitHubRepositoryUrlRow = (rows: readonly string[], index: number, next: string): string[] =>
  rows.map((row, rowIndex) => (rowIndex === index ? next : row));

/** The value written back to the form for a set of rows. */
export const githubRepositoryUrlRowsText = (rows: readonly string[]): string => rows.join('\n');

/**
 * True when the incoming value carries repositories the rows do not already
 * express — an auto-detected remote or a form reset. Blank rows and values that
 * only differ by normalization are not adoption reasons, so typing and adding
 * rows are never interrupted.
 */
export const shouldAdoptGitHubRepositoryUrlValue = (value: string, rows: readonly string[]): boolean =>
  parseGitHubRepositoryUrls(value).join('\n')
    !== parseGitHubRepositoryUrls(githubRepositoryUrlRowsText(rows)).join('\n');
