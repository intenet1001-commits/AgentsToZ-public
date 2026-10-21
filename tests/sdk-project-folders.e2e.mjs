/** Owned Vite + actual registered-folder service with temporary SDK fixtures. No installed API/Finder/AI. */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
import {createServer} from 'vite';import {chromium,webkit} from 'playwright';
import {createSdkFolderActions} from '../src/sdkProjectFolderService.ts';
import {sdkFolderRequest,SdkFolderError,sdkFolderMention} from '../src/sdkProjectFolderContract.ts';
import {portalLocalMetadataFingerprint} from '../src/portalLocalMetadata.ts';

const root=resolve(import.meta.dirname,'..'),scratch=await mkdtemp(join(tmpdir(),'agentstoz-sdk-persona-'));
const evidence=process.env.SDK_FOLDER_EVIDENCE_DIR||join(scratch,'evidence');await mkdir(evidence,{recursive:true});
const first='a4214da5-1111-4111-8111-111111111111',second='b4214da5-2222-4222-8222-222222222222';
const children=['agentstoz-runtime-sdk','common-memory-sdk','phone-bundle','remote control','reuse-workflow','voc','scripts','예제 "화면"'];
const sdkRoot=join(scratch,'SDK'),otherRoot=join(scratch,'Other SDK');
const memoryId='11111111-1111-4111-8111-111111111111';
async function seed(path,names){await mkdir(join(path,'.agentstoz'),{recursive:true});await mkdir(join(path,'.agent-memory'));await writeFile(join(path,'.agent-memory/config.json'),JSON.stringify({memoryId}));await writeFile(join(path,'.agentstoz/sdk-project.json'),JSON.stringify({schemaVersion:1,kind:'sdk-project',memoryId,repository:'https://github.com/example/SDK',autoPrepare:false,modules:[{id:'runtime',path:'agentstoz-runtime-sdk',description:'AI 작업 런타임',goals:['AI'],prepare:'inspect-only'},{id:'remote-control',path:'remote control',description:'원격 제어',goals:['remote'],prepare:'inspect-only'},{id:'not-installed',path:'not-installed',description:'아직 받지 않은 모듈',goals:[],prepare:'inspect-only'}]}));for(const name of names)await mkdir(join(path,name));}
await seed(sdkRoot,children);await seed(otherRoot,['only-in-second']);
for(const key of Object.keys(process.env))if(key.startsWith('VITE_'))delete process.env[key];process.env.VITE_SUPABASE_URL='https://workspace-fixture.supabase.co';process.env.VITE_SUPABASE_ANON_KEY='fixture-anon-key';
const projects=new Map([[first,{projectId:first,projectName:'SDK',canonicalPath:sdkRoot}],[second,{projectId:second,projectName:'다른 SDK',canonicalPath:otherRoot}]]),opened=[],requests=[];
let failList=false,holdFirst=false,releaseFirst;
const actions=createSdkFolderActions({resolveProject:async id=>{const project=projects.get(id);if(!project)throw new SdkFolderError('SDK_NOT_REGISTERED','등록 프로젝트를 찾지 못했습니다.');return project;},openPath:async path=>{opened.push(path);}});
const ports=[{id:first,name:'SDK',role:'managed',folderPath:sdkRoot,isRunning:false,favorite:false},{id:second,name:'일반 프로젝트',role:'managed',folderPath:otherRoot,isRunning:false,favorite:false}];
const values={'/api/ports':ports,'/api/portal':{},'/api/workspace-roots':[{id:'fixture-root',name:'테스트 폴더',path:scratch}],'/api/portal/safety-lease/acquire':{success:true,token:'a'.repeat(64),metadata:{},fingerprint:portalLocalMetadataFingerprint({}),expiresInMs:30000},'/api/portal/safety-lease/release':{released:true},'/api/health':{status:'ok'},'/api/onboarding/status':{stage:'ready'},'/api/check-port-status':{isRunning:false},'/api/agentstoz-use/workroom-navigation':{success:true,navigation:null},'/api/common-memory/project-names':{success:true,projects:[]},'/api/code-app-launch-options':{success:true,options:[]}};
let vite,browser;
const results=[];
try{
  vite=await createServer({configFile:join(root,'vite.config.ts'),root,envDir:scratch,cacheDir:join(scratch,'node_modules/.vite'),mode:'maintainer-test',logLevel:'warn',plugins:[{name:'owned-sdk-api',configureServer(server){server.middlewares.use(async(req,res,next)=>{
    const path=new URL(req.url,'http://fixture').pathname;if(!path.startsWith('/api/'))return next();
    const send=(body,status=200)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(body));};
    const buffers=[];for await(const chunk of req)buffers.push(chunk);let body={};try{body=buffers.length?JSON.parse(Buffer.concat(buffers).toString()):{};}catch{return send({success:false,error:'fixture JSON rejected'},400);}
    requests.push({path,body});
    if(path==='/api/sdk-project/catalog')return send({success:true,projects:[{projectId:first,name:'SDK',memoryId,moduleCount:3}]});
    if(path==='/api/sdk-project/folders'||path==='/api/sdk-project/open-folder'){
      try{const operation=path.endsWith('open-folder')?'open-folder':'folders',input=sdkFolderRequest(body,operation);if(operation==='folders'){if(failList)throw Error('fixture 목록 장애');if(holdFirst&&input.portId===first)await new Promise(resolve=>{releaseFirst=resolve;});return send({success:true,directory:await actions.list(input.portId)});}return send({success:true,...await actions.open(input.portId,input.folderId)});}
      catch(error){return send({success:false,error:error.message},409);}
    }
    if(path==='/api/ports/merge')return send({success:true});
    return Object.hasOwn(values,path)?send(values[path]):send({success:false,error:'Fixture API blocked'},503);
  });}}],server:{host:'127.0.0.1',port:0,strictPort:false,fs:{allow:[root,realpathSync(join(root,'node_modules')),scratch]},watch:{ignored:['**/.agentstoz/**']}}});
  await vite.listen();const address=vite.httpServer.address();assert.ok(address&&typeof address!=='string'&&address.port!==3001);const origin=`http://127.0.0.1:${address.port}`;
  const [source,main]=await Promise.all(['/src/SdkProjectFolders.tsx','/src/main.tsx'].map(path=>fetch(origin+path).then(response=>response.text())));
  const react=source.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react\.js[^"\n]*)"/)?.[1],reactDom=main.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];assert.ok(react&&reactDom);
  const html=`<!doctype html><html data-app-theme="gray"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{padding:12px;margin:0;font:14px system-ui;background:var(--bg);color:var(--ink)}#root{max-width:800px;margin:auto}</style><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(reactDom)};import '/src/index.css';import '/src/workspaceDesign.css';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
const {SdkProjectFolders}=await import('/src/SdkProjectFolders.tsx');const root=ReactDOM.createRoot(document.getElementById('root'));window.sdkFixture={clipboard:[],mount(projectId=${JSON.stringify(first)},projectName='SDK'){root.render(React.createElement(SdkProjectFolders,{projectId,projectName}));}};Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>sdkFixture.clipboard.push(text)}});sdkFixture.mount();
</script></html>`;
  for(const [engineName,engine] of [['chromium',chromium],['webkit',webkit]]){
    browser=await engine.launch({headless:true});
    for(const width of [1200,390]){
      const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'}),errors=[],external=[];await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==origin){external.push(url.origin);return route.abort();}if(url.pathname==='/__sdk-fixture')return route.fulfill({contentType:'text/html',body:html});return route.continue();});
      const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));const openedBefore=opened.length;await page.goto(origin+'/__sdk-fixture');const panel=page.getByTestId('sdk-project-folders');await panel.getByTestId('sdk-folder-row').first().waitFor();
      assert.equal(opened.length,openedBefore,'Listing never opens a folder or prepares SDK');assert.equal(await panel.getByTestId('sdk-folder-row').count(),children.length+1);
      const row=name=>panel.getByTestId('sdk-folder-row').filter({has:page.getByText(name,{exact:true})});
      await row('remote control').getByText('원격 제어',{exact:true}).waitFor();assert.equal(await row('scripts').getByRole('button',{name:'멘션 복사',exact:true}).isEnabled(),true,'Unregistered direct children still reference the registered SDK root');
      const missing=row('not-installed');assert.equal(await missing.getByRole('button',{name:'폴더 열기',exact:true}).isDisabled(),true);assert.equal(await missing.getByRole('button',{name:'멘션 복사',exact:true}).isDisabled(),true);
      for(const name of ['remote control','예제 "화면"','scripts']){await row(name).getByRole('button',{name:'멘션 복사',exact:true}).click();await panel.getByTestId('sdk-folder-message').getByText('복사했습니다.',{exact:false}).waitFor();}
      assert.deepEqual(await page.evaluate(()=>sdkFixture.clipboard),['remote control','예제 "화면"','scripts'].map(name=>sdkFolderMention('SDK',first,name)));assert.ok((await page.evaluate(()=>sdkFixture.clipboard)).every(text=>text.startsWith('#SDK [로컬프로젝트해시: A4214DA5]\n')&&!text.includes(sdkRoot)&&!text.includes('#SDK/')));
      await row('remote control').getByRole('button',{name:'폴더 열기',exact:true}).click();await panel.getByTestId('sdk-folder-message').getByText('열기를 요청했습니다.',{exact:false}).waitFor();assert.equal(opened.at(-1),realpathSync(join(sdkRoot,'remote control')));
      const openRequest=requests.filter(request=>request.path==='/api/sdk-project/open-folder').at(-1);assert.deepEqual(Object.keys(openRequest.body).sort(),['folderId','portId']);
      // Real helper catches a folder replaced after the list was shown, without invoking Finder.
      const scripts=join(sdkRoot,'scripts');await rm(scripts,{recursive:true});await symlink(otherRoot,scripts);const beforeBlocked=opened.length;await row('scripts').getByRole('button',{name:'폴더 열기',exact:true}).click();await panel.getByRole('alert').waitFor();assert.equal(opened.length,beforeBlocked);await rm(scripts);await mkdir(scripts);
      failList=true;await panel.getByLabel('SDK 하위 폴더 새로고침').click();await panel.getByRole('alert').getByText('목록 장애',{exact:false}).waitFor();assert.match(await panel.getByRole('alert').textContent(),/목록 장애/);failList=false;await panel.getByLabel('SDK 하위 폴더 새로고침').click();await row('scripts').waitFor();
      // A late first-project read cannot label or replace the new project's directory.
      holdFirst=true;releaseFirst=undefined;await panel.getByLabel('SDK 하위 폴더 새로고침').click();await page.waitForTimeout(100);await page.evaluate(id=>sdkFixture.mount(id,'다른 SDK'),second);await row('only-in-second').waitFor();holdFirst=false;releaseFirst?.();await page.waitForTimeout(100);assert.equal(await row('remote control').getAttribute('data-folder-state'),'missing');assert.equal(await row('remote control').getByRole('button',{name:'폴더 열기',exact:true}).isDisabled(),true);assert.match(await panel.textContent(),/다른 SDK/);
      await page.evaluate(id=>sdkFixture.mount(id,'SDK'),first);await row('remote control').waitFor();for(const theme of width===1200?['gray','dark']:['gray']){await page.evaluate(theme=>document.documentElement.dataset.appTheme=theme,theme);await page.evaluate(()=>document.fonts.ready);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);if(width===390)assert.ok(await panel.locator('button').evaluateAll(buttons=>buttons.every(button=>button.getBoundingClientRect().height>=44)));await page.screenshot({path:join(evidence,`sdk-${engineName}-${width}-${theme}.png`),fullPage:true});}
      assert.deepEqual(errors,[]);assert.deepEqual(external,[]);results.push({engine:engineName,width,passed:true,personas:['SDK module browser','exact root mention copier','registered folder safety reviewer','returning user after failed or stale lookup'],checks:['list-only-on-mount','catalog-plus-direct-child','missing-disabled','root-hash-copy','space-and-quote-copy','opaque-open-request','symlink-replacement-refused','load-failure-retry','late-owner-fenced','44px-mobile','gray-dark','no-overflow']});await context.close();
    }
    await browser.close();browser=null;
  }
  // Integration: the actual App detail mounts this module only after registered SDK catalog discovery.
  for(let index=1;index<=90;index++)await mkdir(join(sdkRoot,`sample-sdk-${String(index).padStart(3,'0')}`));
  browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  const page=await context.newPage();await page.addInitScript(()=>{window.sdkAppClipboard=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>window.sdkAppClipboard.push(text)}});});const appErrors=[],appKeyWarnings=[];page.on('pageerror',error=>appErrors.push(error.message));page.on('console',message=>{if(/Encountered two children with the same key/.test(message.text()))appKeyWarnings.push(message.text());});
  await page.goto(origin+'/');await page.getByText('SDK',{exact:true}).first().waitFor({timeout:20000});await page.getByText('SDK',{exact:true}).first().click();const launcher=page.getByTestId('detail-project-launch');await launcher.waitFor();
  const sdkPanel=page.getByTestId('sdk-project-folders'),remoteRow=sdkPanel.getByTestId('sdk-folder-row').filter({has:page.getByText('remote control',{exact:true})}),folderList=sdkPanel.getByRole('region',{name:'SDK 폴더 목록',exact:true});await remoteRow.waitFor();
  await page.screenshot({path:join(evidence,'sdk-actual-many-folders-before-focus.png'),fullPage:false});
  const initialPanelBox=await sdkPanel.boundingBox();assert.ok(initialPanelBox.y<1000,'The SDK module list appears in the project detail first screen');assert.ok(initialPanelBox.height<800,`Many folders cannot bury the following metadata in a thousands-pixel block, including the app's default zoom (${initialPanelBox.height}px)`);
  assert.ok(await folderList.evaluate(element=>element.scrollHeight>element.clientHeight&&element.clientHeight<=400),'The long folder list scrolls within a bounded, named region');
  const lastCopy=sdkPanel.getByTestId('sdk-folder-row').filter({has:page.getByText('sample-sdk-090',{exact:true})}).getByRole('button',{name:'멘션 복사',exact:true});await lastCopy.focus();
  assert.equal(await lastCopy.evaluate(button=>{const region=button.closest('.sdk-folder-list'),buttonBox=button.getBoundingClientRect(),regionBox=region.getBoundingClientRect();return document.activeElement===button&&region.scrollTop>0&&buttonBox.top>=regionBox.top&&buttonBox.bottom<=regionBox.bottom;}),true,'Keyboard button focus reveals the folder inside its scroll region');
  await launcher.scrollIntoViewIfNeeded();assert.ok((await launcher.boundingBox()).y<1000,'The existing launcher remains reachable outside the bounded folder list');
  await remoteRow.getByRole('button',{name:'멘션 복사',exact:true}).click();await sdkPanel.getByTestId('sdk-folder-message').getByText('복사했습니다.',{exact:false}).waitFor();assert.equal((await page.evaluate(()=>window.sdkAppClipboard)).at(-1),sdkFolderMention('SDK',first,'remote control'));
  await remoteRow.getByRole('button',{name:'폴더 열기',exact:true}).click();await sdkPanel.getByTestId('sdk-folder-message').getByText('열기를 요청했습니다.',{exact:false}).waitFor();assert.equal(opened.at(-1),realpathSync(join(sdkRoot,'remote control')));
  await page.screenshot({path:join(evidence,'sdk-actual-project-detail.png'),fullPage:false});await sdkPanel.screenshot({path:join(evidence,'sdk-actual-detail-folders.png')});
  // Actual App reconciliation: SDK and duty panels must not share a sibling key.
  // Switching project or reusing the detail div for an empty view previously left
  // orphan duty buttons that multiplied with each selection.
  const projectRow=id=>page.locator(`[data-testid="sidebar-project-row"][data-project-id="${id}"]`);
  // The row centre can be its test-set button. Click the project name to select it.
  const selectProject=id=>projectRow(id).getByText(id===first?'SDK':'일반 프로젝트',{exact:true}).first().click();
  const dutyButton=page.getByRole('button',{name:'CS 대직 · 질문 응답 설정',exact:true});
  const checkDetail=async(name,sdk)=>{
    await page.locator('.workspace-project-detail').getByRole('heading',{name,exact:true}).waitFor();
    assert.equal(await page.getByTestId('cs-duty-project').count(),1,`${name}: exactly one duty section belongs to the current project`);
    assert.equal(await dutyButton.count(),1,`${name}: no orphan duty button remains`);
    assert.equal(await sdkPanel.count(),sdk?1:0,`${name}: SDK panel belongs only to a registered SDK project`);
  };
  const checkEmpty=async()=>{
    await page.locator('.workspace-empty').waitFor();
    assert.equal(await page.getByTestId('cs-duty-project').count(),0,'An empty project view has no orphan duty section');
    assert.equal(await dutyButton.count(),0,'An empty project view has no orphan duty button');
    assert.equal(await sdkPanel.count(),0,'An empty project view has no retained SDK section');
  };
  await checkDetail('SDK',true);
  for(let cycle=0;cycle<3;cycle++){
    await selectProject(second);await checkDetail('일반 프로젝트',false);
    await page.getByTestId('project-search-input').fill('fixture-no-project-matches');await checkEmpty();
    await page.getByTestId('project-search-input').fill('');await checkDetail('일반 프로젝트',false);
    await selectProject(first);await checkDetail('SDK',true);
    await page.getByTestId('project-search-input').fill('fixture-no-project-matches');await checkEmpty();
    await page.getByTestId('project-search-input').fill('');await checkDetail('SDK',true);
  }
  // Mobile's actual back control clears selection, rather than merely filtering it.
  await page.setViewportSize({width:390,height:844});
  for(const id of [first,second,first]){
    if(id!==first||await page.locator('.workspace-project-detail').count()===0)await selectProject(id);
    await checkDetail(id===first?'SDK':'일반 프로젝트',id===first);
    await page.getByRole('button',{name:'← 목록',exact:true}).click();
    assert.equal(await page.getByTestId('cs-duty-project').count(),0,'Returning to the project list unmounts every duty section');
    assert.equal(await dutyButton.count(),0,'Returning to the project list leaves no duty button');
    assert.equal(await sdkPanel.count(),0,'Returning to the project list unmounts the SDK section');
    assert.equal(await projectRow(first).getAttribute('data-selected'),'false');
    assert.equal(await projectRow(second).getAttribute('data-selected'),'false');
  }
  assert.deepEqual(appKeyWarnings,[],'The real App must not render duplicate sibling keys');
  assert.deepEqual(appErrors,[]);results.push({surface:'actual App project detail',passed:true,checks:['registered-SDK-discovery','real-project-detail-mount','actual-detail-copy-root-identity','actual-detail-open-revalidated-folder','many-folders-bounded-scroll','keyboard-focused-folder-visible','metadata-launcher-reachable','SDK-to-ordinary-selection-no-orphan-duty','filtered-empty-view-unmounts-panels','mobile-cleared-selection-unmounts-panels','no-duplicate-sibling-key-warning']});await context.close();
  await writeFile(join(evidence,'sdk-folder-results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify({passed:results.length,failed:0,fixture:true,physicalFinder:false,results,evidence},null,2));
}catch(error){console.error(error);process.exitCode=1;}
finally{releaseFirst?.();await browser?.close();await vite?.close();await rm(scratch,{recursive:true,force:true});}
