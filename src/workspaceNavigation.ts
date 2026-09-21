export type WorkspaceTab = 'home' | 'projects' | 'workroom' | 'bookmarks' | 'records';
export function initialWorkspaceTab(search: string): WorkspaceTab {
  const tab = new URLSearchParams(search).get('tab');
  if (tab === 'remote') return 'workroom';
  if (tab === 'ports' || tab === 'projects') return 'projects';
  if (tab === 'memories' || tab === 'said' || tab === 'records') return 'records';
  if (tab === 'bookmarks' || tab === 'workroom') return tab;
  return 'home';
}
export function isWorkspaceTab(value: unknown): value is WorkspaceTab {
  return ['home', 'projects', 'workroom', 'bookmarks', 'records'].includes(value as string);
}
