import {constants,openSync,closeSync,fstatSync,readSync,lstatSync,realpathSync} from 'node:fs';
import {isAbsolute,relative,dirname,sep} from 'node:path';
import {Database,constants as sqlite} from 'bun:sqlite';
import {createHash} from 'node:crypto';
import type {RecoveryAgent,RecoverySource} from './preCompactionRecovery';
import {saveToken} from './memorySaveContract';
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const same=(a:ReturnType<typeof fstatSync>,b:ReturnType<typeof fstatSync>)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;

/** Provider metadata and hook stdout are not the conversation to recover. Keep
 * original JSONL bytes, but end the fragment at the latest real message. */
function conversationalRecord(agent:RecoveryAgent,row:any):boolean {
  if(agent==='claude'){
    if(!['user','assistant'].includes(row.type)||row.isMeta===true||row.isCompactSummary===true||row.repeatsCompactSummary===true)return false;
    const content=row.message?.content;
    const localCommand=(text:string)=>/^(?:\/compact(?:\s|$)|<(?:local-command-(?:stdout|stderr|caveat)|command-name|command-message)>)/.test(text.trim());
    if(typeof content==='string')return !!content.trim()&&!(row.type==='user'&&localCommand(content));
    return Array.isArray(content)&&content.some((block:any)=>['text','image','tool_use'].includes(block?.type))
      &&!(row.type==='user'&&content.every((block:any)=>block?.type==='text')&&localCommand(content.map((block:any)=>block.text??'').join('\n')));
  }
  if(agent==='codex'){
    if(row.type==='event_msg'&&['user_message','agent_message'].includes(row.payload?.type))
      return typeof row.payload.message==='string'&&!!row.payload.message.trim()&&!(row.payload.type==='user_message'&&/^\/compact(?:\s|$)/.test(row.payload.message.trim()));
    const message=row.payload;
    return row.type==='response_item'&&message?.type==='message'&&['user','assistant'].includes(message.role)
      &&Array.isArray(message.content)&&message.content.some((block:any)=>['input_text','output_text','input_image'].includes(block?.type))
      &&!(message.role==='user'&&message.content.every((block:any)=>block?.type==='input_text')&&/^\/compact(?:\s|$)/.test(message.content.map((block:any)=>block.text??'').join('\n').trim()));
  }
  return false;
}

/** A bounded exact fragment, not a claim to have retained the whole turn. The
 * caller chooses only a host-derived provider path, never an HTTP-supplied path. */
export function readRecoveryJsonl(input:{agent:Exclude<RecoveryAgent,'hermes'>;sessionId:string;cwd:string;path:string;providerRoot:string;hookWorkspace?:string}):RecoverySource {
  if(!saveToken(input.sessionId)||![input.path,input.cwd,input.providerRoot].every(isAbsolute))throw Error('복구 원본 신원이 올바르지 않습니다.');
  const root=realpathSync(input.providerRoot),parent=realpathSync(dirname(input.path)),cwd=realpathSync(input.cwd),rel=relative(root,parent);
  if(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))throw Error('제공자의 원본 폴더 밖입니다.');
  const fd=openSync(input.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  let bytes:Buffer|undefined;
  try{
    const before=fstatSync(fd);if(!before.isFile()||before.nlink!==1||before.size<1)throw Error('복구 원본 파일을 확인할 수 없습니다.');
    const read=(start:number,size:number)=>{const value=Buffer.alloc(size);let at=0;while(at<size){const n=readSync(fd,value,at,size-at,start+at);if(!n)throw Error('복구 원본이 변경되었습니다.');at+=n;}return value;};
    const head=read(0,Math.min(before.size,256*1024));
    // Antigravity's documented hook carries workspacePaths; current transcript
    // records contain steps only. Record that weaker provenance explicitly.
    let owned=input.agent==='agy'&&input.hookWorkspace!==undefined&&realpathSync(input.hookWorkspace)===cwd;
    try{
      const end=head.lastIndexOf(10);
      for(const line of new TextDecoder('utf-8',{fatal:true}).decode(head.subarray(0,end+1)).split('\n')){
        if(!line.trim())continue;
        const row=JSON.parse(line);
        if(input.agent==='codex'){
          const meta=row.payload;
          if(row.type!=='session_meta'||meta?.id!==input.sessionId||!['cli','vscode'].includes(meta.source)
            ||meta.session_id!==undefined&&meta.session_id!==input.sessionId
            ||meta.thread_source==='subagent'||meta.thread_source&&typeof meta.thread_source==='object')throw Error('원래 주 대화를 확인하지 못했습니다.');
          owned=typeof meta.cwd==='string'&&realpathSync(meta.cwd)===cwd;break;
        }
        if(input.agent==='claude'&&row.sessionId===input.sessionId&&row.isSidechain!==true&&typeof row.cwd==='string'){
          owned=realpathSync(row.cwd)===cwd;break;
        }
        if(input.agent==='agy'&&row.conversationId===input.sessionId&&Array.isArray(row.workspacePaths)){
          // Multiple mounted workspaces are ambiguous for project memory.
          owned=row.workspacePaths.length===1&&typeof row.workspacePaths[0]==='string'&&realpathSync(row.workspacePaths[0])===cwd;break;
        }
      }
    }finally{head.fill(0);}
    if(!owned)throw Error('원본 대화와 등록 프로젝트의 정확한 연결을 확인하지 못했습니다.');
    // Actual Claude hooks can append several 300KiB rows after one answer.
    // Keep the read bounded independently of the unchanged 32KB encrypted fragment.
    const lookback=input.agent==='claude'?2*1024*1024:256*1024;
    const from=Math.max(0,before.size-lookback),tail=read(from,before.size-from);
    try{
      let start=from===0?0:tail.indexOf(10)+1,end=tail.lastIndexOf(10)+1;
      if(start<=0&&from>0||end<=start)throw Error('완전한 복구 기록이 32KB 범위 안에 없습니다.');
      const text=new TextDecoder('utf-8',{fatal:true}).decode(tail.subarray(start,end));
      let offset=start,lastMessageEnd:number|undefined,lastMessageSize=0;
      const boundaries=[start];
      for(const line of text.split('\n').slice(0,-1)){
        if(!line.trim()){offset+=Buffer.byteLength(line)+1;boundaries.push(offset);continue;}
        const row=JSON.parse(line);
        if(input.agent==='codex'&&row.type==='turn_context'&&typeof row.payload?.cwd==='string'&&realpathSync(row.payload.cwd)!==cwd)throw Error('복구 구간의 작업 폴더가 바뀌었습니다.');
        if(input.agent==='claude'&&(row.sessionId!==undefined&&row.sessionId!==input.sessionId||row.isSidechain===true||typeof row.cwd==='string'&&realpathSync(row.cwd)!==cwd))throw Error('복구 구간의 대화 결속이 바뀌었습니다.');
        offset+=Buffer.byteLength(line)+1;boundaries.push(offset);
        if(conversationalRecord(input.agent,row)){
          lastMessageEnd=offset;lastMessageSize=Buffer.byteLength(line)+1;
        }
      }
      if(input.agent!=='agy'){
        if(lastMessageEnd===undefined)throw Error('복구 범위에서 실제 대화 기록을 확인하지 못했습니다.');
        if(lastMessageSize>32_000)throw Error('최신 대화 원본이 복구 입력 한도를 초과했습니다.');
        end=lastMessageEnd;
      }
      start=boundaries.find(position=>position>=end-32_000&&position<end)??end;
      if(end<=start)throw Error('완전한 복구 기록이 32KB 범위 안에 없습니다.');
      bytes=Buffer.from(tail.subarray(start,end));
      if(!same(before,fstatSync(fd))||!same(before,lstatSync(input.path))||realpathSync(dirname(input.path))!==parent)throw Error('복구 원본이 변경되었습니다.');
      return {agent:input.agent,sessionId:input.sessionId,bytes,sourceDigest:hash(bytes),start:from+start,end:from+end,
        verification:input.agent==='agy'?'provider-hook-workspace':'transcript-cwd'};
    }finally{tail.fill(0);}
  }catch(error){bytes?.fill(0);throw error;}finally{closeSync(fd);}
}

