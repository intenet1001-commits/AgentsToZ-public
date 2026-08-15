export type CodeAppAgent = 'codex' | 'claude' | 'hermes';

export interface CodeAppDeepLink {
  url: string;
  confirmationRequired: boolean;
}

export function buildCodeAppDeepLink(agent: CodeAppAgent, folderPath: string): CodeAppDeepLink {
  const encodedPath = encodeURIComponent(folderPath);
  if (agent === 'codex') {
    return {
      url: `codex://threads/new?path=${encodedPath}`,
      confirmationRequired: false,
    };
  }
  return {
    url: `claude://code/new?folder=${encodedPath}`,
    confirmationRequired: true,
  };
}
