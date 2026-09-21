export type CodeAppAgent = 'codex' | 'claude' | 'hermes';

export interface CodeAppDeepLink {
  url: string;
  confirmationRequired: boolean;
}

/** Claude is intentionally absent here. Claude Desktop's folder-shaped Code
 * link is not a Claude Code project contract;
 * the app can accept the URL while discarding the folder. Claude projects use
 * Claude Code's verified `remote-control` session flow instead. */
export function buildCodeAppDeepLink(
  agent: 'codex',
  folderPath: string,
  options: { prompt?: string } = {},
): CodeAppDeepLink {
  const encodedPath = encodeURIComponent(folderPath);
  const encodedPrompt = options.prompt === undefined
    ? ''
    : `&prompt=${encodeURIComponent(options.prompt)}`;
  return {
    url: `codex://threads/new?path=${encodedPath}${encodedPrompt}`,
    confirmationRequired: false,
  };
}
