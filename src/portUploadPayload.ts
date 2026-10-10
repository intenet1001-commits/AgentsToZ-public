import { githubRepositoryUrls } from './githubUrls';
import { portFenceGeneration, type PortFenceUpsertRow } from './portDurableFence';

interface UploadPort {
  id: string;
  name: string;
  port?: number;
  syncGeneration?: string;
  sourceDeviceId?: string;
  commandPath?: string;
  terminalCommand?: string;
  folderPath?: string;
  worktreeParentId?: string;
  deployUrl?: string;
  githubUrl?: string;
  githubUrls?: string[];
  manualPath?: string;
  logFilePath?: string;
  favorite?: boolean;
  category?: string;
  description?: string;
}

interface PortMemo { content: string; updatedAt: string }

/** In-memory readiness identity only; never persist or log this value. */
export function portAutoUploadTargetKey(config: {
  supabaseUrl?: string; supabaseAnonKey?: string; deviceId?: string;
} | null | undefined): string | null {
  if (!config?.supabaseUrl || !config.supabaseAnonKey || !config.deviceId) return null;
  return JSON.stringify([config.supabaseUrl, config.supabaseAnonKey, config.deviceId]);
}

/** Manual and automatic upload use the same fields and explicit-clear rules. */
export function buildPortUploadRow(
  port: UploadPort,
  device: { deviceId: string | null; deviceName: string | null },
  memo?: PortMemo,
): PortFenceUpsertRow {
  const urls = githubRepositoryUrls(port);
  return {
    id: port.id,
    name: port.name,
    sync_generation: portFenceGeneration(port.syncGeneration ?? '0'),
    port: port.port ?? null,
    command_path: port.commandPath ?? null,
    terminal_command: port.terminalCommand ?? null,
    folder_path: port.folderPath ?? null,
    worktree_parent_id: port.worktreeParentId ?? null,
    deploy_url: port.deployUrl ?? null,
    github_url: urls[0] ?? null,
    github_urls: urls.length > 0 ? urls : null,
    manual_path: port.manualPath ?? null,
    log_file_path: port.logFilePath ?? null,
    favorite: port.favorite ?? false,
    category: port.category ?? null,
    description: port.description ?? null,
    device_id: device.deviceId,
    device_name: device.deviceName,
    memo: memo?.content ?? null,
    memo_updated_at: memo?.updatedAt ?? null,
  };
}

/** Runtime polling, display order and generation receipts are not user edits. */
export function portAutoUploadChangeKey(
  ports: readonly UploadPort[],
  memos: Readonly<Record<string, PortMemo>>,
): string {
  return JSON.stringify(ports.map(port => {
    const { sync_generation: _generation, ...content } = buildPortUploadRow(
      // Generation is validated inside the guarded mutation, never during a
      // render: malformed saved metadata must not blank the entire app.
      { ...port, syncGeneration: '0' },
      { deviceId: port.sourceDeviceId ?? null, deviceName: null }, memos[port.id],
    );
    return content;
  }).sort((left, right) => left.id.localeCompare(right.id)));
}
