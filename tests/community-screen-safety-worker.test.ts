import {test,expect} from 'bun:test';
import {resolve} from 'node:path';
test('actual workerd/SQLite common Screen safety end-to-end with software identities and APNs interception',async()=>{
 const child=Bun.spawn([process.execPath,'cloud/screen-community/tests/screen-safety-worker.mjs'],{cwd:resolve(import.meta.dir,'..'),stdin:'ignore',stdout:'pipe',stderr:'pipe'}),timer=setTimeout(()=>child.kill(),60_000);
 try{const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);expect({code,output:out+'\n'+err}).toMatchObject({code:0});expect(out).toContain('PASS: actual workerd/SQLite common-only safety');}finally{clearTimeout(timer);}
},70_000);
