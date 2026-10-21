import {basename,join} from 'node:path';
import type {AiTerminalAgent} from './aiTerminalProtocol';
const quote = (text: string) => "'" + text.replaceAll("'", "'\"'\"'") + "'";

/** Wrap the existing native command without changing its permissions, account, model or cwd. */
export function externalCliEffortCommand(input: {
  agent: AiTerminalAgent; executable: string; command: string; appDataDir: string;
  launcher: string[]; platform: NodeJS.Platform;
}): string {
  if (input.platform !== 'darwin' || input.agent === 'agy') return input.command;
  return `APP_DATA_DIR=${quote(input.appDataDir)} ${[...input.launcher,'--agentstoz-effort-cli',input.agent,input.executable,input.command].map(quote).join(' ')}`;
}

export function externalCliEffortLauncher(execPath: string, root: string, bundled: boolean): string[] {
  return bundled || /^agentstoz-api-sidecar(?:\.exe)?$/i.test(basename(execPath)) ? [execPath] : [execPath,'--no-env-file',join(root,'api-sidecar-entry.ts')];
}
