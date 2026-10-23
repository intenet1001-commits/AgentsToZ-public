import {execFile, spawn, type ChildProcess} from 'node:child_process';
import {join, isAbsolute} from 'node:path';
import {mkdirSync, lstatSync} from 'node:fs';
import {CliAccountStore} from './cliAccountStore';
import {HOST_CLI_ACCOUNT_ID, normalizeCliAccountAdminRequest, type CliAccountAdminRequest, type CliAccountAgent, type CliAccountSelection, type CliAccountSummary} from './cliAccountProtocol';
import {WorkroomRequestLedger} from './workroomRequestLedger';

export interface CliAccountLaunch {accountId: string; label: string; env: Record<string,string|undefined>; args: string[]}
export interface CliAccountLogin {finished: Promise<boolean>; stop(): Promise<void>}
export interface CliAccountManagerDependencies {
  store: CliAccountStore;
  executable(agent: CliAccountAgent): string | null;
  env?: Record<string,string|undefined>;
  probe?(agent: CliAccountAgent, executable: string, env: Record<string,string|undefined>, args: string[]): Promise<CliAccountSummary['authState']>;
  login?(agent: CliAccountAgent, executable: string, env: Record<string,string|undefined>, args: string[]): CliAccountLogin;
  inUse?(accountId: string): boolean;
}
/** Explicit profiles must not inherit a token, gateway or cloud-provider choice from the host process. */
export function cliAccountEnvironment(agent: CliAccountAgent, directory: string, base: Record<string,string|undefined>): Record<string,string|undefined> {
  const env = {...base};
  for (const key of Object.keys(env)) if (/^(OPENAI_|CODEX_|ANTHROPIC_|CLAUDE_|AGENTSTOZ_VOICE_API_KEY$|(?:VITE_)?SUPABASE_SERVICE_ROLE_KEY$|(?:PORTMGR_|AGENTSTOZ_).*CAPABILITY)/.test(key)) delete env[key];
  delete env.SSH_CONNECTION; delete env.SSH_CLIENT; delete env.SSH_TTY;
  delete env.BROWSER; // Let the official local login command open the user's browser.
  env[agent === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'] = directory;
  env.LANG ||= 'en_US.UTF-8';
  return env;
}
/** Only classification is returned. Never persist or return email, API key source, stdout or stderr. */
export function classifyCliAccountProbe(agent: CliAccountAgent, ok: boolean, output: string): CliAccountSummary['authState'] {
  if (agent === 'claude') {
    try {
      const r = JSON.parse(output);
      return ok && r.loggedIn === true && r.authMethod === 'claude.ai' ? 'signed-in' : r.loggedIn === false ? 'signed-out' : 'unknown';
    } catch { return 'unknown'; }
  }
  const text = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim();
  return ok && /^Logged in using ChatGPT\b/i.test(text) ? 'signed-in' : /^Not logged in\b/i.test(text) ? 'signed-out' : 'unknown';
}
function probe(agent: CliAccountAgent, executable: string, env: Record<string,string|undefined>, prefix: string[]) {
  return new Promise<CliAccountSummary['authState']>(resolve => execFile(executable,
    [...prefix, ...(agent === 'codex' ? ['login','status'] : ['auth','status','--json'])],
    {env, cwd: agent === 'codex' ? env.CODEX_HOME : env.CLAUDE_CONFIG_DIR, timeout: 5000, maxBuffer: 16_384, encoding: 'utf8'},
    (error, stdout, stderr) => resolve(classifyCliAccountProbe(agent, !error, agent === 'claude' ? stdout : stdout + '\n' + stderr))));
}
/** One owned process tree, bounded time/output, with no login output in the UI, logs or API. */
export function startCliAccountLogin(agent: CliAccountAgent, executable: string, env: Record<string,string|undefined>, prefix: string[]): CliAccountLogin {
  const child: ChildProcess = spawn(executable, [...prefix, ...(agent === 'codex' ? ['login'] : ['auth','login','--claudeai'])],
    {env, cwd: agent === 'codex' ? env.CODEX_HOME : env.CLAUDE_CONFIG_DIR, detached: process.platform !== 'win32', stdio: ['ignore','pipe','pipe']});
  let done = false, stopping = false, bytes = 0;
  const signal = (hard: boolean) => {
    if (!child.pid) return;
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(child.pid), '/T', ...(hard ? ['/F'] : [])], {timeout: 5000, windowsHide: true}, () => {});
    } else try { process.kill(-child.pid, hard ? 'SIGKILL' : 'SIGTERM'); } catch { /* gone */ }
  };
  let settle!: (ok: boolean) => void;
  const finished = new Promise<boolean>(resolve => {settle = resolve;});
  const finish = (ok: boolean) => {
    if (done) return;
    done = true; clearTimeout(timeout); clearTimeout(hardStop); signal(true); settle(ok && !stopping);
  };
  let hardStop: ReturnType<typeof setTimeout> | undefined;
  const stop = async () => {
    if (!done && !stopping) { stopping = true; signal(false); hardStop = setTimeout(() => { signal(true); finish(false); }, 1000); }
    await finished;
  };
  const timeout = setTimeout(() => {void stop();}, 10 * 60_000);
  const discard = (chunk: Buffer) => {bytes += chunk.length; if (bytes > 65_536) void stop();};
  child.stdout?.on('data', discard); child.stderr?.on('data', discard);
  child.on('error', () => finish(false)); child.on('exit', code => finish(code === 0));
  return {finished, stop};
}
export class CliAccountManager {
  readonly store: CliAccountStore;
  #status = new Map<string, Pick<CliAccountSummary,'authState'|'checkedAt'|'loginState'>>();
  #login: {id: string; run: CliAccountLogin; completion: Promise<void>} | null = null;
  #closed = false;
  #admissions = new WorkroomRequestLedger<{fingerprint: string; result: Promise<CliAccountSummary[]>}>({maxEntries: 512, ttlMs: 24 * 60 * 60_000});
  constructor(private readonly deps: CliAccountManagerDependencies) { this.store = deps.store; }
  list(agent: CliAccountAgent): CliAccountSummary[] {
    return [{id: HOST_CLI_ACCOUNT_ID, agent, label: '현재 CLI 계정', authState: 'unknown', checkedAt: null, loginState: 'idle'},
      ...this.store.profiles(agent).map(p => ({id: p.id, agent, label: p.label, ...(this.#status.get(p.id) ?? {authState: 'unknown' as const, checkedAt: null, loginState: 'idle' as const})}))];
  }
  selection(target: string, agent: CliAccountAgent): CliAccountSelection { return {agent, items: this.list(agent), selectedAccountId: this.store.selected(target, agent)}; }
  /** Host-only roots for existing opted-in transcript observers. Never returned by manage/list. */
  transcriptDirectories(agent: CliAccountAgent): string[] {
    try {return this.store.profiles(agent).flatMap(p=>{try{return [join(this.store.directory(p.id),agent==='codex'?'sessions':'projects')];}catch{return [];}});} catch {return [];}
  }
  #environment(id: string, base = this.deps.env ?? process.env) {
    const record = this.store.record(id), directory = this.store.directory(id);
    const env = cliAccountEnvironment(record.agent, directory, base);
    // Codex's supported file store is scoped to CODEX_HOME. Never copy the host's auth cache or
    // assume a different HOME isolates the OS Keychain. Private 0700 directories/0600 files guard it.
    const args = record.agent === 'codex' ? ['-c','cli_auth_credentials_store="file"','-c',`log_dir=${JSON.stringify(join(directory,'logs'))}`] : [];
    return {record, env, args};
  }
  async check(id: string) {
    if (this.#closed) throw new Error('계정 관리가 종료 중입니다.');
    const {record, env, args} = this.#environment(id), executable = this.deps.executable(record.agent);
    const state = executable && isAbsolute(executable) ? await (this.deps.probe ?? probe)(record.agent, executable, env, args).catch(() => 'unknown' as const) : 'unknown';
    this.store.directory(id); // Bracket the probe with the same filesystem/account binding.
    const status = {authState: state, checkedAt: new Date().toISOString(), loginState: this.#login?.id === id ? 'authenticating' as const : this.#status.get(id)?.loginState ?? 'idle' as const};
    this.#status.set(id, status); return state;
  }
  async launch(target: string, agent: CliAccountAgent, requestedId: string | undefined, base: Record<string,string|undefined>): Promise<CliAccountLaunch> {
    const id = requestedId ?? this.store.selected(target, agent);
    if (id === HOST_CLI_ACCOUNT_ID) return {accountId: id, label: '현재 CLI 계정', env: {...base}, args: []};
    const {record, env, args} = this.#environment(id, base);
    if (record.agent !== agent) throw new Error('선택한 CLI와 계정이 일치하지 않습니다.');
    if (this.#login?.id === id) throw new Error('이 계정의 로그인을 먼저 완료하세요.');
    if (await this.check(id) !== 'signed-in') throw new Error('선택한 계정의 로그인을 확인하지 못했습니다. Mac의 계정 관리에서 로그인 상태를 확인하세요.');
    this.validateLaunch(id);
    return {accountId: id, label: record.label, env, args};
  }
  /** Called synchronously immediately before PTY spawn, closing the login/archive versus launch race. */
  validateLaunch(id: string) {
    if (this.#closed || this.#login?.id === id) throw new Error('이 계정의 로그인을 먼저 완료하세요.');
    if (id !== HOST_CLI_ACCOUNT_ID) this.store.directory(id);
  }
  async select(target: string, agent: CliAccountAgent, id: string, requestId: string, owner = 'local', authorized = () => true) {
    if (id !== HOST_CLI_ACCOUNT_ID) {
      const p = this.store.record(id);
      if (p.agent !== agent) throw new Error('선택한 CLI와 계정이 일치하지 않습니다.');
      if (await this.check(id) !== 'signed-in') throw new Error('이 계정의 공식 로그인을 먼저 완료하세요.');
    }
    if (!authorized()) throw new Error('계정 선택 권한이 해제되었습니다.');
    await this.store.select(target, agent, id, requestId, owner, authorized);
    return this.selection(target, agent);
  }
  async manage(value: unknown): Promise<CliAccountSummary[]> {
    if (this.#closed) throw new Error('계정 관리가 종료 중입니다.');
    const r = normalizeCliAccountAdminRequest(value);
    if (r.operation === 'list') return this.list(r.agent);
    const fingerprint = JSON.stringify(r), old = this.#admissions.get(r.requestId);
    if (old) { if (old.fingerprint !== fingerprint) throw new Error('같은 요청 ID에 다른 계정 동작을 보낼 수 없습니다.'); return old.result; }
    if (this.#admissions.size >= 512) throw new Error('계정 요청 한도에 도달했습니다. 잠시 후 다시 시도하세요.');
    const result = this.#manage(r);
    this.#admissions.set(r.requestId, {fingerprint, result}); return result;
  }
  async #manage(r: Exclude<CliAccountAdminRequest,{operation:'list'}>): Promise<CliAccountSummary[]> {
    if (r.operation === 'create') { await this.store.create(r.agent, r.label, r.requestId); return this.list(r.agent); }
    const record = this.store.record(r.accountId);
    if (r.operation === 'check') await this.check(r.accountId);
    if (r.operation === 'rename' || r.operation === 'archive') await this.store.edit(r.accountId, r.operation === 'rename' ? r.label : null, r.requestId,
      () => this.#login?.id === r.accountId || !!this.deps.inUse?.(r.accountId));
    if (r.operation === 'cancel-login' && this.#login?.id === r.accountId) { const login = this.#login; await login.run.stop(); await login.completion; }
    if (r.operation === 'login') {
      if (this.#login) throw new Error('진행 중인 공식 로그인을 완료하거나 취소하세요.');
      if (this.deps.inUse?.(r.accountId)) throw new Error('이 계정으로 실행 중인 작업을 종료한 뒤 다시 로그인하세요.');
      const {env, args} = this.#environment(r.accountId), executable = this.deps.executable(record.agent);
      if (!executable || !isAbsolute(executable)) throw new Error('이 CLI가 설치되어 있지 않습니다.');
      // Native CLI credential writes use their own protected-file implementation.
      const path = this.store.directory(r.accountId);
      if (record.agent === 'codex') {
        const logs = join(path,'logs');
        try {mkdirSync(logs,{mode:0o700});} catch (e:any) {if(e.code!=='EEXIST')throw e;}
        const s = lstatSync(logs);
        if (!s.isDirectory() || s.isSymbolicLink() || process.platform !== 'win32' && s.mode & 0o077) throw new Error('계정 로그인 출력 폴더를 확인하세요.');
      }
      const run = (this.deps.login ?? startCliAccountLogin)(record.agent, executable, env, args);
      this.#status.set(r.accountId,{authState:'unknown',checkedAt:null,loginState:'authenticating'});
      const entry = {id: r.accountId, run, completion: Promise.resolve()}; this.#login = entry;
      entry.completion = run.finished.then(async ok => {
        // A cancel/failed login never reports success just because older credentials still exist.
        if (this.#login !== entry) return;
        this.#login = null;
        try {
          this.store.directory(r.accountId);
          this.#status.set(r.accountId,{authState:'unknown',checkedAt:null,loginState:ok?'idle':'failed'});
          if (ok && !this.#closed) await this.check(r.accountId);
        } catch { this.#status.set(r.accountId,{authState:'unknown',checkedAt:null,loginState:'failed'}); }
      }, () => { if (this.#login === entry) {this.#login=null; this.#status.set(r.accountId,{authState:'unknown',checkedAt:null,loginState:'failed'});} });
    }
    return this.list(record.agent);
  }
  async shutdown() {this.#closed = true; const login = this.#login; if (login) {await login.run.stop(); await login.completion;} }
}
