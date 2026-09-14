import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

// The API remains real, but a Workroom fixture must never launch the installed
// desktop app with its temporary HOME (and occupy the user's normal API port).
const spawnSync = Bun.spawnSync.bind(Bun);
Bun.spawnSync = ((...args: any[]) => {
  const command = args[0];
  if (Array.isArray(command) && command[0] === '/usr/bin/open') {
    if (command.length !== 2 || command[1] !== '/Applications/AgentsToZ_byCS.app') {
      throw new Error('Unexpected external application launch in Workroom fixture');
    }
    appendFileSync(join(process.env.HOME!, 'dashboard-opens.jsonl'), `${JSON.stringify(command)}\n`);
    return spawnSync(['/usr/bin/true'], args[1]);
  }
  return (spawnSync as any)(...args);
}) as typeof Bun.spawnSync;
await import('../../api-server');
