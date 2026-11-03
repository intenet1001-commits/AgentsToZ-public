// Owned component fixture only: synthetic IPC, fresh browser contexts, no installed app or native screen session.
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {chromium,webkit} from 'playwright';
const built=await Bun.build({entrypoints:['tests/fixtures/workspace-tools.tsx'],target:'browser',format:'esm',define:{'process.env.NODE_ENV':'"production"'}});
assert(built.success,built.logs.join('\n'));
const js=built.outputs.find(output=>output.path.endsWith('.js')),css=built.outputs.find(output=>output.path.endsWith('.css'));
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request){
  const path=new URL(request.url).pathname;
  if(path==='/app.js')return new Response(js,{headers:{'Content-Type':'text/javascript'}});
  if(path==='/app.css')return new Response(css,{headers:{'Content-Type':'text/css'}});
  return new Response('<meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;--surface:#1d1c19;--sunken:#151412;--ink:#f4efe3;--ink-2:#a8a29e;--line:#383630;--line-2:#45423b;--shadow:0 8px 24px #0006;background:var(--surface);color:var(--ink);font-family:system-ui}.workspace-sidebar-footer{position:absolute;bottom:0;left:0;width:264px;padding:10px}</style><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/app.js"></script>',{headers:{'Content-Type':'text/html'}});
}});
const evidence='.agentstoz/maintainer/workspace-tools';mkdirSync(evidence,{recursive:true});
try{
  for(const [name,engine] of Object.entries({chromium,webkit})){
    const browser=await engine.launch();
    try{for(const width of [1100,390]){
      console.log(`workspace tools rendering ${name} ${width}`);
      const page=await browser.newPage({viewport:{width,height:820}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
      await page.goto(server.url.toString());
      assert.deepEqual(await page.evaluate(()=>window.nativeCalls),[],'closed tools do not mount status readers');
      const menu=page.locator('.workspace-tools'),summary=menu.locator(':scope > summary');
      await summary.click();await page.getByTestId('workspace-viewer-open').waitFor();
      assert.deepEqual(await menu.getByRole('heading',{level:3}).allTextContents(),['기기 연결','AI 협업','설정·지원']);
      const panel=menu.locator(':scope > .workspace-tools-panel');
      await panel.evaluate(async node=>{await Promise.all(node.getAnimations({subtree:true}).map(animation=>animation.finished));await new Promise(requestAnimationFrame);});
      const box=await panel.boundingBox();
      assert(box&&box.x>=0&&box.x+box.width<=width,'panel fits the viewport horizontally');
      assert(box.y>=0&&box.y+box.height<=820,'panel fits the viewport vertically');
      assert.equal(await panel.evaluate(node=>node.scrollWidth>node.clientWidth),false,'no horizontal panel overflow');
      assert.equal(await page.getByTestId('ops').isVisible(),false,'OPS advanced action is folded');
      assert.equal(await page.getByRole('checkbox').count(),0,'opening tools offers no automatic permission choice');
      const primary=await page.getByTestId('workspace-screen-entry').boundingBox(),peer=await page.getByTestId('workspace-viewer-entry').boundingBox();
      const teams=await page.getByTestId('teams').boundingBox(),chat=await page.getByTestId('chat').boundingBox(),voice=await page.getByTestId('voice').boundingBox(),call=await page.getByTestId('call').boundingBox();
      if(width===1100){assert(Math.abs(primary.y-peer.y)<1&&primary.x<peer.x,'desktop primary actions share a clear row');assert(Math.abs(teams.y-chat.y)<1&&teams.x<chat.x,'desktop secondary actions use two compact columns');assert(Math.abs(voice.y-call.y)<1&&voice.x<call.x,'four collaboration actions fill two rows rather than an accidental full-width third action');}
      else{assert(peer.y>=primary.y+primary.height,'narrow primary entries stack without overlap');assert(chat.y>=teams.y+teams.height,'narrow secondary actions use one column');}
      for(const id of ['workspace-screen-open','workspace-viewer-open','teams','chat','voice','call','effort','settings','helpdesk'])assert((await page.getByTestId(id).boundingBox()).height>=44,'every purpose action keeps a44px hit area');
      await panel.evaluate(node=>node.scrollTop=0);await page.screenshot({path:`${evidence}/${name}-${width}-initial.png`,fullPage:true});
      await page.getByTestId('workspace-screen-open').click();await page.getByTestId('workspace-viewer-open').click();
      assert.deepEqual(await page.evaluate(()=>window.nativeCalls.filter(name=>name.startsWith('open_'))),['open_screen_helper','open_viewer_helper'],'open only the two existing helper UIs');
      for(const id of ['pinned-project','computer-use','teams','chat','voice','call','effort','settings','helpdesk','data-export'])await page.getByTestId(id).click();
      await menu.getByText('고급 설정',{exact:true}).click();await page.getByTestId('ops').click();
      assert.deepEqual(await page.evaluate(()=>window.toolActions),['pinned-project','computer-use','teams','chat','voice','call','effort','settings','helpdesk','data-export','ops']);
      if(width===390)assert((await page.getByTestId('teams').boundingBox()).height>=44,'narrow controls keep their touch size');
      await page.screenshot({path:`${evidence}/${name}-${width}-groups.png`,fullPage:true});
      await page.evaluate(()=>{window.failStatus=true;window.tickHelpers();});
      await page.getByTestId('workspace-viewer-open').waitFor({state:'attached'});
      await page.waitForFunction(()=>document.querySelector('[data-testid="workspace-viewer-open"]')?.disabled);
      assert.equal(await page.getByTestId('workspace-screen-open').count(),0,'a failed status cannot keep a ready Screen action');
      const before=await page.evaluate(()=>window.nativeCalls.filter(name=>name.startsWith('open_')).length);
      assert.equal(await page.getByTestId('workspace-viewer-open').isDisabled(),true);
      await page.evaluate(()=>{window.failStatus=false;window.blocked=true;window.tickHelpers();});
      await page.getByTestId('workspace-viewer-status').filter({hasText:/다른 위치/}).waitFor();
      assert.equal(await page.getByTestId('workspace-screen-open').count(),0);assert.equal(await page.getByTestId('workspace-viewer-open').isDisabled(),true);
      assert.equal(await page.evaluate(()=>window.nativeCalls.filter(name=>name.startsWith('open_')).length),before,'unknown/other instances never dispatch open');
      await page.screenshot({path:`${evidence}/${name}-${width}-blocked.png`,fullPage:true});
      await page.evaluate(()=>{window.blocked=false;window.supported=false;window.tickHelpers();});
      await page.getByTestId('workspace-screen-entry').waitFor({state:'detached'});
      await page.getByTestId('workspace-viewer-entry').waitFor({state:'detached'});
      assert.equal(await page.evaluate(()=>window.nativeCalls.filter(name=>name.startsWith('open_')).length),before,'unsupported helpers expose no action or implicit install');
      await page.evaluate(()=>{window.supported=true;window.tickHelpers();});
      await page.waitForFunction(()=>document.querySelector('[data-testid="workspace-viewer-open"]')?.disabled===false);
      await page.getByTestId('settings').focus();await page.keyboard.press('Escape');await page.waitForFunction(()=>window.helperTimerCount()===0);
      const closedCalls=await page.evaluate(()=>window.nativeCalls.length);await page.evaluate(()=>window.tickHelpers());
      assert.equal(await page.evaluate(()=>window.nativeCalls.length),closedCalls,'closing tools unmounts every helper poller');
      assert.equal(await summary.evaluate(node=>node===document.activeElement),true,'Escape restores the tools trigger');
      await summary.click();await page.waitForFunction(()=>window.helperTimerCount()===2);
      await summary.click();await page.waitForFunction(()=>window.helperTimerCount()===0);
      const toggledClosedCalls=await page.evaluate(()=>window.nativeCalls.length);await page.evaluate(()=>window.tickHelpers());
      assert.equal(await page.evaluate(()=>window.nativeCalls.length),toggledClosedCalls,'native disclosure close also stops polling');
      assert.deepEqual(errors,[]);await page.close();
    }}finally{await browser.close();}
  }
  console.log('PASS workspace tools: Chromium/WebKit 1100/390, grouping, original actions, helper guards, and closed-menu polling');
}finally{server.stop(true);}
