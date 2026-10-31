/** Hook script revision. The file keeps its installed name (`statusline-v1.py`), so the CLI setting never changes on an
 *  upgrade: WeeklyUsageHost replaces an older app-written copy in place (RELEASED_WEEKLY_USAGE_HOOK_SHA256). */
export const WEEKLY_USAGE_HOOK_VERSION=2;
/** sha256 of every hook the app has written before, so only an unmodified app copy is ever replaced. Add the previous
 *  hash here whenever WEEKLY_USAGE_HOOK changes. */
export const RELEASED_WEEKLY_USAGE_HOOK_SHA256:readonly string[]=[
 '8fb5e5b54672dd7f34eee11a75b6f6e619bc63afd87ba61ec65777bfec1ffc27', // v1 (a0c1fda6): weekly quota only
];
/**
 * Runs only on the provider's native statusline event; never reads a transcript or credentials.
 * v2 also writes Claude's context snapshot `<appData>/context/<session_id>.json` for 「최근 AI 세션」 (api-server
 * `/api/context-usage`, the dock's Compact·Clear): numbers, folders, model and the terminal identifiers below only.
 * The snapshot is a disposable UI file: atomic replace, 0600, no fsync, at most one write per 15 s while unchanged,
 * and any failure is ignored so the original statusline still runs with the same input and output.
 */
