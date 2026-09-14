import { Database, constants } from 'bun:sqlite';
import { chmodSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { MemorySaveError, saveHash, saveInteger } from './memorySaveContract';

export interface MemoryObservationCursor {
  offset:number;
  snapshotSize:number;
  dev:number;
  ino:number;
  birthtimeMs:number;
  mtimeMs:number;
  ctimeMs:number;
  headEnd:number;
  headHash:string;
  anchorStart:number;
  anchorHash:string;
}
export interface StoredMemoryObservationCursor { revision:number; cursor:MemoryObservationCursor }
export function canonicalObservationCursor(raw:MemoryObservationCursor):MemoryObservationCursor {
  if(!raw || ![raw.offset,raw.snapshotSize,raw.dev,raw.ino,raw.headEnd,raw.anchorStart].every(saveInteger)
    || ![raw.birthtimeMs,raw.mtimeMs,raw.ctimeMs].every(n=>typeof n==='number' && Number.isFinite(n) && n>=0)
    || raw.offset>raw.snapshotSize || raw.offset<raw.headEnd || raw.headEnd<1 || raw.headEnd>256*1024
    || raw.anchorStart>=raw.offset || raw.offset-raw.anchorStart>4096
    || ![raw.headHash,raw.anchorHash].every(saveHash))throw new MemorySaveError('INVALID_INPUT');
  return {offset:raw.offset,snapshotSize:raw.snapshotSize,dev:raw.dev,ino:raw.ino,birthtimeMs:raw.birthtimeMs,
    mtimeMs:raw.mtimeMs,ctimeMs:raw.ctimeMs,headEnd:raw.headEnd,headHash:raw.headHash,
    anchorStart:raw.anchorStart,anchorHash:raw.anchorHash};
}
/** Rebuildable discovery progress only. Execution fences live in MemorySaveStore.
 * Observations must commit before this CAS. Failure between them replays observations
 * idempotently; a stale observer cannot move a newer cursor backwards. No source paths/body. */
export class MemoryObservationCursorStore {
  constructor(readonly path:string) {}
  #db<T>(run:(db:Database)=>T):T {
    let db:Database|undefined;
    try {
      mkdirSync(dirname(this.path),{recursive:true,mode:0o700});
      const path=join(realpathSync(dirname(this.path)),basename(this.path));
      db=new Database(path,constants.SQLITE_OPEN_READWRITE|constants.SQLITE_OPEN_CREATE|constants.SQLITE_OPEN_NOFOLLOW);
      if(process.platform!=='win32')chmodSync(path,0o600);
      db.run('PRAGMA busy_timeout=100');db.run('PRAGMA synchronous=FULL');db.run('PRAGMA cache_size=-256');
      const version=(db.query('PRAGMA user_version').get() as {user_version:number}).user_version;
      if(version>1)throw new MemorySaveError('UNSUPPORTED_VERSION');
      if(version===0)db.transaction(()=>{
        db!.run('CREATE TABLE cursors (key TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL)');
        db!.run('PRAGMA user_version=1');
      }).immediate();
      return run(db);
    }catch(error){if(error instanceof MemorySaveError)throw error;throw new MemorySaveError('STORAGE_UNAVAILABLE');}
    finally{db?.close();}
  }
  get(key:string):StoredMemoryObservationCursor|null {
    if(!saveHash(key))throw new MemorySaveError('INVALID_INPUT');
    return this.#db(db=>{
      const row=db.query('SELECT revision,CASE WHEN length(payload)<=4096 THEN payload ELSE NULL END AS payload FROM cursors WHERE key=?').get(key) as {revision:number;payload:string|null}|null;
      if(!row)return null;
      if(!saveInteger(row.revision)||row.revision<1||!row.payload)throw new MemorySaveError('STORAGE_UNAVAILABLE');
      return {revision:row.revision,cursor:canonicalObservationCursor(JSON.parse(row.payload))};
    });
  }
  advance(key:string,expectedRevision:number|null,raw:MemoryObservationCursor):void {
    if(!saveHash(key)||(expectedRevision!==null&&(!saveInteger(expectedRevision)||expectedRevision<1||expectedRevision>=Number.MAX_SAFE_INTEGER)))throw new MemorySaveError('INVALID_INPUT');
    const payload=JSON.stringify(canonicalObservationCursor(raw));
    this.#db(db=>{
      const changed=expectedRevision===null
        ? db.query('INSERT OR IGNORE INTO cursors VALUES (?,1,?)').run(key,payload).changes
        : db.query('UPDATE cursors SET revision=revision+1,payload=? WHERE key=? AND revision=?').run(payload,key,expectedRevision).changes;
      if(changed!==1)throw new MemorySaveError('REVISION_CONFLICT');
    });
  }
}
