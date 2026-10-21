import { matchesSearchText } from './searchText';
import { matchesPhoneticName } from './phoneticSearch';
import { projectCode } from './projectCode';

export interface ProjectSearchable {
  id?: string;
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
  /** Extra names people search by, e.g. a Korean reading of an English name. */
  searchAliases?: string[];
}

/** The copied reference line: `#ShadowLoop [로컬프로젝트해시: 5D8E5071]` (src/projectCode.ts). */
const REFERENCE = /\[\s*로컬프로젝트해시\s*:\s*([0-9a-f]{8})\s*\]/i;
const CODE_ONLY = /^[0-9a-f]{8}$/i;

export function matchesProjectSearch(project: ProjectSearchable, rawQuery: string): boolean {
  const query = rawQuery.trim();
  if (!query) return true;
  const code = project.id ? projectCode(project.id) : null;

  // A pasted reference is decided by its code alone: the name in it may be an old one.
  const reference = REFERENCE.exec(query);
  if (reference) return code === reference[1]!.toUpperCase();
  // `#name` is how a project is mentioned elsewhere; the `#` is not part of any field.
  const text = query.replace(/^#+/, '').trim();
  if (!text) return true;
  if (code && CODE_ONLY.test(text) && code === text.toUpperCase()) return true;

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
    ...(project.searchAliases ?? []),
  ];
  if (fields.some(value => value != null && matchesSearchText(String(value), text))) return true;

  // Sound-alike matching only on the names a person says aloud, not on paths or commands.
  return [project.name, project.aiName, ...(project.searchAliases ?? [])]
    .some(value => typeof value === 'string' && matchesPhoneticName(value, text));
}
