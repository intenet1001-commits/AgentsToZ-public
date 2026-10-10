import {expect,test} from 'bun:test';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';

test('retired CS-CEO bot creation prompt is absent from the app',()=>{
  const root=join(import.meta.dir,'..');
  expect(existsSync(join(root,'src/agentstozBotPrompt.ts'))).toBe(false);
  for(const file of ['src/PortalManager.tsx','src/PortalMemoryDirectory.tsx','src/BuzzAgentSetupDialog.tsx']){
    const source=readFileSync(join(root,file),'utf8');
    expect(source).not.toContain('buildAgentsToZBotCreationPrompt');
    expect(source).not.toContain('CS-CEO');
  }
});
