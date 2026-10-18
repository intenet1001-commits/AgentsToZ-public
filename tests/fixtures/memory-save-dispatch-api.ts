// Runs in a separate temporary-HOME API process. Replace both model-producing
// exports before importing the server; no real provider or remote save is used.
import { mock } from 'bun:test';
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as memory from '../../project-memory-server';
const fixture = process.env.MEMORY_DISPATCH_FIXTURE!;
if (!fixture || !existsSync(join(fixture, 'fixture-ready'))) throw new Error('Missing isolated fixture');
const fake = async (input: { folderPath: string; signal?: AbortSignal }) => {
  appendFileSync(join(fixture, 'calls.jsonl'), JSON.stringify({ root: input.folderPath }) + '\n');
  while (!existsSync(join(fixture, 'release'))) {
    input.signal?.throwIfAborted(); await Bun.sleep(10);
  }
  return { success: true, localSaved: true, remoteBackedUp: false, backupSkipped: true };
};
mock.module('../../project-memory-server', () => ({ ...memory, updateProjectMemory: fake, sessionEndProjectMemory: fake }));
await import('../../api-server');
