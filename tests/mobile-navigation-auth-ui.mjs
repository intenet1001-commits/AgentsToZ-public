import {chromium,webkit} from 'playwright';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
const root=resolve(process.env.NAV_FIXTURE_DIST??'/tmp/agentstoz-nav-fixture-dist');
const A='10000000-0000-4000-8000-000000000001',B='10000000-0000-4000-8000-000000000002';
const devices=[{id:A,name:'조회 Mac A',last_push_at:'2026-09-10T01:00:00Z'},{id:B,name:'조회 Mac B',last_push_at:'2026-09-09T01:00:00Z'}];
const ports=devices.map((d,i)=>({id:`project-${i}`,device_id:d.id,name:`프로젝트 ${i?'B':'A'}`,device_name:d.name,folder_path:`/fixture/${i}`,sync_generation:'0'}));
const items=[{id:'bookmark-shared',device_id:'__shared__',name:'공통 자료',type:'web',url:'https://example.com/shared',category:'cat'},{id:'bookmark-legacy',device_id:A,name:'예전 자료',type:'web',url:'https://example.com/legacy',category:'cat'}];
for(const [name,engine] of [['chromium',chromium],['webkit',webkit]]){
 const browser=await engine.launch();const page=await browser.newPage({viewport:{width:390,height:844}});const requests=[];const errors=[];let holdA=false,releaseA;
 try{
  await page.addInitScript(({A})=>{
   const user={id:'10000000-0000-4000-8000-000000000099',aud:'authenticated',role:'authenticated',email:'fixture@example.com',app_metadata:{},user_metadata:{},created_at:'2026-09-01T00:00:00Z'};
   const payload=btoa(JSON.stringify({sub:user.id,role:'authenticated',exp:4102444800}));
   localStorage.setItem('portmgr-auth',JSON.stringify({access_token:`eyJhbGciOiJIUzI1NiJ9.${payload}.fixture`,refresh_token:'fixture-refresh',expires_at:4102444800,expires_in:3600,token_type:'bearer',user}));
   localStorage.setItem('portalSelectedDevice',A);
  },{A});
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());
   if(url.hostname==='workspace.example'){
    const path=resolve(root,'.'+(url.pathname==='/'?'/portal.html':url.pathname));
    if(!path.startsWith(root+'/'))return route.abort();
    const file=Bun.file(path);return await file.exists()?route.fulfill({body:Buffer.from(await file.arrayBuffer()),contentType:file.type}):route.fulfill({status:404,body:''});
   }
   if(url.hostname!=='workspace-fixture.supabase.co')return route.abort();
   requests.push({path:url.pathname,query:url.search,method:req.method()});
   let body=[];
   if(url.pathname.endsWith('/rpc/portmgr_is_member'))body=true;
   else if(url.pathname.includes('/auth/v1/user'))body={id:'10000000-0000-4000-8000-000000000099',email:'fixture@example.com'};
   else if(url.pathname.endsWith('/portmgr_devices'))body=url.searchParams.get('id')?null:devices;
   else if(url.pathname.endsWith('/portmgr_ports')){const filter=url.searchParams.get('device_id');if(holdA&&filter?.includes(A)&&url.searchParams.get('select')==='*'){holdA=false;await new Promise(resolve=>{releaseA=resolve})}body=filter?.includes('in.')?ports.filter(p=>filter.includes(p.device_id)):ports;}
   else if(url.pathname.endsWith('/portmgr_portal_items'))body=items;
   else if(url.pathname.endsWith('/portmgr_portal_categories'))body=[{id:'cat',device_id:'__shared__',name:'공통',color:'purple',order:0}];
   await route.fulfill({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'*','access-control-allow-headers':'*'},body:JSON.stringify(body)});
  });
  console.log(name+': loading fixture');await page.goto('https://workspace.example/?tab=ports',{waitUntil:'domcontentloaded',timeout:15000});console.log(name+': loaded');
  await page.getByText('프로젝트 A',{exact:true}).waitFor({timeout:15000});
  assert.equal(await page.locator('.remote-portal-scan').count(),0);
  assert(await page.getByText(/동기화된 프로젝트 현황입니다/).isVisible());
  const nav=page.getByRole('navigation',{name:'작업 메뉴'});
  await nav.getByRole('button',{name:'북마크',exact:true}).click();
  await page.getByText('공통 자료',{exact:true}).waitFor();await page.getByText('예전 자료',{exact:true}).waitFor();
  assert.equal(await page.locator('.portal-catalog-toolbar').getByText('조회 기기',{exact:true}).count(),0);
  assert.equal(await page.locator('.remote-state').count(),0);
  await nav.getByRole('button',{name:'프로젝트',exact:true}).click();
  await page.locator('.portal-catalog-toolbar').getByRole('button',{name:/조회 Mac A/}).click();
  await page.getByRole('button',{name:/조회 Mac B 프로젝트/}).click();
  await page.getByText('프로젝트 B',{exact:true}).waitFor();
  holdA=true;
  await page.locator('.portal-catalog-toolbar').getByRole('button',{name:/조회 Mac B/}).click();
  await page.getByRole('button',{name:/조회 Mac A 프로젝트/}).click();
  for(let i=0;i<100&&!releaseA;i++)await Bun.sleep(10);
  assert(releaseA,'delayed A request reached the server');
  await page.locator('.portal-catalog-toolbar').getByRole('button',{name:/조회 Mac A/}).click();
  await page.getByRole('button',{name:/조회 Mac B 프로젝트/}).click();
  await page.getByText('프로젝트 B',{exact:true}).waitFor();releaseA();await Bun.sleep(100);
  assert.equal(await page.getByText('프로젝트 A',{exact:true}).count(),0,'late A cannot replace B');

  await nav.getByRole('button',{name:'북마크',exact:true}).click();
  await page.getByText('공통 자료',{exact:true}).waitFor();await page.getByText('예전 자료',{exact:true}).waitFor();
  assert(requests.filter(r=>r.path.endsWith('/portmgr_portal_items')).every(r=>!new URLSearchParams(r.query).has('device_id')));
  assert.equal(requests.filter(r=>/pair|claim|terminal|execute/.test(r.path)).length,0,'browsing cannot create a remote operation');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  assert.deepEqual(errors,[]);
  await page.screenshot({path:`/tmp/agentstoz-navigation-${name}.png`});
  await page.setViewportSize({width:320,height:780});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'320px catalog fits');
  console.log(`${name}: authenticated inventory without QR / device switch / shared+legacy bookmarks / no remote operations PASS`);
 }catch(error){console.error(String(error));console.error((await page.locator('body').innerText({timeout:2000})).slice(0,2000));await page.screenshot({path:`/tmp/agentstoz-navigation-${name}-failure.png`,timeout:5000}).catch(()=>{});throw error;}
 finally{await browser.close();}
}
