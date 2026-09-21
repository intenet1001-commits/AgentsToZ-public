import { isLocalWeb } from './lib/env';

export function resolvePortalOAuthRedirect(
  origin: string,
  pathname: string,
  localWeb: boolean,
): string {
  const targetPath = localWeb && pathname.startsWith('/') ? pathname : '/';
  return new URL(targetPath, origin).toString();
}

/** Preserve /portal.html in source development; hosted portal auth returns to root. */
export function portalOAuthRedirectUrl(): string {
  return resolvePortalOAuthRedirect(window.location.origin, window.location.pathname, isLocalWeb());
}
