export interface RegistryStore {
  transaction<T>(body:()=>T):T;
  get<T>(key:string):T|undefined;
  put(key:string,value:unknown,expiresAt?:number):void;
  remove(key:string):void;
  collect(now:number):void;
}

/** SQLite-backed Durable Object storage; all authorization changes and replay receipts share one transaction. */
export class DurableRegistryStore implements RegistryStore {
  constructor(private readonly storage:{sql:{exec(query:string,...args:unknown[]):Iterable<{value:string}>};transactionSync<T>(body:()=>T):T}){
    storage.sql.exec('CREATE TABLE IF NOT EXISTS registry (key TEXT PRIMARY KEY,value TEXT NOT NULL,expires INTEGER)');
    storage.sql.exec('CREATE INDEX IF NOT EXISTS registry_expiry ON registry(expires) WHERE expires IS NOT NULL');
  }
  transaction<T>(body:()=>T):T{return this.storage.transactionSync(body);}
  get<T>(key:string):T|undefined{const row=[...this.storage.sql.exec('SELECT value FROM registry WHERE key=?',key)][0];return row?JSON.parse(row.value) as T:undefined;}
  put(key:string,value:unknown,expiresAt:number|null=null):void{this.storage.sql.exec('INSERT INTO registry(key,value,expires) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires=excluded.expires',key,JSON.stringify(value),expiresAt);}
  remove(key:string):void{this.storage.sql.exec('DELETE FROM registry WHERE key=?',key);}
  collect(now:number):void{this.storage.sql.exec('DELETE FROM registry WHERE key IN (SELECT key FROM registry WHERE expires IS NOT NULL AND expires<? LIMIT 256)',now);}
}
