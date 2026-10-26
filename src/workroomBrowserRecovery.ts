import {Database} from 'bun:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import type {BrowserWorkspace,BrowserActionState} from './workroomBrowserProtocol';

/** `pageId` is the tab the task last worked in. From `matching` and `unresolved`, `unknown` counts only the unknown
 * actions that ran in the asked-about tab; from `list` and `get`, every unknown action of the task. */
export type BrowserRecovery={id:string;targetId:string;sessionId:string;profileId:string;profileName:string;source:'owned'|'chrome';pageId:string|null;updatedAt:number;unknown:number};
export type SavedBrowserReceipt={id:string;fingerprint:string;state:BrowserActionState};
/** An unknown action of a task in tab `?2`: one recorded in that tab, or (recorded before receipts named their tab,
 * when a task had one tab) one of a task whose tab it is. */
const UNKNOWN_IN_PAGE=`(SELECT COUNT(*) FROM browser_receipts r WHERE r.taskId=t.id AND r.state='unknown' AND (r.pageId=?2 OR r.pageId IS NULL AND t.pageId=?2))`;
/** Local metadata only: no URLs, page contents, input text, credentials, grants or CDP ports. */
export class WorkroomBrowserRecovery {
 private db:Database;
 constructor(path:string){
  if(path!==':memory:')mkdirSync(dirname(path),{recursive:true,mode:0o700});
  this.db=new Database(path,{create:true});
  if(path!==':memory:')chmodSync(path,0o600);
  this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
   CREATE TABLE IF NOT EXISTS browser_tasks(id TEXT PRIMARY KEY,targetId TEXT NOT NULL,sessionId TEXT NOT NULL,profileId TEXT NOT NULL,profileName TEXT NOT NULL,source TEXT NOT NULL,pageId TEXT,updatedAt INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS browser_receipts(taskId TEXT NOT NULL,id TEXT NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(taskId,id));`);
  // A task of a tab set acts in several tabs, so every receipt keeps the tab it was dispatched in. Older rows have none.
  if(!(this.db.query('PRAGMA table_info(browser_receipts)').all() as {name:string}[]).some(c=>c.name==='pageId'))this.db.exec('ALTER TABLE browser_receipts ADD COLUMN pageId TEXT');
 }
 list(targetId:string):BrowserRecovery[]{return this.db.query(`SELECT t.*, (SELECT COUNT(*) FROM browser_receipts r WHERE r.taskId=t.id AND r.state='unknown') AS unknown FROM browser_tasks t WHERE targetId=? ORDER BY updatedAt DESC LIMIT 32`).all(targetId) as BrowserRecovery[];}
 get(id:string):BrowserRecovery|undefined{return this.db.query(`SELECT t.*, (SELECT COUNT(*) FROM browser_receipts r WHERE r.taskId=t.id AND r.state='unknown') AS unknown FROM browser_tasks t WHERE id=?`).get(id) as BrowserRecovery|null??undefined;}
 /** The latest task of this profile that worked in this tab: its current tab, or a tab one of its actions ran in. */
 matching(profileId:string,pageId:string):BrowserRecovery|undefined{return this.db.query(`SELECT t.*, ${UNKNOWN_IN_PAGE} AS unknown FROM browser_tasks t WHERE t.profileId=?1 AND (t.pageId=?2 OR EXISTS(SELECT 1 FROM browser_receipts r WHERE r.taskId=t.id AND r.pageId=?2)) ORDER BY t.updatedAt DESC LIMIT 1`).get(profileId,pageId) as BrowserRecovery|null??undefined;}
 /** The latest task of this profile, other than `except`, with an unknown action in this tab — in any project. No
 * later task's record of the same tab hides it. */
 unresolved(profileId:string,pageId:string,except?:string):BrowserRecovery|undefined{return this.db.query(`SELECT * FROM (SELECT t.*, ${UNKNOWN_IN_PAGE} AS unknown FROM browser_tasks t WHERE t.profileId=?1 AND t.id IS NOT ?3) WHERE unknown>0 ORDER BY updatedAt DESC LIMIT 1`).get(profileId,pageId,except??null) as BrowserRecovery|null??undefined;}
 save(w:BrowserWorkspace,id=w.id){
  const exists=this.get(id);
  if(!exists&&(this.db.query('SELECT COUNT(*) AS n FROM browser_tasks').get() as {n:number}).n>=128)throw Error('Browser recovery history is full. Review unfinished tasks before adding more.');
  this.db.query(`INSERT INTO browser_tasks VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET sessionId=excluded.sessionId,pageId=COALESCE(excluded.pageId,browser_tasks.pageId),updatedAt=excluded.updatedAt`).run(id,w.targetId,w.sessionId,w.profileId,w.profileName,w.source??'chrome',w.page?.id??null,Date.now());
 }
 receipts(id:string):SavedBrowserReceipt[]{return this.db.query('SELECT id,fingerprint,state FROM browser_receipts WHERE taskId=? ORDER BY rowid LIMIT 128').all(id) as SavedBrowserReceipt[];}
 /** `pageId` is the tab the action is dispatched in; a later state change keeps the tab it was first recorded with. */
 record(taskId:string,r:SavedBrowserReceipt,pageId?:string|null){
  this.db.transaction(()=>{
   if(!this.get(taskId))throw Error('Recovery record missing.');
   const prior=this.db.query('SELECT fingerprint,state FROM browser_receipts WHERE taskId=? AND id=?').get(taskId,r.id) as SavedBrowserReceipt|undefined;
   if(prior&&prior.fingerprint!==r.fingerprint)throw Error('Request ID reused with different input.');
   if(prior&&r.state==='unknown')throw Error('Recorded requests cannot be dispatched again.');
   if(prior?.state==='reviewed'&&r.state!=='reviewed')throw Error('Reviewed requests cannot be replayed.');
   this.db.query(`INSERT INTO browser_receipts(taskId,id,fingerprint,state,pageId) VALUES(?,?,?,?,?) ON CONFLICT(taskId,id) DO UPDATE SET state=excluded.state,pageId=COALESCE(browser_receipts.pageId,excluded.pageId)`).run(taskId,r.id,r.fingerprint,r.state,pageId??null);
   this.db.query('UPDATE browser_tasks SET updatedAt=? WHERE id=?').run(Date.now(),taskId);
  })();
 }
 close(){this.db.close();}
}
