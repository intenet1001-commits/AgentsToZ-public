import { createHash } from 'node:crypto';
import { createReadStream, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  CODEX_RUNTIME_MACOS_IDENTIFIER,
  CODEX_RUNTIME_MACOS_TEAM_ID,
  codexRuntimeExecutableRevision,
  type CodexRuntimeExecutableIdentity,
} from '../../src/codexRuntimeExecutable';
import {
  AGENT_RUNTIME_GUARD_RESERVATION_ENV,
  encodeAgentRuntimeGuardReservation,
  prepareAgentRuntimeGuardRegistry,
} from '../../src/agentRuntimeGuardRegistry';

const [guardSource, childSource, grandchildSource, pidFile, mode, guardPidFile] = process.argv.slice(2);
if (!guardSource || !childSource || !grandchildSource || !pidFile) process.exit(64);

const executable = realpathSync(process.execPath);
const info = statSync(executable, { bigint: true });
const hash = createHash('sha256');
for await (const chunk of createReadStream(executable)) hash.update(chunk as Buffer);
const baseIdentity: Omit<CodexRuntimeExecutableIdentity, 'revision'> = {
  path: executable,
  source: 'standalone-native',
  version: '1.0.0',
  sha256: hash.digest('hex'),
  stat: {
    dev: info.dev.toString(),
    ino: info.ino.toString(),
    size: info.size.toString(),
    mode: Number(info.mode),
    mtimeNs: info.mtimeNs.toString(),
    ctimeNs: info.ctimeNs.toString(),
  },
  signing: process.platform === 'darwin' ? {
    platform: 'darwin',
    teamId: CODEX_RUNTIME_MACOS_TEAM_ID,
    identifier: CODEX_RUNTIME_MACOS_IDENTIFIER,
  } : null,
};
const executableIdentity: CodexRuntimeExecutableIdentity = {
  ...baseIdentity,
  revision: codexRuntimeExecutableRevision(baseIdentity),
};
const registry = prepareAgentRuntimeGuardRegistry(join(dirname(pidFile), 'app-data'));
const reservation = registry.reserve({ kind: 'codex', cwd: dirname(pidFile) });

const guard = Bun.spawn([
  process.execPath,
  '--env-file=/dev/null',
  guardSource,
  'agentstoz-provider-argv-v4',
  dirname(pidFile),
  executable,
  '--env-file=/dev/null',
  childSource,
  pidFile,
  grandchildSource,
], {
  env: {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    AGENTSTOZ_CODEX_EXECUTABLE_IDENTITY_V1: Buffer.from(
      JSON.stringify(executableIdentity),
      'utf8',
    ).toString('base64url'),
    [AGENT_RUNTIME_GUARD_RESERVATION_ENV]: encodeAgentRuntimeGuardReservation(reservation),
  },
  stdin: 'pipe',
  stdout: 'ignore',
  stderr: 'inherit',
  // Production launches the guard with detached:true. The guard deliberately
  // signals its own PGID, so this fixture must give it the same ownership
  // boundary instead of leaving it in the fixture parent's process group.
  detached: true,
});

if (mode === 'exit-after-guard-spawn') {
  if (!guardPidFile) process.exit(64);
  writeFileSync(guardPidFile, String(guard.pid), { mode: 0o600 });
  // Deliberately do not await the guard. This models a sidecar crash while the
  // guard is still performing its synchronous executable identity check.
  process.exit(0);
}

await guard.exited;
