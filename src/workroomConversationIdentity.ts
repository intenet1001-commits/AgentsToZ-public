import { createHash } from 'node:crypto';
import { constants, lstatSync, fstatSync, realpathSync, readFileSync, openSync, readSync, closeSync, opendirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { claudeProjectSlugCandidates } from './sessionTranscript';
import { codexRolloutMeta } from './aiTerminalResume';
import type { AiTerminalSummary } from './aiTerminalProtocol';
import type { WorkroomSessionContext } from './workroomConversationHost';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function identity(path: string) {
  const canonical = realpathSync(path), s = lstatSync(canonical);
  if (!s.isDirectory()) throw new Error('원래 CLI 설정 또는 프로젝트 폴더를 확인하세요.');
  return [canonical, s.dev, s.ino];
}
export function workroomTargetFingerprint(cwd: string): string {
  const root = realpathSync(cwd), marker = join(root, '.git');
  let git: unknown = null;
  try {
    const s = lstatSync(marker);
    let gitDir = marker;
    if (s.isFile()) {
      if (s.size > 4096) throw new Error('Git 연결을 확인하세요.');
      const match = /^gitdir: (.+)\s*$/.exec(readFileSync(marker, 'utf8'));
      if (!match) throw new Error('Git 연결을 확인하세요.');
      gitDir = resolve(root, match[1]!);
    }
    const canonical = realpathSync(gitDir);
    let common = canonical;
    try {
      const p = join(canonical, 'commondir'), st = lstatSync(p);
      if (!st.isFile() || st.size > 4096) throw new Error('Git 연결을 확인하세요.');
      common = resolve(canonical, readFileSync(p, 'utf8').trim());
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    git = [identity(canonical), identity(common)];
  } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  return hash([identity(root), git]);
}
/** Hash only file metadata and effective authentication configuration; never read credential contents. */
export function workroomSessionContext(summary: AiTerminalSummary, cwd: string, env: Record<string,string|undefined>, restricted: boolean, providerConversationId?: string): WorkroomSessionContext {
  const home = env.HOME || homedir();
  const providerHome = summary.agent === 'codex' ? env.CODEX_HOME || join(home, '.codex')
    : summary.agent === 'claude' ? env.CLAUDE_CONFIG_DIR || join(home, '.claude') : home;
  let directory: unknown;
  try { directory = identity(providerHome); } catch { directory = ['unavailable', resolve(providerHome)]; }
  const authFiles = ['auth.json', '.credentials.json'].map(name => {
    try { const p = join(providerHome, name), s = lstatSync(p); return [name, s.dev, s.ino, s.size, s.mtimeMs, s.isSymbolicLink()]; }
    catch (error: any) { return [name, error.code === 'ENOENT' ? 'absent' : 'unavailable']; }
  });
  const authConfig = Object.keys(env).filter(k => /^(OPENAI_|ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN$)/.test(k)).sort().map(k => [k, env[k]]);
  return { summary: { ...summary }, cwd: realpathSync(cwd), providerHome,
    accountFingerprint: hash([summary.agent, summary.accountId ?? 'host-default', directory, authFiles, authConfig]),
    targetFingerprint: workroomTargetFingerprint(cwd), restricted, ...(providerConversationId ? { providerConversationId } : {}) };
}
function containsUserTurn(path: string, agent: 'codex' | 'claude') {
  let fd: number | undefined;
  try {
    const s = lstatSync(path);
    if (!s.isFile() || s.isSymbolicLink()) return false;
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW??0));
    const opened=fstatSync(fd);if(!opened.isFile()||opened.dev!==s.dev||opened.ino!==s.ino)return false;
    const bytes = Buffer.alloc(Math.min(s.size, 4 * 1024 * 1024));
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    for (const line of bytes.subarray(0, count).toString('utf8').split('\n')) {
      try {
        const r = JSON.parse(line);
        if (agent === 'claude' ? r.type === 'user' : r.type === 'event_msg' && r.payload?.type === 'user_message' || r.type === 'response_item' && r.payload?.role === 'user') return true;
      } catch { /* A partial line is not evidence. */ }
    }
    return false;
  } finally { if (fd !== undefined) closeSync(fd); }
}
/** Bounded read-only proof of the exact saved conversation; paths remain host-only. */
export function savedWorkroomConversation(agent: string, providerHome: string, cwd: string, id: string): string | null {
  if (!isAbsolute(providerHome) || !/^[A-Za-z0-9_-]{8,160}$/.test(id)) return null;
  if (agent === 'claude') {
    for (const slug of claudeProjectSlugCandidates(cwd)) {
      const path = join(providerHome, 'projects', slug, id + '.jsonl');
      try { if (containsUserTurn(path, 'claude')) return path; } catch { /* Unavailable is not verified. */ }
    }
    return null;
  }
  if (agent !== 'codex' || !/^[0-9a-f-]{36}$/.test(id)) return null;
  let visited = 0;
  const names = (dir: string,maximum:number):string[] => {
    let stream:ReturnType<typeof opendirSync>|undefined;
    try {stream=opendirSync(dir);const rows:string[]=[];for(let entry=stream.readSync();entry;entry=stream.readSync()){if(rows.length>=maximum)return[];rows.push(entry.name);}return rows;}
    catch{return[];}finally{stream?.closeSync();}
  };
  const children = (dir: string,maximum:number) => {const rows=names(dir,maximum+64).filter(n=>/^\d+$/.test(n));return rows.length<=maximum?rows.sort().reverse():[];};
  const root = join(providerHome, 'sessions');
  for (const y of children(root,100)) for (const m of children(join(root,y),12)) for (const d of children(join(root,y,m),31)) {
    if (++visited > 10_000) return null;
    const dir = join(root,y,m,d);
    const name = names(dir,20_000).find(n => n.startsWith('rollout-') && n.endsWith('-' + id + '.jsonl'));
    if (!name) continue;
    const path = join(dir,name), meta = codexRolloutMeta(path);
    if (!meta || meta.id !== id || meta.cwd !== cwd || !meta.interactiveCli) return null;
    try { return containsUserTurn(path, 'codex') ? path : null; } catch { return null; }
  }
  return null;
}
