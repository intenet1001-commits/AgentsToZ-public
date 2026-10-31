import sys,json,os,stat,tempfile,datetime,subprocess,math,signal
provider,root=sys.argv[1:3]
active=os.environ.get('AGENTSTOZ_WEEKLY_HOOK_ACTIVE','').split(',')
if provider in active: sys.exit(0)
raw=sys.stdin.buffer.read(1048577)
def safe_file(path):
 s=os.lstat(path)
 if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1 or s.st_uid!=os.getuid(): raise ValueError('unsafe file')
 return path
def numeric(n): return isinstance(n,(int,float)) and not isinstance(n,bool) and math.isfinite(n)
try:
 d=json.loads(raw) if len(raw)<=1048576 else {}
 entries=[]
 if provider=='claude':
  w=(d.get('rate_limits') or {}).get('seven_day') or {}
  p=w.get('used_percentage')
  at=w.get('resets_at')
  if numeric(p) and 0<=p<=100: entries.append({'label':'\uC8FC\uAC04','remainingPercent':round(100-p,1),'resetsAt':at if numeric(at) and at>0 else None})
 elif provider=='agy':
  for key,w in (d.get('quota') or {}).items():
   if len(entries)>=8: break
   if 'weekly' not in key.lower().replace('_','-').split('-') or not isinstance(w,dict) or w.get('disabled'): continue
   p=w.get('remaining_fraction')
   if not numeric(p) or not 0<=p<=1: continue
   at=w.get('reset_time'); timestamp=None
   try: timestamp=datetime.datetime.fromisoformat(at.replace('Z','+00:00')).timestamp() if isinstance(at,str) else None
   except Exception: pass
   label='Gemini' if 'gemini' in key.lower() else 'Claude/GPT' if any(x in key.lower() for x in ('claude','gpt')) else '\uCD94\uAC00 \uD55C\uB3C4'
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
