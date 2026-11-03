import {test,expect} from 'bun:test';
import {resolve} from 'node:path';
test('actual workerd APNs advisory and explicit mobile management integration',async()=>{
 const root=resolve(import.meta.dir,'..');const child=Bun.spawn([process.execPath,'cloud/screen-community/tests/access-notifications-worker.mjs'],{cwd:root,stdin:'ignore',stdout:'pipe',stderr:'pipe'});
 const timer=setTimeout(()=>child.kill(),60_000);
 try{const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);expect({code,output:out+'\n'+err}).toMatchObject({code:0});expect(out).toContain('PASS: actual workerd/SQLite');}
 finally{clearTimeout(timer);}
},70_000);
