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