export const WEEKLY_USAGE_HOOK=String.raw`# AgentsToZ statusline hook v2 (weekly quota + Claude context snapshot)
import sys,json,os,re,stat,tempfile,datetime,subprocess,math,signal,time
provider,root=sys.argv[1:3]
active=os.environ.get('AGENTSTOZ_WEEKLY_HOOK_ACTIVE','').split(',')
if provider in active: sys.exit(0)
raw=sys.stdin.buffer.read(1048577)
def safe_file(path):
 s=os.lstat(path)
 if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1 or s.st_uid!=os.getuid(): raise ValueError('unsafe file')
 return path
def numeric(n): return isinstance(n,(int,float)) and not isinstance(n,bool) and math.isfinite(n)
d={}
try:
 d=json.loads(raw) if len(raw)<=1048576 else {}
 entries=[]
 if provider=='claude':
  w=(d.get('rate_limits') or {}).get('seven_day') or {}
  p=w.get('used_percentage')
  at=w.get('resets_at')
  if numeric(p) and 0<=p<=100: entries.append({'label':'주간','remainingPercent':round(100-p,1),'resetsAt':at if numeric(at) and at>0 else None})
 elif provider=='agy':
  for key,w in (d.get('quota') or {}).items():
   if len(entries)>=8: break
   if 'weekly' not in key.lower().replace('_','-').split('-') or not isinstance(w,dict) or w.get('disabled'): continue
   p=w.get('remaining_fraction')
   if not numeric(p) or not 0<=p<=1: continue
   at=w.get('reset_time'); timestamp=None
   try: timestamp=datetime.datetime.fromisoformat(at.replace('Z','+00:00')).timestamp() if isinstance(at,str) else None
   except Exception: pass
   label='Gemini' if 'gemini' in key.lower() else 'Claude/GPT' if any(x in key.lower() for x in ('claude','gpt')) else '추가 한도'
   entries.append({'label':label,'remainingPercent':round(p*100,1),'resetsAt':timestamp})
 if entries or (any(k in d for k in ('context_window','rate_limits','quota')) and not os.path.exists(os.path.join(root,provider+'.json'))):
  s=os.lstat(root)
  if not stat.S_ISDIR(s.st_mode) or stat.S_ISLNK(s.st_mode) or s.st_uid!=os.getuid() or s.st_mode&0o077: raise ValueError('unsafe root')
  now=datetime.datetime.now(datetime.timezone.utc);write=True
  try:
   with open(safe_file(os.path.join(root,provider+'.json')),encoding='utf-8') as f: old=json.loads(f.read(16384))
   age=(now-datetime.datetime.fromisoformat(old['checkedAt'])).total_seconds()
   if old.get('buckets')==entries and 0<=age<30: write=False
  except Exception: pass
  if write:
   payload={'version':1,'provider':provider,'checkedAt':now.isoformat(),'buckets':entries}
   fd,path=tempfile.mkstemp(prefix='.quota-',dir=root)
   try:
    with os.fdopen(fd,'w',encoding='utf-8') as f: json.dump(payload,f,ensure_ascii=False);f.flush();os.fsync(f.fileno())
    os.replace(path,os.path.join(root,provider+'.json'))
   finally:
    if os.path.exists(path): os.unlink(path)
except Exception: pass
# Claude context snapshot. The file name is the Claude session id, exactly as /api/context-usage reads it.
UUID=re.compile(r'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}')
def text(v,n):
 return v if isinstance(v,str) and 0<len(v)<=n and not any(c in v for c in '\0\r\n') else None
def number(v): return v if numeric(v) else None
try:
 sid=d.get('session_id') if provider=='claude' and isinstance(d,dict) else None
 window=d.get('context_window') if isinstance(sid,str) else None
 if isinstance(sid,str) and UUID.fullmatch(sid) and isinstance(window,dict):
  workspace=d.get('workspace') if isinstance(d.get('workspace'),dict) else {}
  model=d.get('model') if isinstance(d.get('model'),dict) else {}
  cost=d.get('cost') if isinstance(d.get('cost'),dict) else {}
  usage=window.get('current_usage') if isinstance(window.get('current_usage'),dict) else None
  context={k:number(window.get(k)) for k in ('context_window_size','used_percentage','remaining_percentage','total_input_tokens','total_output_tokens')}
  context['current_usage']={k:number(usage.get(k)) for k in ('input_tokens','output_tokens','cache_creation_input_tokens','cache_read_input_tokens')} if usage is not None else None
  # Where this Claude runs (src/sessionOrigin.ts). A Workroom is its own surface: Orca/cmux identifiers it inherited
  # from whatever opened this app are not its terminal. The Orca hook token is never read.
  env=os.environ;launch={}
  workroom=env.get('AGENTSTOZ_WORKROOM_SESSION_ID','')
  if UUID.fullmatch(workroom): launch['agentstozWorkroomSessionId']=workroom
  else:
   for key,name in (('orcaWorktreeId','ORCA_WORKTREE_ID'),('orcaPaneKey','ORCA_PANE_KEY'),('cmuxWorkspaceId','CMUX_WORKSPACE_ID'),('cmuxSurfaceId','CMUX_SURFACE_ID')):
    v=text(env.get(name),4096)
    if v: launch[key]=v
  for key,name in (('termProgram','TERM_PROGRAM'),('termProgramVersion','TERM_PROGRAM_VERSION'),('claudeCodeEntrypoint','CLAUDE_CODE_ENTRYPOINT')):
   v=text(env.get(name),200)
   if v: launch[key]=v
  snapshot={'version':1,'sessionId':sid,'cwd':text(d.get('cwd'),4096) or text(workspace.get('current_dir'),4096),'projectDir':text(workspace.get('project_dir'),4096),
   'model':{'id':text(model.get('id'),200),'display_name':text(model.get('display_name'),200)},'contextWindow':context,
   'cost':{'total_cost_usd':number(cost.get('total_cost_usd'))},'launchContext':launch}
  directory=os.path.join(os.path.dirname(os.path.abspath(root)),'context')
  try: os.mkdir(directory,0o700)
  except FileExistsError: pass
  s=os.lstat(directory)
  if not stat.S_ISDIR(s.st_mode) or s.st_uid!=os.getuid() or s.st_mode&0o022: raise ValueError('unsafe context directory')
  target=os.path.join(directory,sid+'.json');existed=os.path.lexists(target);write=True
  if existed:
   try:
    with open(safe_file(target),encoding='utf-8') as f: old=json.loads(f.read(65536))
    age=time.time()-datetime.datetime.fromisoformat(old.pop('capturedAt')).timestamp()
    if old==snapshot and 0<=age<15: write=False
   except Exception: pass
  if write:
   snapshot['capturedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds')
   fd,path=tempfile.mkstemp(prefix='.context-',dir=directory)
   try:
    with os.fdopen(fd,'w',encoding='utf-8') as f: json.dump(snapshot,f,ensure_ascii=False)
    os.replace(path,target)
   finally:
    if os.path.exists(path): os.unlink(path)
  if not existed:
   # A new conversation: drop this folder's own snapshots older than 30 days so the 5 s list read stays small.
   cutoff=time.time()-30*86400
   with os.scandir(directory) as items:
    for i,item in enumerate(items):
     if i>=4096: break
     name=item.name
     if not (name.endswith('.json') and UUID.fullmatch(name[:-5]) or name.startswith('.context-')): continue
     st=item.stat(follow_symlinks=False)
     if stat.S_ISREG(st.st_mode) and st.st_uid==os.getuid() and st.st_mtime<(cutoff if name.endswith('.json') else time.time()-86400): os.unlink(item.path)
except Exception: pass
# Preserve the original statusline's input/output. The private backup contains only that setting.
try:
 with open(safe_file(os.path.join(root,provider+'-previous.json')),encoding='utf-8') as f: previous=json.loads(f.read(65536))
 line=previous.get('statusLine') or {};command=line.get('command')
 if line.get('enabled') is not False and isinstance(command,str) and command:
  env=dict(os.environ);env['AGENTSTOZ_WEEKLY_HOOK_ACTIVE']=','.join([x for x in active if x in ('claude','agy')]+[provider])
  p=subprocess.Popen(command,shell=True,stdin=subprocess.PIPE,start_new_session=True,env=env)
  try: p.communicate(raw,timeout=3)
  except subprocess.TimeoutExpired:
   try: os.killpg(p.pid,signal.SIGKILL)
   except ProcessLookupError: pass
   p.communicate(timeout=1)
except Exception: pass
`;
