/** An optional Supabase device-name lookup cannot hold the local bookmark page hostage. */
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {chromium} from 'playwright';

const dist = process.argv[2];
if (!dist) throw new Error('Pass an isolated Vite build directory');

const portal = {
  items:[{id:'bookmark-1',name:'Fixture bookmark',type:'web',url:'https://example.com',category:'c1',pinned:false,visitCount:0,createdAt:'2026-10-01T00:00:00Z'}],
  categories:[{id:'c1',name:'Web',color:'teal',order:0}],deviceId:'fixture-device',
  supabaseUrl:'https://fixture-device-name.supabase.co',supabaseAnonKey:'fixture-anon-key',
};
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:req=>{
  const path=new URL(req.url).pathname;
  const file=Bun.file(join(dist,path==='/'?'index.html':path));
  return file.size?new Response(file):new Response(Bun.file(join(dist,'index.html')));
}});
const browser=await chromium.launch();
let releaseLookup=()=>{};
const lookupGate=new Promise(resolve=>{releaseLookup=resolve;});
let lookupStarted=()=>{};
const lookupStart=new Promise(resolve=>{lookupStarted=resolve;});
let savedName=()=>{};
const nameSaved=new Promise(resolve=>{savedName=resolve;});
const requests=[];
try{
  const context=await browser.newContext();
  await context.addInitScript(()=>localStorage.setItem('portmanager-setup-wizard-seen-v1','1'));
  const page=await context.newPage();
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    requests.push(`${request.method()} ${url.hostname}${url.pathname}`);
    if(url.hostname==='127.0.0.1'&&!url.pathname.startsWith('/api/'))return route.continue();
    if(url.pathname.endsWith('/rest/v1/portmgr_devices')){
      lookupStarted();await lookupGate;
      return route.fulfill({json:{name:'Fixture Mac'}});
    }
    if(url.hostname!=='127.0.0.1')return route.abort();
    if(url.pathname==='/api/portal'){
      if(request.method()==='POST'){
        if(JSON.parse(request.postData()??'{}').deviceName==='Fixture Mac')savedName();
        return route.fulfill({json:{success:true}});
      }
      return route.fulfill({json:portal});
    }
    const values={
      '/api/ports':[], '/api/workspace-roots':[], '/api/health':{status:'ok'},
      '/api/onboarding/status':{stage:'complete'},'/api/last-visits':{},'/api/last-git-activity':{},
      '/api/check-ports-batch':{success:true,results:[]},'/api/voc/access':{blocked:false},
      '/api/browser-profiles':{profiles:[]},'/api/orca-worktrees':{success:true,worktrees:[]},
      '/api/list-git-worktrees':{success:true,worktrees:[]},
      '/api/discover-registered-git-worktrees':{success:true,worktrees:[],nextCursor:null},
      '/api/cleanup-stale-worktrees':{success:true,removed:[]},
      '/api/client-errors':{ok:true},
    };
    if(request.method()==='POST')return route.fulfill({json:{success:true}});
    return Object.hasOwn(values,url.pathname)?route.fulfill({json:values[url.pathname]}):route.fulfill({status:503,json:{error:'fixture blocked'}});
  });
  await page.goto(`http://127.0.0.1:${server.port}`,{waitUntil:'domcontentloaded'});
  await page.locator('#tab-portal').click();
  await Promise.race([lookupStart,new Promise((_,reject)=>setTimeout(()=>reject(Error(`device-name lookup did not start: ${requests.join(', ')}`)),5000))]);
  await page.locator('.portal-bookmark-card').first().waitFor({timeout:2500});
  assert.equal(await page.locator('.portal-bookmark-card').count(),1,'bookmark is visible while device-name lookup is still pending');
  releaseLookup();
  await Promise.race([nameSaved,new Promise((_,reject)=>setTimeout(()=>reject(Error('device name was not saved after lookup')),5000))]);
  assert.deepEqual(errors,[]);
  await context.close();
  console.log('portal bookmarks render before optional device-name lookup; later name persists PASS');
}finally{releaseLookup();await browser.close();server.stop(true);}
