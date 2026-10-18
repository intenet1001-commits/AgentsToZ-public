import {test,expect,afterEach} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createControlProfileConnections} from '../src/controlProfileConnections';
import {configuredHermesInvocationHomes,installAgentsToZInvocation} from '../src/agentstozInvocationInstaller';
const dirs:string[]=[];afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function home(){const h=mkdtempSync(join(tmpdir(),'control-connections-'));dirs.push(h);return h;}
test('Claude connection preserves unrelated MCP settings and is idempotent',async()=>{
 const h=home(),path=join(h,'.claude.json'),before={theme:'dark',mcpServers:{other:{command:'/fixture/other',args:['a']}}};writeFileSync(path,JSON.stringify(before));
 const host=createControlProfileConnections({home:h,appDataDir:h,executable:'/fixture/agentstoz-use-mcp',agents:{claude:'/fixture/claude'},run:async()=>({stdout:'',exitCode:1})});
 expect((await host.install('claude')).connection.state).toBe('configured');expect((await host.install('claude')).changed).toBe(false);
 const data=JSON.parse(readFileSync(path,'utf8'));expect(data.theme).toBe(before.theme);expect(data.mcpServers.other).toEqual(before.mcpServers.other);expect(data.mcpServers.agentstoz_use).toEqual({command:'/fixture/agentstoz-use-mcp',args:[]});
});
test('custom Hermes homes and configured profiles receive the same invocation without changing model choices',async()=>{
 const h=home(),primary=join(h,'.hermes'),profile=join(primary,'profiles','writer'),custom=join(h,'custom-hermes');
 for(const dir of [primary,profile,custom]){mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'config.yaml'),'model: keep-my-model\nmcp_servers:\n  other:\n    command: /fixture/other\n');writeFileSync(join(dir,'SOUL.md'),'My persona\n');}
 mkdirSync(join(primary,'profiles','empty'));
 expect(configuredHermesInvocationHomes(h,custom)).toHaveLength(3);
 const host=createControlProfileConnections({home:h,appDataDir:h,activeHermesHome:custom,executable:'/fixture/agentstoz-use-mcp',agents:{hermes:'/fixture/hermes'},run:async()=>({stdout:'',exitCode:1})});
 expect((await host.install('hermes')).connection.profiles).toBe(3);
 const added=join(primary,'profiles','later');mkdirSync(added);writeFileSync(join(added,'config.yaml'),'model: another-model\n');
 expect((await host.list()).find(c=>c.agent==='hermes')?.state).toBe('not-configured');expect((await host.install('hermes')).connection.profiles).toBe(4);
 for(const dir of [primary,profile,custom]){const data=Bun.YAML.parse(readFileSync(join(dir,'config.yaml'),'utf8')) as any;expect(data.model).toBe('keep-my-model');expect(data.mcp_servers.other.command).toBe('/fixture/other');expect(readFileSync(join(dir,'SOUL.md'),'utf8')).toContain('My persona');expect(readFileSync(join(dir,'skills/agentstoz/SKILL.md'),'utf8')).toContain('agentstoz_use_recall_control_context');}
});
test('conflicting or corrupt provider config remains untouched',async()=>{
 const h=home(),path=join(h,'.claude.json');writeFileSync(path,'{"mcpServers":{"agentstoz_use":{"command":"/other"}}}');const raw=readFileSync(path,'utf8');
 const host=createControlProfileConnections({home:h,appDataDir:h,executable:'/fixture/agentstoz-use-mcp',agents:{claude:'/fixture/claude'},run:async()=>({stdout:'',exitCode:1})});
 await expect(host.install('claude')).rejects.toThrow();expect(readFileSync(path,'utf8')).toBe(raw);
 writeFileSync(path,'broken');await expect(host.install('claude')).rejects.toThrow();expect(readFileSync(path,'utf8')).toBe('broken');
});
test('Codex uses the native MCP command and verifies readback without claiming execution success',async()=>{
 const h=home();let config:any=null;const calls:string[][]=[];
 const host=createControlProfileConnections({home:h,appDataDir:h,executable:'/fixture/agentstoz-use-mcp',agents:{codex:'/fixture/codex'},run:async argv=>{calls.push(argv);if(argv[2]==='get')return {stdout:JSON.stringify(config),exitCode:config?0:1};config={enabled:true,transport:{command:'/fixture/agentstoz-use-mcp',args:[]}};return {stdout:'',exitCode:0};}});
 const result=await host.install('codex');expect(result.connection.state).toBe('configured');expect(result.executionVerified).toBe(false);expect(calls.find(c=>c[2]==='add')).toEqual(['/fixture/codex','mcp','add','agentstoz_use','--','/fixture/agentstoz-use-mcp']);
});

test('agy CLI uses its native registration command and validates the CLI settings path',async()=>{
 const h=home(),path=join(h,'.gemini/config/mcp_config.json'),calls:string[][]=[];mkdirSync(join(h,'.gemini/config'),{recursive:true});
 const host=createControlProfileConnections({home:h,appDataDir:h,executable:'/fixture/agentstoz-use-mcp',agents:{agy:'/fixture/agy'},run:async argv=>{calls.push(argv);writeFileSync(path,JSON.stringify({mcpServers:{agentstoz_use:{command:'/fixture/agentstoz-use-mcp',args:[]}}}));return {stdout:'',exitCode:0};}});
 expect((await host.install('agy')).connection.state).toBe('configured');expect(calls).toEqual([['/fixture/agy','mcp','add','agentstoz_use','/fixture/agentstoz-use-mcp']]);
});

