import { normalizeSearchText } from './searchText';

export interface ProjectSearchable {
  name?: string;
  aiName?: string;
  description?: string;
  category?: string;
  port?: number;
  worktreePath?: string;
  folderPath?: string;
  commandPath?: string;
  terminalCommand?: string;
  manualPath?: string;
  logFilePath?: string;
  deployUrl?: string;
  githubUrl?: string;
  githubUrls?: string[];
  memo?: string;
}

export function matchesProjectSearch(project: ProjectSearchable, rawQuery: string): boolean {
  const query = normalizeSearchText(rawQuery.trim());
  if (!query) return true;

  const fields: Array<string | number | undefined> = [
    project.name,
    project.aiName,
    project.description,
    project.category,
    project.port,
    project.worktreePath,
    project.folderPath,
    project.commandPath,
    project.terminalCommand,
    project.manualPath,
    project.logFilePath,
    project.deployUrl,
    project.githubUrl,
    ...(project.githubUrls ?? []),
    project.memo,
  ];

  return fields.some(value => value != null
    && normalizeSearchText(String(value)).includes(query));
}
