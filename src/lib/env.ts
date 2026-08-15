/** 실행 환경 감지 유틸 — App.tsx / PortalManager.tsx / SetupWizard.tsx 공용 */

/** Tauri 데스크톱 앱 내부에서 실행 중인가 */
export function isTauri(): boolean {
  if (typeof window === 'undefined') return false;
  return '__TAURI__' in window || '__TAURI_INTERNALS__' in window;
}

/** Vercel 등 원격에 배포된 웹(파일시스템 없음)인가.
 *  localhost/127.0.0.1/0.0.0.0 은 로컬 개발로 간주. */
export function isDeployedWeb(): boolean {
  if (typeof window === 'undefined') return false;
  if (isTauri()) return false;
  const host = window.location.hostname;
  return !['localhost', '127.0.0.1', '0.0.0.0', ''].includes(host);
}

/** 로컬 개발 웹(Vite dev) 모드인가 — filesystem API 가능 */
export function isLocalWeb(): boolean {
  return !isTauri() && !isDeployedWeb();
}
