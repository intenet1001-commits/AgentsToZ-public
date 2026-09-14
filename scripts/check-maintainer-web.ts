/** Owned Vite + synthetic API/browser fixtures only. Never use the running app's API. */
import {mkdtempSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve, sep} from 'node:path';
import {build, createServer, type ViteDevServer} from 'vite';

const root = resolve(import.meta.dir, '..');
const suite = process.argv[2] ?? 'workroom';
if (!['workroom', 'orchestration', 'tester', 'mobile', 'performance'].includes(suite)) throw Error('Unknown web suite');
const temporary = mkdtempSync(join(tmpdir(), 'agentstoz-maintainer-web-'));
const evidence = join(root, '.agentstoz/maintainer');
mkdirSync(evidence, {recursive:true, mode:0o700});
// Never compile a developer's .env into test pages or contact their Supabase.
for (const key of Object.keys(process.env)) if (key.startsWith('VITE_')) delete process.env[key];
process.env.VITE_SUPABASE_URL = 'https://workspace-fixture.supabase.co';
process.env.VITE_SUPABASE_ANON_KEY = 'fixture-anon-key';
const envDir = join(temporary, 'empty-env'); mkdirSync(envDir);
let vite: ViteDevServer | undefined;
let child: ReturnType<typeof Bun.spawn> | undefined;
let staticServer: ReturnType<typeof Bun.serve> | undefined;
const results: {id:string; passed:boolean; durationSeconds:number; exitCode?:number; error?:string}[] = [];
let stopping = false;
const close = async () => {
  if (stopping) return; stopping = true;
  child?.kill(); await vite?.close(); await staticServer?.stop(true);
  rmSync(temporary, {recursive:true, force:true});
};
process.once('SIGTERM', () => { void close().finally(() => process.exit(143)); });
process.once('SIGINT', () => { void close().finally(() => process.exit(130)); });
async function run(id:string, args:string[], extra:Record<string,string> = {}, timeoutMs=240_000) {
  const start=performance.now(); console.log('Fixture start: '+id);
  child=Bun.spawn(args, {cwd:root, env:{...process.env, ...extra}, stdin:'ignore', stdout:'inherit', stderr:'inherit'});
  let timedOut=false;
  const timeout=setTimeout(()=>{timedOut=true;child?.kill();},timeoutMs);
  try {
    const exitCode=await child.exited;
    results.push({id,passed:exitCode===0&&!timedOut,exitCode,durationSeconds:Math.round((performance.now()-start)/100)/10,...(timedOut?{error:'timeout'}:{})});
  } finally {clearTimeout(timeout);child=undefined;}
}
async function portalBuild() {
  const dist=join(temporary,'portal');
  await build({configFile:join(root,'vite.portal.config.ts'),root,envDir,mode:'maintainer-test',
    build:{outDir:dist,emptyOutDir:true},logLevel:'warn'});
  return dist;
}
try {
  if (suite==='workroom'||suite==='orchestration'||suite==='tester') {
    vite=await createServer({configFile:join(root,'vite.config.ts'),root,envDir,mode:'maintainer-test',
      // Keep Vite's dependency URL shape for the fixtures and Babel's vendor
      // exclusion, while owning a different cache from the user's dev server.
      cacheDir:join(temporary,'node_modules/.vite'),logLevel:'warn',
      plugins:[{name:'maintainer-deny-live-api',configureServer(server){server.middlewares.use((req,res,next)=>{
        if(req.url?.startsWith('/api/')){res.statusCode=503;res.end('Unmocked fixture API rejected');return;}next();
      });}}],
      server:{host:'127.0.0.1',port:0,strictPort:false,watch:{ignored:['**/.agentstoz/**','**/mobile/ios/build/**']}}});
    await vite.listen();
    const address=vite.httpServer!.address(); if(!address||typeof address==='string')throw Error('Missing owned fixture address');
    const origin=`http://127.0.0.1:${address.port}`;
    if(address.port===3001)throw Error('Fixture must not use the live API port');
    const environment={WORKROOM_TEST_ORIGIN:origin,WORKROOM_USABILITY_ORIGIN:origin,INTERNET_APPROVAL_TEST_ORIGIN:origin,AI_WORK_REQUEST_ORIGIN:origin};
    if(suite==='tester') {
      await run('project-tester', ['node','tests/project-tester.e2e.mjs'],environment);
    } else if(suite==='workroom') {
      await run('terminal-keyboard', ['node','tests/workroom-input-lifecycle.e2e.mjs'],environment);
      await run('terminal-touch', ['node','tests/workroom-input-lifecycle.e2e.mjs'],{...environment,WORKROOM_TOUCH_TEST:'1'});
      await run('save-before-close', ['node','tests/workroom-session-footer.e2e.mjs'],environment);
      await run('workroom-usability', ['node','tests/workroom-usability.e2e.mjs'],environment);
      await run('terminal-rendering', ['node','tests/workroom-rendering.e2e.mjs'],environment);
      await run('internet-grant-dialog', ['node','tests/internet-workroom-approval.e2e.mjs'],environment);
    } else {
      await run('ai-orchestration', ['node','tests/ai-work-request.e2e.mjs'],environment);
      const dist=join(temporary,'desktop');
      await build({configFile:join(root,'vite.config.ts'),root,envDir,mode:'maintainer-test',
        build:{outDir:dist,emptyOutDir:true},logLevel:'warn'});
      await run('desktop-onboarding-control', ['bun','tests/onboarding-first-project-app-ui.mjs',dist]);
    }
  } else {
    const dist=await portalBuild();
    if(suite==='mobile') {
      const environment={NAV_FIXTURE_DIST:dist};
      await run('mobile-navigation', ['bun','tests/mobile-workspace-ui.mjs'],environment);
      await run('mobile-auth-inventory', ['bun','tests/mobile-navigation-auth-ui.mjs'],environment);
      await run('mobile-login-recovery', ['bun','tests/mobile-login-recovery-ui.mjs'],environment);
      await run('mobile-memory-panel', ['bun','tests/mobile-workspace-panel-ui.mjs'],environment);
      await run('mobile-project-create', ['node','tests/remote-project-create-lan.e2e.mjs'],environment);
    } else {
      staticServer=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
        const pathname=new URL(request.url).pathname;
        const filePath=resolve(dist,'.'+(pathname==='/remote/'?'/remote/index.html':pathname));
        if(!filePath.startsWith(dist+sep))return new Response('',{status:404});
        const file=Bun.file(filePath);return await file.exists()?new Response(file):new Response('',{status:404});
      }});
      await run('mobile-initial-render-cold-warm', ['node','tests/perf-measure.mjs','--url',`http://127.0.0.1:${staticServer.port}/remote/`,
        '--runs','5','--enforce','--offline','--output',join(evidence,'web-performance.json'),'--screenshot',join(evidence,'web-performance.png')]);
    }
  }
} catch(error) {
  results.push({id:'fixture-setup',passed:false,durationSeconds:0,error:error instanceof Error?error.message:'Fixture setup failed'});
} finally { await close(); }
console.log(JSON.stringify({suite,fixtureOnly:true,actualIPhone:false,realAI:false,results},null,2));
if(!results.length||results.some(result=>!result.passed))process.exitCode=1;
