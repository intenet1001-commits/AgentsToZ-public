import {appendFileSync, existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

// Exercise the real profile/MCP/action dispatcher. Only downstream OS-app
// adapters are intercepted; never launch personal apps from an isolated HOME.
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input.url ?? input.href);
  if (url.origin === `http://127.0.0.1:${process.env.API_PORT}`
    && ['/api/open-code-app', '/api/open-orca-agent'].includes(url.pathname)) {
    const body = JSON.parse(String(init?.body));
    appendFileSync(join(process.env.HOME!, 'surface-launches.jsonl'), JSON.stringify({path: url.pathname, body}) + '\n');
    const override = join(process.env.HOME!, 'surface-result.json');
    if (existsSync(override)) {
      const result = JSON.parse(readFileSync(override, 'utf8'));
      return Response.json(result.body, {status: result.status});
    }
    return Response.json(url.pathname === '/api/open-orca-agent'
      ? {success: true, orcaSurface: 'floating', reused: true,
        fallbackNotice: body.floating ? null : `selector_not_found: ${body.folderPath} → Floating`,
        revealWarning: 'Orca 창에서 해당 탭을 직접 확인하세요.'}
      : {success: true, mode: body.mode === 'prepare' ? 'prepared' : 'reopened',
        projectConfirmed: true, deliveryRequested: body.mode === 'prepare', selectionVerified: false});
  }
  return originalFetch(input, init);
}) as typeof fetch;
await import('./agentstoz-use-api');
