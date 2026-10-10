/** Production desktop shell, isolated HTTP and synthetic API; no personal data or AI. */
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {mkdirSync} from 'node:fs';
import {portalLocalMetadataFingerprint} from '../src/portalLocalMetadata.ts';

const dist=process.argv[2];
assert.ok(dist,'Pass an isolated Vite build directory');
const evidence=join(process.cwd(),'.agentstoz/maintainer/ui-evidence');
mkdirSync(evidence,{recursive:true});
const project={id:'fixture-tester-project',name:'테스터 관리 프로젝트',folderPath:'/fixture/projects/tester',role:'managed',isRunning:false};
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:req=>new Response(Bun.file(join(dist,new URL(req.url).pathname==='/'?'index.html':new URL(req.url).pathname)))});
const browser=await chromium.launch();
try {
  for(const width of [1440,390]){
    const page=await browser.newPage({viewport:{width,height:900},hasTouch:width===390});
    const requests=[],errors=[];
    let installed=false;
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',async route=>{
      const u=new URL(route.request().url());
      if(u.origin===`http://127.0.0.1:${server.port}`&&!u.pathname.startsWith('/api/'))return route.continue();
      const respond=data=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
      if(u.pathname==='/api/agent-runtime/tester'){
        const r=route.request().postDataJSON();requests.push(r);assert.equal(r.portId,project.id);
        if(r.operation==='status')return respond({success:true,status:{installation:installed?'ready':'needs-update',installedVersion:installed?'1.1.0':'1.0.0',availableVersion:'1.1.0',configurationRevision:'a'.repeat(64),profiles:[],defaultProfile:null,environmentReady:true,latest:null,active:null,freshness:'unknown',instructionsConnected:true,memoryLinked:true,limitations:[],targets:[{id:project.id,label:project.name}]}});
        if(r.operation==='plan')return respond({success:true,plan:{revision:'b'.repeat(64),files:['scripts/agentstoz-maintainer.py'],recovering:false}});
        if(r.operation==='apply'){assert.equal(r.revision,'b'.repeat(64));installed=true;return respond({success:true,applied:true});}
        throw Error('Unexpected tester operation: '+r.operation);
      }
      const values={
        '/api/ports':[project],'/api/portal':{},'/api/workspace-roots':[],
        '/api/portal/safety-lease/acquire':{success:true,token:'a'.repeat(64),metadata:{},fingerprint:portalLocalMetadataFingerprint({}),expiresInMs:30000},
        '/api/portal/safety-lease/release':{released:true},
        '/api/control-profile/status':{success:true,profile:{state:'ready',projectId:'fixture-ops'}},
        '/api/onboarding/status':{stage:'ready'},'/api/health':{status:'ok'},'/api/check-port-status':{isRunning:false},
      };
      if(Object.hasOwn(values,u.pathname))return respond(values[u.pathname]);
      return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'fixture blocked'})});
    });
    await page.goto(`http://127.0.0.1:${server.port}`);
    await page.getByText(project.name,{exact:false}).first().waitFor({timeout:20000});
    await page.locator('#tab-memory').click();
    const panel=page.getByTestId('memory-tester-upgrade');await panel.waitFor();
    // Works independently of Supabase / memory directory credentials.
    assert.equal(requests.length,0);
    await panel.getByLabel('테스트 에이전트 관리 프로젝트').selectOption(project.id);
    const upgrade=panel.getByRole('button',{name:'테스트 에이전트 업그레이드',exact:true});
    await upgrade.waitFor();await upgrade.scrollIntoViewIfNeeded();
    assert.match(await panel.getByTestId('tester-versions').innerText(),/v1.0.0.*v1.1.0/);
    const box=await upgrade.boundingBox();assert.ok(box&&box.x>=0&&box.x+box.width<=width+1,'Upgrade button must fit viewport');
    await page.screenshot({path:join(evidence,`memory-tester-upgrade-${width}.png`)});
    await upgrade.click();
    await panel.getByText('scripts/agentstoz-maintainer.py',{exact:true}).waitFor();
    assert.ok(!requests.some(r=>r.operation==='apply'));
    await panel.getByRole('button',{name:'설정 적용',exact:true}).click();
    await panel.getByTestId('tester-installation-status').getByText('최신',{exact:true}).waitFor();
    assert.equal(requests.filter(r=>r.operation==='apply').length,1);
    assert.deepEqual(errors,[]);
    console.log(`memory tester production UI ${width}px PASS`);
    await page.close();
  }
} finally {await browser.close();server.stop(true);}
