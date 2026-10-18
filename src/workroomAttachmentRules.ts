/**
 * Workroom attachments (S3, 2026-10-16): the rules both halves share — the browser (WorkroomAttachBar) and
 * the host (src/workroomFiles.ts). No node or DOM imports: this file is also bundled into the page.
 *
 * Two kinds go into a request:
 *   - an image, saved (or copied) into <appData>/workroom-images and named by path, as before;
 *   - any other file or a folder, referenced in place by its absolute path (a Finder drop, a picker) or,
 *     when the page only has bytes (web build drop, a pasted file), saved into <appData>/workroom-files.
 * The request text then carries one path per line under a header, so every CLI can open them.
 */
export const WORKROOM_FILE_MAX_BYTES = 15 * 1024 * 1024;
/** Per request, beside the six images. More is usually the wrong folder dragged in. */
export const WORKROOM_FILE_MAX_ATTACHMENTS = 10;
export const WORKROOM_ATTACHMENT_PATH_MAX = 1024;
export const WORKROOM_FILE_NAME_MAX = 80;

export const WORKROOM_PATHLESS_DROP_MESSAGE = '경로가 없는 항목은 첨부할 수 없습니다 — 파일로 저장한 뒤 끌어 놓으세요';
export const WORKROOM_EMPTY_PASTE_MESSAGE = '붙여 넣을 수 있는 글·이미지·파일이 없습니다. 클립보드를 확인하세요.';
/** A drop on the terminal types at most this many paths (one request's images and files together). */
export const WORKROOM_TYPED_PATHS_MAX = 16;

/**
 * The attachment copy, named for the platform: ⌘V on a Mac and Ctrl+V on Windows, 「이 Mac」 or 「이 PC」.
 * `windows` comes from the page (src/clientPlatform.ts) — this file has no DOM access.
 */
export function workroomAttachCopy(windows: boolean) {
  const paste = windows ? 'Ctrl+V' : '⌘V';
  const machine = windows ? '이 PC' : '이 Mac';
  return {
    paste,
    photoTitle: `사진을 골라 이 요청에 넣습니다 · 끌어 놓기·${paste}도 됩니다`,
    fileTitle: `파일을 골라 이 요청에 넣습니다 · ${machine}에 있는 파일은 복사하지 않고 경로로 전달합니다`,
    hint: `또는 ${paste}·끌어 놓기`,
    placeholder: `${paste}·끌어 놓기 첨부`,
    composerNote: ` 넣은 사진·파일은 ${machine}의 파일 경로로 함께 전달되고, AI가 그 파일을 열어 봅니다.`,
    legacy: `${machine}의 앱이 아직 파일 첨부를 지원하지 않습니다. 앱을 업데이트하세요 — 이미지 붙여넣기와 화면 캡처는 그대로 쓸 수 있습니다.`,
  };
}
export const WORKROOM_LEGACY_ATTACH_MESSAGE = workroomAttachCopy(false).legacy;
/**
 * A Tauri drag that carried no file path: text or a link dragged from another app, or a file promise (Photos,
 * Mail). The webview cannot tell them apart, so the message covers both without assuming a file.
 */
export const WORKROOM_PATHLESS_APP_DROP_MESSAGE = '끌어 놓은 항목에 파일 경로가 없어 첨부하지 않았습니다 — 글은 입력칸에 붙여 넣고, 사진 앱·메일의 항목은 파일로 저장한 뒤 끌어 놓으세요.';
/** What an older sidecar answers to an operation it does not know (src/workroomImages.ts before S3). */
export const WORKROOM_LEGACY_IMAGE_REQUEST_ERROR = '이미지 요청이 올바르지 않습니다.';

/**
 * Characters that must never reach a request line: C0 and C1 controls (a newline would end the path line and
 * start an instruction), DEL, the Unicode line and paragraph separators, the byte-order mark, and the bidi
 * embeddings, overrides, isolates and marks that make a path read differently from what it is.
 */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/u;
const UNSAFE_ALL = new RegExp(UNSAFE.source, 'gu');
export function hasUnsafeAttachmentChars(value: string): boolean { return UNSAFE.test(value); }

/**
 * A name shown back to the person (a refused item): the last name with control and bidi characters removed —
 * an RLO left in place would reverse the rest of the message — cut to 80 code points (never half a surrogate pair).
 */
export function displayAttachmentName(path: string): string {
  const name = Array.from(attachmentBaseName(path).replace(UNSAFE_ALL, '')).slice(0, WORKROOM_FILE_NAME_MAX).join('').trim();
  return name || '이름에 제어·방향 문자가 있는 항목';
}

/**
 * Attachments name files on this machine by path. Another AgentsToZ would open whatever sits at the same path
 * there — with the same home and project layout, a different file — so a route there is refused while the
 * draft has any. A route on this machine (a project here, or a desktop app here) keeps them.
 */
