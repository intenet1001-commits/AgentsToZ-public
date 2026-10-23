/** Portable standard-library reference, supplied to the project's DEV Workroom, never run by the host. */
export const APP_USE_PYTHON_SDK = String.raw`"""AgentsToZ app USE v1. Integrate behind the app's explicit Allow/Revoke UI.
invoke(action_id, arguments, request_id, assert_active) must check assert_active()
immediately before EACH app write. Return running/unknown until actual work is proven.
Keep this ledger outside source control; never print a connection code to logs.
"""
import base64, hashlib, hmac, json, math, os, re, secrets, sqlite3, stat, threading, time, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

def pack(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()

class AppUseBridge:
    def __init__(self, project_id, ledger_path, port, actions, current_scope, invoke, revision="app-use-v1"):
        self.project_id, self.port, self.actions = project_id, port, actions
        self.current_scope, self.invoke, self.revision = current_scope, invoke, revision
        self.lock, self.nonces = threading.RLock(), {}
        fd=os.open(ledger_path,os.O_CREAT|os.O_RDWR|getattr(os,"O_NOFOLLOW",0),0o600)
        try:
            if os.fstat(fd).st_nlink!=1 or not stat.S_ISREG(os.fstat(fd).st_mode): raise ValueError("Ledger must be an app-owned regular file")
            if hasattr(os,"fchmod"): os.fchmod(fd,0o600)
        finally: os.close(fd)
        self.db = sqlite3.connect(ledger_path, check_same_thread=False)
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS atz_meta(id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS atz_grants(id TEXT PRIMARY KEY, key TEXT, scope TEXT, expires REAL, active INTEGER);
        CREATE TABLE IF NOT EXISTS atz_receipts(id TEXT PRIMARY KEY, grant_id TEXT, intent TEXT, outcome TEXT NOT NULL);
        """)
        self.db.execute("INSERT OR IGNORE INTO atz_meta VALUES('installation', ?)", (str(uuid.uuid4()),))
        self.db.commit()
        self.installation = self.db.execute("SELECT value FROM atz_meta WHERE id='installation'").fetchone()[0]

    def issue_code(self):
        # Call ONLY from the authenticated app's explicit user action, never from this HTTP surface.
        scope = self.current_scope()
        if set(scope) != {"principalId", "libraryId", "deviceId"}:
            raise ValueError("App must supply its actual signed-in user, library and device identity")
        with self.lock:
            if self.db.execute("SELECT count(*) FROM atz_grants WHERE active=1 AND expires>?", (time.time(),)).fetchone()[0] >= 8:
                raise ValueError("Revoke an existing grant before issuing another")
            grant, secret = str(uuid.uuid4()), secrets.token_urlsafe(32)
            key = hashlib.sha256(secret.encode()).hexdigest()
            self.db.execute("INSERT INTO atz_grants VALUES(?,?,?,?,1)", (grant, key, pack(scope).decode(), time.time()+30*86400))
            self.db.commit()
        meta = base64.urlsafe_b64encode(pack({"port":self.port,"installationId":self.installation,"grantId":grant})).decode().rstrip("=")
        return "ATZUSE1."+meta+"."+secret

    def revoke(self, grant_id):
        with self.lock:
            self.db.execute("UPDATE atz_grants SET active=0 WHERE id=?", (grant_id,))
            self.db.commit()

    def scope(self, grant):
        with self.lock:
            row = self.db.execute("SELECT key,scope,expires,active FROM atz_grants WHERE id=?", (grant,)).fetchone()
        if not row or not row[3] or row[2] <= time.time() or json.loads(row[1]) != self.current_scope():
            raise PermissionError("Grant or app profile changed")
        return {**json.loads(row[1]),"installationId":self.installation,"grantRevision":grant}, bytes.fromhex(row[0])

    def finish(self, request_id, outcome):
        # Optional: an app's own background worker reports its ACTUAL existing result, never re-executes.
        if not isinstance(outcome,dict) or outcome.get("state") not in ("completed","running","failed","unknown","cancelled") or not isinstance(outcome.get("message"),str) or not outcome["message"].strip() or len(outcome["message"].encode())>2000:
            raise ValueError("Invalid app result")
        with self.lock:
            row=self.db.execute("SELECT grant_id FROM atz_receipts WHERE id=?",(request_id,)).fetchone()
            if not row: raise ValueError("Unknown request")
            self.scope(row[0])
            self.db.execute("UPDATE atz_receipts SET outcome=? WHERE id=?",(pack(outcome).decode(),request_id))
            self.db.commit()

    def dispatch(self, operation, headers, raw):
        if operation not in ("scope", "execute", "receipt") or len(raw)>12000:
            raise ValueError("Invalid operation")
        if headers.get("Host") != "127.0.0.1:"+str(self.port) or headers.get("Origin") is not None:
            raise PermissionError("Local signed clients only")
        identity = headers.get("x-agentstoz-use-grant", "").split(".")
        if len(identity)!=2 or identity[0]!=self.installation:
            raise PermissionError("Wrong installation")
        grant = identity[1]
        scope, key = self.scope(grant)
        stamp, nonce = headers.get("x-agentstoz-use-time", ""), headers.get("x-agentstoz-use-nonce", "")
        if not re.fullmatch(r"[0-9]{10,16}", stamp) or abs(time.time()*1000-int(stamp))>30000 or not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", nonce):
            raise PermissionError("Expired request")
        canonical = "\n".join(("ATZUSE1",operation,stamp,nonce,hashlib.sha256(raw).hexdigest()))
        if not hmac.compare_digest(hmac.new(key,canonical.encode(),hashlib.sha256).hexdigest(), headers.get("x-agentstoz-use-signature", "")):
            raise PermissionError("Bad signature")
        with self.lock:
            now=time.time()
            self.nonces={k:v for k,v in self.nonces.items() if v>now-31}
            if nonce in self.nonces or len(self.nonces)>=4096:
                raise PermissionError("Repeated or excessive nonce")
            self.nonces[nonce]=now
        body=json.loads(raw)
        if not isinstance(body,dict):
            raise ValueError("Invalid body")
        if operation=="scope":
            if body: raise ValueError("Scope takes no input")
            result={"protocol":"agentstoz-app-use-v1","projectId":self.project_id,"serviceKey":"default","definitionRevision":self.revision,"scope":scope,"actions":self.actions}
        else:
            expected={"requestId","binding","call"} if operation=="execute" else {"requestId","binding"}
            if set(body)!=expected or not isinstance(body["requestId"],str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,128}",body["requestId"]):
                raise ValueError("Invalid request")
            binding=body["binding"]
            def assert_active():
                live,_=self.scope(grant)
                if live!=scope or not isinstance(binding,dict) or any(binding.get(k)!=v for k,v in scope.items()) or binding.get("projectId")!=self.project_id or binding.get("serviceKey")!="default" or binding.get("role")!="use" or binding.get("definitionRevision")!=self.revision or binding.get("allowedTools")!=["app.invoke"]:
                    raise PermissionError("Execution scope changed")
            assert_active()
            rid=body["requestId"]
            with self.lock:
                old=self.db.execute("SELECT grant_id,intent,outcome FROM atz_receipts WHERE id=?",(rid,)).fetchone()
            if operation=="receipt":
                if not old or old[0]!=grant: raise PermissionError("Unknown receipt")
                result={"outcome":json.loads(old[2])}
            else:
                call=body["call"]
                if not isinstance(call,dict) or set(call)!={"role","serviceKey","tool","input"} or call.get("role")!="use" or call.get("serviceKey")!="default" or call.get("tool")!="app.invoke":
                    raise ValueError("Invalid call")
                value=call["input"]
                if not isinstance(value,dict) or set(value)!={"actionId","arguments"}: raise ValueError("Invalid action")
                action=next((a for a in self.actions if a["id"]==value["actionId"]),None)
                args=value["arguments"]
                if not action or not isinstance(args,dict) or len(args)>8 or len(pack(args))>3000: raise ValueError("Invalid arguments")
                fields={f["key"]:f for f in action["fields"]}
                if set(args)-set(fields) or any(f["required"] and k not in args for k,f in fields.items()): raise ValueError("Missing arguments")
                for k,v in args.items():
                    typ=fields[k]["type"]
                    valid = typ=="boolean" and type(v) is bool or typ=="number" and type(v) in (int,float) and math.isfinite(v) and abs(v)<=1e12 or typ=="string" and isinstance(v,str) and len(v.encode())<=2000 and not re.search(r"[\x00-\x08\x0b-\x1f\x7f]",v)
                    if not valid: raise ValueError("Wrong argument type")
                intent=hashlib.sha256(pack({"call":call,"binding":binding})).hexdigest()
                unknown={"state":"unknown","message":"Check the original request receipt; do not replay.","operationId":rid}
                # Commit admission BEFORE app effects. A restart preserves unknown; never retry automatically.
                with self.lock:
                    old=self.db.execute("SELECT grant_id,intent,outcome FROM atz_receipts WHERE id=?",(rid,)).fetchone()
                    if old:
                        if old[0]!=grant or old[1]!=intent: raise PermissionError("Request ID conflict")
                        outcome=json.loads(old[2])
                    else:
                        self.db.execute("INSERT INTO atz_receipts VALUES(?,?,?,?)",(rid,grant,intent,pack(unknown).decode()))
                        self.db.commit()
                if not old:
                    try:
                        assert_active()
                        outcome=self.invoke(action["id"],args,rid,assert_active)
                        assert_active()
                        if not isinstance(outcome,dict) or outcome.get("state") not in ("completed","running","failed","unknown","cancelled") or not isinstance(outcome.get("message"),str) or not outcome["message"].strip() or len(outcome["message"].encode())>2000:
                            raise ValueError("Invalid app outcome")
                    except Exception:
                        outcome=unknown
                    with self.lock:
                        # A fast background finish may already have replaced admission's unknown receipt.
                        self.db.execute("UPDATE atz_receipts SET outcome=? WHERE id=? AND outcome=?",(pack(outcome).decode(),rid,pack(unknown).decode()))
                        self.db.commit()
                        outcome=json.loads(self.db.execute("SELECT outcome FROM atz_receipts WHERE id=?",(rid,)).fetchone()[0])
                result={"outcome":outcome}
        assert_scope,_=self.scope(grant)
        if assert_scope!=scope: raise PermissionError("Profile changed")
        payload=pack(result)
        if len(payload)>12000: raise ValueError("Response too large")
        proof=hmac.new(key,b"reply\n"+nonce.encode()+b"\n"+hashlib.sha256(payload).hexdigest().encode(),hashlib.sha256).hexdigest()
        return payload, proof

    def handler(self):
        bridge=self
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                try:
                    if self.client_address[0]!="127.0.0.1" or not self.path.startswith("/api/agentstoz-use/"): raise PermissionError()
                    size=int(self.headers.get("Content-Length","0"))
                    if size<=0 or size>12000: raise ValueError()
                    self.connection.settimeout(10)
                    payload,proof=bridge.dispatch(self.path.removeprefix("/api/agentstoz-use/"),self.headers,self.rfile.read(size))
                    self.send_response(200);self.send_header("Content-Type","application/json");self.send_header("Cache-Control","no-store");self.send_header("x-agentstoz-use-proof",proof);self.end_headers();self.wfile.write(payload)
                except Exception:
                    self.send_response(403);self.end_headers()
            def log_message(self,*args): pass
        return Handler

    def server(self):
        class Server(ThreadingHTTPServer):
            slots=threading.BoundedSemaphore(8)
            def process_request(self,request,address):
                if not self.slots.acquire(blocking=False):
                    self.shutdown_request(request)
                    return
                try: super().process_request(request,address)
                except Exception:
                    self.slots.release()
                    raise
            def process_request_thread(self,request,address):
                try: super().process_request_thread(request,address)
                finally: self.slots.release()
        return Server(("127.0.0.1",self.port),self.handler())
`;
