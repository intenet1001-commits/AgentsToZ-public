// The actual desktop shell, with an isolated host. No live API, AI or cloud writes.
import {chromium,webkit} from 'playwright';
import assert from 'node:assert/strict';
import {t} from '../src/i18n.ts';
import {portalLocalMetadataFingerprint} from '../src/portalLocalMetadata.ts';
const origin=process.argv[2];
if(!origin||new URL(origin).hostname!=='127.0.0.1'||new URL(origin).port==='3001')throw Error('Expected an owned fixture origin');
const project={id:'language-project',name:'Language fixture',folderPath:'/fixture/projects/languages',role:'managed',isRunning:false,port:9310};
for(const [name,engine] of Object.entries({chromium,webkit})){
 const browser=await engine.launch();
 try{
  const context=await browser.newContext({viewport:{width:1280,height:900}});
  await context.addInitScript(()=>{
   localStorage.setItem('portmanager-setup-wizard-seen-v1','1');
   localStorage.setItem('agentstoz-voice-dock-folded','1');
  });
  const page=await context.newPage();page.setDefaultTimeout(15000);const errors=[],unexpected=[];
  page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',route=>{
   const url=new URL(route.request().url());
   if(url.origin!==origin){unexpected.push(url.origin);return route.abort();}
   if(!url.pathname.startsWith('/api/'))return route.continue();
   const values={
    '/api/ports':[project],'/api/portal':{},'/api/workspace-roots':[],
    '/api/portal/safety-lease/acquire':{success:true,token:'a'.repeat(64),metadata:{},fingerprint:portalLocalMetadataFingerprint({}),expiresInMs:30000},
    '/api/portal/safety-lease/release':{released:true},'/api/health':{status:'ok'},
    '/api/onboarding/status':{stage:'ready'},'/api/check-port-status':{isRunning:false},
    '/api/agentstoz-use/workroom-navigation':{success:true,navigation:null},
    '/api/control-profile/status':{success:true,profile:{state:'unprepared',pendingCount:0}},
    '/api/agent-runtime/terminals':{sessions:[]},
    '/api/agent-runtime/platform-cli':{accounts:[],deviceDefaults:{}},
    '/api/browser-profiles':[],
   };
   return route.fulfill({status:Object.hasOwn(values,url.pathname)?200:503,json:values[url.pathname]??{error:'Fixture blocked'}});
  });
  await page.goto(origin);
  const search=page.getByTestId('project-search-input');await search.waitFor();
  await page.getByTestId('appearance-settings').click();
  const dialog=page.getByRole('dialog');
  for(const [lang,tab,role,empty,clear] of [
   ['en','Projects','General project','No project matches “missing-language-project”.','Clear search'],
   ['ja','プロジェクト','一般プロジェクト','「missing-language-project」に一致するプロジェクトはありません。','検索をクリア'],
   ['zh-CN','项目','普通项目','没有与“missing-language-project”匹配的项目。','清除搜索'],
   ['es','Proyectos','Proyecto general','Ningún proyecto coincide con «missing-language-project».','Borrar búsqueda'],
   ['fr','Projets','Projet général','Aucun projet ne correspond à « missing-language-project ».','Effacer la recherche'],
   ['de','Projekte','Allgemeines Projekt','Kein Projekt entspricht „missing-language-project“.','Suche löschen'],
   ['ko','프로젝트·폴더','일반 프로젝트','“missing-language-project”와 일치하는 프로젝트가 없습니다.','검색 지우기'],
  ]){
   if(!await dialog.isVisible())await page.getByTestId('appearance-settings').click();
   await dialog.getByTestId('app-language').selectOption(lang);
   await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
   await page.getByRole('tab',{name:new RegExp('^'+tab)}).waitFor();
   await page.getByTestId('project-role-filter-managed').filter({hasText:role}).waitFor();
   assert.equal(await page.locator('html').getAttribute('lang'),lang);
   assert.equal(await page.getByTestId('launch-effort-toggle').getAttribute('aria-label'),t(lang,'automaticEffort'));
   await search.fill('missing-language-project');
   await page.getByTestId('sidebar-empty-state').getByText(empty,{exact:true}).waitFor();
   assert.equal(await page.getByTestId('clear-project-search').getAttribute('aria-label'),clear);
   await page.getByTestId('sidebar-empty-clear-search').click();
   assert.equal(await search.inputValue(),'');
   const more=page.locator('.workspace-more-menu > button');
   if(!await more.isVisible())await page.locator('details.workspace-tools').filter({has:more}).locator(':scope > summary').click();
   await more.click();
   const internet=page.getByTestId('open-internet-qr-remote-control');
   assert.equal(await internet.innerText(),t(lang,'internetRemoteBeta'));
   assert.equal(await page.getByTestId('open-qr-remote-control').count(),1,'LAN and internet controls remain separate');
   if(lang==='ko'){
    await internet.click();
    const remoteDialog=page.getByTestId('internet-qr-remote-control-dialog');
    await remoteDialog.waitFor();
    assert.equal(await page.getByTestId('qr-remote-control-dialog').count(),0);
    await page.keyboard.press('Escape');await remoteDialog.waitFor({state:'hidden'});
   }else await more.click();

  }
  assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
  console.log(`${name}: seven languages update actual shell tabs, project roles, search states and accessibility labels`);
  await context.close();
 }finally{await browser.close();}
}
