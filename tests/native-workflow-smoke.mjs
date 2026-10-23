/** Run the existing full-app smoke against changed sources and a disposable profile. */
import {mkdtemp,rm} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'vite';
import {startTestApiServer} from './startTestApiServer.ts';

const root=resolve(import.meta.dirname,'..');
const scratch=await mkdtemp(join(tmpdir(),'agentstoz-native-smoke-'));
const probe=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()});
const webPort=probe.port;probe.stop(true);
let vite,api,smoke;
try{
 for(const key of Object.keys(process.env))if(key.startsWith('VITE_'))delete process.env[key];
 process.env.VITE_SUPABASE_URL='https://workspace-fixture.supabase.co';
 process.env.VITE_SUPABASE_ANON_KEY='fixture-anon-key';
 const started=await startTestApiServer({cwd:root,env:{...process.env,HOME:scratch,APP_DATA_DIR:join(scratch,'app-data'),PORT:String(webPort),NODE_ENV:'test',AGENTSTOZ_SKIP_CONTROL_BOOTSTRAP:'1',AGENTSTOZ_SKIP_OUTPUT_STYLE_SYNC:'1',AGENTSTOZ_SKIP_HERMES_SYNC:'1',PORTMGR_WHAT_I_SAID_TEST_KEY:'41'.repeat(32)}});
 api=started.child;process.env.API_PORT=new URL(started.baseUrl).port;
 vite=await createServer({configFile:join(root,'vite.config.ts'),root,envDir:scratch,cacheDir:join(scratch,'vite-cache'),mode:'maintainer-test',logLevel:'warn',server:{host:'127.0.0.1',port:webPort,strictPort:true,hmr:false,watch:null,fs:{allow:[root,realpathSync(join(root,'node_modules'))]},proxy:{'/api':{target:started.baseUrl,changeOrigin:true}}}});
 await vite.listen();
 smoke=Bun.spawn(['node','tests/smoke.mjs'],{cwd:root,env:{...process.env,TARGET:`http://localhost:${webPort}`,API_PORT:process.env.API_PORT},stdout:'inherit',stderr:'inherit'});
 const code=await smoke.exited;
 if(code!==0)throw Error(`Isolated source smoke failed (${code})`);
 console.log('Existing full-app smoke passed against isolated changed sources; no installed-app evidence.');
}finally{
 if(smoke&&smoke.exitCode===null){smoke.kill();await smoke.exited;}
 await vite?.close();
 if(api){api.kill();await api.exited;}
 await rm(scratch,{recursive:true,force:true});
}
