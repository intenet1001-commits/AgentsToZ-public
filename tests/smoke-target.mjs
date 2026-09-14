export function classifySmokeTarget(target) {
  const targetUrl = new URL(target);
  const hostname = targetUrl.hostname.replace(/^\[|\]$/g, '');
  const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(hostname);
  const isPortalEntry = /\/(?:portal|setup)\.html$/i.test(targetUrl.pathname);
  const isLocalFullApp = isLoopback && !isPortalEntry;
  return { isLocalFullApp, isPortalOnly: !isLocalFullApp };
}
