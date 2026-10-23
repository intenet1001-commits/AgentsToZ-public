import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {recoveryHookScript} from '../src/projectMemoryRecoveryHook';

const mockHttp=`
import urllib.request, json
sent=[]
class Response:
 def __enter__(self): return self
 def __exit__(self,*args): pass
 def read(self,n): return b'{"localCheckpointSaved":true}'
class Opener:
 def open(self,request,timeout):
  sent.append(dict(url=request.full_url,payload=json.loads(request.data),timeout=timeout)); return Response()
urllib.request.build_opener=lambda *args: Opener()
`;
function python(code:string){
 const result=Bun.spawnSync(['python3','-c',code],{stdout:'pipe',stderr:'pipe',timeout:10_000});
 expect(result.exitCode).toBe(0);return JSON.parse(result.stdout.toString());
}
test('generated native hooks execute while sending metadata only, without provider text or client paths',()=>{
 for(const agent of ['codex','claude','agy']){
  const data={session_id:'fixture-session',cwd:'/fixture',conversationId:'fixture-session',workspacePaths:['/fixture'],transcript_path:'/private/should-not-send',prompt:'private text'};
  const result=python(mockHttp+`\nimport io,sys\nsys.stdin=io.TextIOWrapper(io.BytesIO(${JSON.stringify(JSON.stringify(data))}.encode()))\nsys.argv=['recovery-hook.py',${JSON.stringify(agent)},'pre-compaction']\nexec(${JSON.stringify(recoveryHookScript())})\nprint(json.dumps(sent))`);
  expect(result).toHaveLength(1);expect(result[0].url).toBe('http://127.0.0.1:3001/api/project-memory/pre-compaction');
  expect(result[0].payload).toEqual({agent,sessionId:'fixture-session',cwd:'/fixture',event:agent==='agy'?'periodic':'pre-compaction',...(agent==='agy'?{workspacePaths:['/fixture']}:{})});
  expect(JSON.stringify(result)).not.toContain('private');
 }
});
test('Hermes registers passive callbacks and sends cwd-bound metadata only before compression',()=>{
 const plugin=readFileSync(new URL('../templates/hermes-plugin/agentstoz-memory-menu/__init__.py',import.meta.url),'utf8');
 const result=python(mockHttp+`
import tempfile,os,sqlite3,pathlib
with tempfile.TemporaryDirectory() as home:
 os.environ['HERMES_HOME']=home
 db=sqlite3.connect(str(pathlib.Path(home)/'state.db'));db.execute('CREATE TABLE sessions(id TEXT,cwd TEXT)');db.execute('INSERT INTO sessions VALUES (?,?)',('fixture-session','/fixture'));db.execute('CREATE TABLE messages(session_id TEXT,role TEXT,content TEXT)');db.execute('INSERT INTO messages VALUES (?,?,?)',('fixture-session','assistant','private body'));db.commit();db.close()
 namespace={};exec(${JSON.stringify(plugin)},namespace)
 class Context:
  def __init__(self):self.hooks={};self.commands=[];self.sections=[]
  def register_hook(self,name,callback):self.hooks[name]=callback
  def register_command(self,name,**kw):self.commands.append(name)
  def register_system_prompt_section(self,*args,**kw):self.sections.append(args[0])
 ctx=Context();namespace['register'](ctx)
 ctx.hooks['pre_api_request'](session_id='fixture-session',request_messages=['private body'])
 ctx.hooks['pre_auxiliary_call'](session_id='fixture-session',aux_task='title_generation')
 ctx.hooks['pre_auxiliary_call'](session_id='fixture-session',aux_task='compression',request_messages=['private body'])
 print(json.dumps(dict(sent=sent,hooks=list(ctx.hooks),commands=ctx.commands,sections=ctx.sections)))
`);
 expect(result.hooks).toEqual(['pre_api_request','pre_auxiliary_call','on_session_end']);expect(result.commands).toHaveLength(10);
 expect(result.sections).toEqual(['agentstoz.memory-ownership']);expect(result.sent).toHaveLength(2);
 expect(result.sent.map((s:any)=>s.payload.event)).toEqual(['periodic','pre-compaction']);
 expect(result.sent.every((s:any)=>s.payload.cwd==='/fixture'&&s.payload.agent==='hermes')).toBe(true);
 expect(JSON.stringify(result)).not.toContain('private body');
});

test('Hermes reserves the first periodic capture for a persisted assistant and rejects ambiguous completion',()=>{
 const plugin=readFileSync(new URL('../templates/hermes-plugin/agentstoz-memory-menu/__init__.py',import.meta.url),'utf8');
 const result=python(mockHttp+`
import tempfile,os,sqlite3,pathlib
with tempfile.TemporaryDirectory() as home:
 os.environ['HERMES_HOME']=home
 db=sqlite3.connect(str(pathlib.Path(home)/'state.db'))
 db.execute('CREATE TABLE sessions(id TEXT,cwd TEXT)');db.execute('INSERT INTO sessions VALUES (?,?)',('fixture-session','/fixture'))
 db.execute('CREATE TABLE messages(session_id TEXT,role TEXT,content TEXT)');db.execute('INSERT INTO messages VALUES (?,?,?)',('fixture-session','user','private input'));db.commit()
 namespace={};exec(${JSON.stringify(plugin)},namespace)
 namespace['_periodic_checkpoint'](session_id='fixture-session');before=len(sent)
 assert before == 0, 'first user-only event consumed the periodic capture allowance'
 for flags in [{},dict(completed=True,failed=True,interrupted=False),dict(completed=True,failed=False,interrupted=True),dict(completed='true',failed=False,interrupted=False)]:
  namespace['_completed_checkpoint'](session_id='fixture-session',**flags)
 db.execute('INSERT INTO messages VALUES (?,?,?)',('other-session','assistant','private other answer'));db.commit()
 namespace['_periodic_checkpoint'](session_id='fixture-session');before_own_answer=len(sent)
 db.execute('INSERT INTO messages VALUES (?,?,?)',('fixture-session','assistant','private own answer'));db.commit();db.close()
 for flags in [{},dict(completed=True,failed=True,interrupted=False),dict(completed=True,failed=False,interrupted=True),dict(completed='true',failed=False,interrupted=False)]:
  namespace['_completed_checkpoint'](session_id='fixture-session',**flags)
 invalid_with_answer=len(sent)
 namespace['_completed_checkpoint'](session_id='fixture-session',completed=True,failed=False,interrupted=False)
 namespace['_before_compression'](session_id='',aux_task='compression')
 print(json.dumps(dict(before=before,beforeOwnAnswer=before_own_answer,invalidWithAnswer=invalid_with_answer,sent=sent)))
`);
 expect(result.before).toBe(0);expect(result.beforeOwnAnswer).toBe(0);expect(result.invalidWithAnswer).toBe(0);expect(result.sent).toHaveLength(1);
 expect(result.sent[0].payload).toEqual({agent:'hermes',sessionId:'fixture-session',cwd:'/fixture',event:'periodic'});
 expect(JSON.stringify(result)).not.toContain('private');
});