export function workroomRouteAttachmentRefusal(attachments: readonly unknown[], options: {crossDevice: boolean; machine: string}): string | null {
  if (!options.crossDevice || !attachments.length) return null;
  return `첨부한 사진·파일은 ${options.machine}에만 있어 다른 아젠투지로 보낼 수 없습니다 — 첨부를 빼거나 ${options.machine}의 프로젝트로 보내세요.`;
}

/** POSIX absolute, a Windows drive path (`C:\`, `C:/` — never the drive-relative `C:work`), or a UNC share. */
export function isAbsoluteAttachmentPath(path: string): boolean {
  return /^\//.test(path) || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(path);
}

/** The last name of a POSIX or Windows path; a trailing separator (a folder) is ignored. */
export function attachmentBaseName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** A path the host may name in a request: absolute, bounded, and free of control and bidi characters. */
export function attachmentPathProblem(path: unknown): string | null {
  if (typeof path !== 'string' || !path) return '경로가 비어 있습니다.';
  if (path.length > WORKROOM_ATTACHMENT_PATH_MAX) return '경로가 너무 깁니다.';
  if (hasUnsafeAttachmentChars(path)) return '이름에 줄바꿈·제어·방향 문자가 들어 있는 파일은 첨부할 수 없습니다. 파일 이름을 바꾼 뒤 다시 넣어 주세요.';
  if (!isAbsoluteAttachmentPath(path)) return '절대 경로가 아닙니다.';
  return null;
}

/**
 * A file name the host writes under <appData>/workroom-files: the last name only (no `../`), control and bidi
 * characters removed, no leading dot or dash, at most WORKROOM_FILE_NAME_MAX characters keeping a short extension.
 */
export function sanitizeWorkroomFileName(name: unknown): string {
  let base = attachmentBaseName(typeof name === 'string' ? name.normalize('NFC') : '');
  base = base.replace(UNSAFE_ALL, '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().replace(/^[.\-\s]+/, '');
  if (!base || base === '.' || base === '..') return 'file';
  const chars = Array.from(base);
  if (chars.length <= WORKROOM_FILE_NAME_MAX) return base;
  const dot = base.lastIndexOf('.');
  const extension = dot > 0 && base.length - dot <= 16 ? base.slice(dot) : '';
  const stem = Array.from(extension ? base.slice(0, dot) : base).slice(0, WORKROOM_FILE_NAME_MAX - Array.from(extension).length).join('');
  return (stem.replace(/[.\s]+$/, '') || 'file') + extension;
}

/**
 * One shell word. POSIX: `'…'`, each `'` written as `'\''`. Windows (PowerShell, cmd): `"…"` — a Windows file
 * name cannot contain `"`, and `'` is ordinary text there.
 */
export function shellQuoteAttachmentPath(path: string, windows = false): string {
  return windows ? `"${path}"` : `'${path.replace(/'/g, `'\\''`)}'`;
}

/** What a drop on the terminal types: the quoted paths, space separated, with a trailing space and no Enter. */
export function workroomTypedPathsText(paths: readonly string[], windows = false): string {
  return paths.map(path => shellQuoteAttachmentPath(path, windows)).join(' ') + ' ';
}

/** The image formats the host recognises by bytes; anything else attaches as a file. */
export function isWorkroomImageMime(type: string | undefined | null): boolean {
  return /^image\/(png|jpeg|gif|webp|heic|heif)$/.test(type ?? '');
}

export interface WorkroomAttachmentLike {path: string; name: string; kind?: 'image' | 'file'}
export function attachmentKind(item: {kind?: 'image' | 'file'}): 'image' | 'file' { return item.kind === 'file' ? 'file' : 'image'; }

/**
 * Adds attachments within the per-request limits (images 6, files 10), once per path. What does not fit is
 * returned by name so the composer can say so instead of dropping it silently.
 */
export function addWorkroomAttachments<T extends WorkroomAttachmentLike>(current: readonly T[], incoming: readonly T[], limits: {images: number; files: number}): {next: T[]; refused: string[]} {
  const next = [...current];
  const refused: string[] = [];
  for (const item of incoming) {
    if (next.some(existing => existing.path === item.path)) continue;
    const kind = attachmentKind(item);
    const count = next.filter(existing => attachmentKind(existing) === kind).length;
    if (count >= (kind === 'image' ? limits.images : limits.files)) { refused.push(item.name); continue; }
    next.push(item);
  }
  return {next, refused};
}

export function attachmentLimitMessage(refused: readonly string[], limits: {images: number; files: number}): string | null {
  if (!refused.length) return null;
  const names = refused.slice(0, 3).join(', ') + (refused.length > 3 ? ` 외 ${refused.length - 3}개` : '');
  return `한 요청에 이미지는 ${limits.images}개, 파일은 ${limits.files}개까지 넣을 수 있습니다. 넣지 못한 항목: ${names}`;
}
