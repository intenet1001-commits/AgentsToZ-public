/** Private host metadata. Never include this descriptor in browser status DTOs. */
export interface MemoryBackupGuard {
  memoryId: string;
  contentHash: string;
  destinationHash: string;
  parentRevisionId: string | null;
}

export interface AutoRememberBackup extends MemoryBackupGuard {
  projectId: string;
  projectName: string;
  projectRoot: string;
}

export type MemoryBackupState = 'pending' | 'retrying' | 'complete' | 'blocked';
export interface MemoryBackupStatus {
  jobId: string;
  projectName: string;
  state: MemoryBackupState;
  attempts: number;
}