test('옛 모양(앱 번들 경로)은 「설치 안 됨」이 아니라 「설정됨 · 올릴 수 있음」이다 (2026-10-06)', async () => {
  // 그 항목은 지금도 동작한다 — 「설치 안 됨」으로 보고하면 거짓이고, 사용자가 다시 연결해야 하는
  // 것처럼 읽힌다. 다만 앱을 교체할 때마다 끊기므로 고정 경로로 다시 적을 수 있어야 한다.
  const dir = home();
  const bundled = '/Applications/AgentsToZ_byCS.app/Contents/Resources/resources/agentstoz-use-mcp';
  const launcher = join(dir, '.agentstoz/bin/agentstoz-use-mcp');
  mkdirSync(join(dir, '.gemini/config'), { recursive: true });
  writeFileSync(join(dir, '.gemini/config/mcp_config.json'),
    JSON.stringify({ mcpServers: { agentstoz_use: { command: bundled, args: [] } } }, null, 2));
  const connections = createControlProfileConnections({
    home: dir, appDataDir: join(dir, 'data'), executable: launcher, bundledExecutable: bundled,
    agents: { agy: '/usr/local/bin/agy' }, run: async () => ({ stdout: '', exitCode: 0 }),
  });
  const listed = await connections.list();
  const agy = listed.find(entry => entry.agent === 'agy')!;
  expect(agy.state).toBe('configured');
  expect(agy.upgradable).toBe(true);
  // 남이 만든 연결은 여전히 손대지 않는다.
  writeFileSync(join(dir, '.gemini/config/mcp_config.json'),
    JSON.stringify({ mcpServers: { agentstoz_use: { command: 'npx', args: [] } } }, null, 2));
  const foreign = (await connections.list()).find(entry => entry.agent === 'agy')!;
  expect(foreign.state).toBe('needs-attention');
  expect(foreign.upgradable).toBeUndefined();
});

test('자동 보정은 옛 모양을 한 번만 고치고 그 뒤로는 아무것도 쓰지 않는다 (2026-10-06)', async () => {
  // 시작할 때마다 `upgradable`인 연결을 다시 등록하므로, 올린 뒤에도 계속 `upgradable`이면
  // 부팅마다 사용자의 AI 설정 파일을 덮어쓰는 루프가 된다. 그 성질을 여기서 고정한다.
  const dir = home();
  const bundled = '/Applications/AgentsToZ_byCS.app/Contents/Resources/resources/agentstoz-use-mcp';
  const launcher = join(dir, '.agentstoz/bin/agentstoz-use-mcp');
  const path = join(dir, '.claude.json');
  writeFileSync(path, JSON.stringify({ mcpServers: { agentstoz_use: { command: bundled, args: [] } } }));
  const connections = createControlProfileConnections({
    home: dir, appDataDir: join(dir, 'data'), executable: launcher, bundledExecutable: bundled,
    agents: { claude: '/fixture/claude' }, run: async () => ({ stdout: '', exitCode: 1 }),
  });

  expect((await connections.list()).find(entry => entry.agent === 'claude')!.upgradable).toBe(true);
  expect((await connections.install('claude')).changed).toBe(true);
  expect(JSON.parse(readFileSync(path, 'utf8')).mcpServers.agentstoz_use.command).toBe(launcher);

  // 두 번째 부팅: 고칠 것이 없고, 다시 설치해도 파일을 쓰지 않는다.
  const after = (await connections.list()).find(entry => entry.agent === 'claude')!;
  expect(after.state).toBe('configured');
  expect(after.upgradable).toBeFalsy();
  expect((await connections.install('claude')).changed).toBe(false);
});

test('고정 런처로 적은 항목은 env 고정이 남아 있어도 다시 쓰지 않는다 (2026-10-06)', async () => {
  // OPS 프로필 설치기는 `AGENTSTOZ_CONTROLLER_PORT_ID`를 고정해 적는다. 그 모양을 「올릴 수 있음」으로
  // 보면 두 설치기가 서로의 글을 지우며 번갈아 쓴다.
  const dir = home();
  const launcher = join(dir, '.agentstoz/bin/agentstoz-use-mcp');
  const path = join(dir, '.claude.json');
  writeFileSync(path, JSON.stringify({
    mcpServers: { agentstoz_use: { command: launcher, args: [], env: { AGENTSTOZ_CONTROLLER_PORT_ID: '1773136552857' } } },
  }));
  const connections = createControlProfileConnections({
    home: dir, appDataDir: join(dir, 'data'), executable: launcher,
    bundledExecutable: '/Applications/AgentsToZ_byCS.app/Contents/Resources/resources/agentstoz-use-mcp',
    agents: { claude: '/fixture/claude' }, run: async () => ({ stdout: '', exitCode: 1 }),
  });
  const listed = (await connections.list()).find(entry => entry.agent === 'claude')!;
  expect(listed.state).toBe('configured');
  expect(listed.upgradable).toBeFalsy();
  expect((await connections.install('claude')).changed).toBe(false);
  expect(JSON.parse(readFileSync(path, 'utf8')).mcpServers.agentstoz_use.env)
    .toEqual({ AGENTSTOZ_CONTROLLER_PORT_ID: '1773136552857' });
});