/** Hermes keeps its own cwd-bound original messages in SQLite. Read one
 * consistent transaction without assuming accumulated token totals are context
 * usage. A large newest record pauses capture instead of silently skipping it. */
export function readHermesRecovery(input:{sessionId:string;cwd:string;databasePath:string}):RecoverySource {
  if(!saveToken(input.sessionId)||!isAbsolute(input.databasePath)||!isAbsolute(input.cwd))throw Error('Hermes 복구 신원이 올바르지 않습니다.');
  const stat=lstatSync(input.databasePath);if(!stat.isFile()||stat.isSymbolicLink())throw Error('Hermes 원본 DB를 확인하지 못했습니다.');
  const db=new Database(input.databasePath,sqlite.SQLITE_OPEN_READONLY|sqlite.SQLITE_OPEN_NOFOLLOW);
  try{
    db.run('PRAGMA busy_timeout=100');db.run('PRAGMA cache_size=-256');
    return db.transaction(()=>{
      const session=db.query('SELECT id,cwd FROM sessions WHERE id=?').get(input.sessionId) as {id:string;cwd:string|null}|null;
      if(!session?.cwd||realpathSync(session.cwd)!==realpathSync(input.cwd))throw Error('Hermes 대화의 프로젝트가 다릅니다.');
      const records=db.query('SELECT id,length(CAST(content AS BLOB)) AS size FROM messages WHERE session_id=? ORDER BY id DESC LIMIT 64').all(input.sessionId) as {id:number;size:number}[];
      const rows:unknown[]=[];let first=0,last=0;
      for(const record of records){
        if(record.size>30_000){if(!rows.length)throw Error('Hermes의 최신 원본이 복구 입력 한도를 초과했습니다.');break;}
        const row=db.query('SELECT id,role,content,timestamp FROM messages WHERE id=? AND session_id=?').get(record.id,input.sessionId);
        if(!row)throw Error('Hermes 원본이 변경되었습니다.');
        if(Buffer.byteLength(JSON.stringify({agent:'hermes',sessionId:input.sessionId,messages:[row,...rows]}))>32_000)break;
        rows.unshift(row);first=record.id;if(!last)last=record.id;
      }
      if(!rows.length)throw Error('Hermes 복구 원본이 없습니다.');
      const bytes=Buffer.from(JSON.stringify({agent:'hermes',sessionId:input.sessionId,messages:rows}));
      return {agent:'hermes' as const,sessionId:input.sessionId,bytes,sourceDigest:hash(bytes),start:first,end:last+1,verification:'provider-db-cwd' as const};
    })();
  }finally{db.close();}
}
