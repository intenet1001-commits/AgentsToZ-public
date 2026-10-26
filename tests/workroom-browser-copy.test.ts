import {describe,expect,test} from 'bun:test';
import {APP_LANGUAGES,type Lang} from '../src/i18n';
import {workroomBrowserCopy} from '../src/workroomBrowserCopy';
import {workroomBrowserStageCopy} from '../src/workroomBrowserStageCopy';
import {workroomBrowserTabsCopy} from '../src/workroomBrowserTabsCopy';
import {workroomBrowserUiCopy,workroomBrowserUiMessages} from '../src/workroomBrowserUiCopy';

type Leaf={path:string;text:string};

function collectLeaves(value:unknown,prefix=''):Leaf[]{
 if(typeof value==='string')return [{path:prefix,text:value}];
 if(!value||typeof value!=='object')throw new Error(`Unexpected non-string leaf at ${prefix}`);
 return Object.keys(value)
  .sort()
  .flatMap(key=>collectLeaves((value as Record<string,unknown>)[key],prefix?`${prefix}.${key}`:key));
}

const placeholders=(text:string)=>[...text.matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort();

const modules={
 workroomBrowserUiCopy,
 workroomBrowserCopy,
 workroomBrowserStageCopy,
 workroomBrowserTabsCopy,
} as const;

describe('Workroom browser copy foundation (7 languages)',()=>{
 test('every browser copy module has identical keys, non-empty strings and matching placeholders in all 7 languages',()=>{
  for(const [moduleName,accessor] of Object.entries(modules)){
   const koLeaves=collectLeaves(accessor('ko'));
   expect(koLeaves.length).toBeGreaterThan(0);
   for(const {id} of APP_LANGUAGES){
    const langLeaves=collectLeaves(accessor(id));
    expect({moduleName,id,paths:langLeaves.map(l=>l.path)}).toEqual({
     moduleName,
     id,
     paths:koLeaves.map(l=>l.path),
    });
    langLeaves.forEach((leaf,index)=>{
     expect(typeof leaf.text).toBe('string');
     expect({moduleName,id,path:leaf.path,empty:leaf.text.trim().length===0}).toEqual({
      moduleName,
      id,
      path:leaf.path,
      empty:false,
     });
     expect({moduleName,id,path:leaf.path,placeholders:placeholders(leaf.text)}).toEqual({
      moduleName,
      id,
      path:leaf.path,
      placeholders:placeholders(koLeaves[index]!.text),
     });
    });
   }
  }
 });

 test('workroomBrowserUiMessages covers all 7 languages and falls back to English for unknown language codes',()=>{
  expect(Object.keys(workroomBrowserUiMessages).sort()).toEqual(APP_LANGUAGES.map(l=>l.id).sort());
  expect(workroomBrowserUiCopy('xx' as Lang)).toBe(workroomBrowserUiMessages.en);
 });

 test('no browser copy module contains Error: or raw Workroom in ko/ja/zh-CN, or 아젠투지 as the app name',()=>{
  for(const [moduleName,accessor] of Object.entries(modules)){
   for(const {id} of APP_LANGUAGES){
    for(const leaf of collectLeaves(accessor(id))){
     expect({moduleName,id,path:leaf.path,hasErrorPrefix:leaf.text.includes('Error:')}).toEqual({
      moduleName,
      id,
      path:leaf.path,
      hasErrorPrefix:false,
     });
     if(id==='ko'||id==='ja'||id==='zh-CN'){
      expect({moduleName,id,path:leaf.path,hasRawWorkroom:/\bWorkroom\b/i.test(leaf.text)}).toEqual({
       moduleName,
       id,
       path:leaf.path,
       hasRawWorkroom:false,
      });
     }
     if(id==='ko'){
      expect({moduleName,id,path:leaf.path,hasAgentstozNickname:leaf.text.includes('아젠투지')}).toEqual({
       moduleName,
       id,
       path:leaf.path,
       hasAgentstozNickname:false,
      });
     }
    }
   }
  }
 });

 test('new UI copy module and additive keys never expose 빌드, build, Chromium, CDP or owned in user-facing sentences',()=>{
  const banned=/빌드|\bbuild\b|Chromium|\bCDP\b|\bowned\b/i;
  for(const {id} of APP_LANGUAGES){
   for(const leaf of collectLeaves(workroomBrowserUiCopy(id))){
    expect({id,path:leaf.path,text:leaf.text,matchesBanned:banned.test(leaf.text)}).toEqual({
     id,
     path:leaf.path,
     text:leaf.text,
     matchesBanned:false,
    });
   }
   const legacy=workroomBrowserCopy(id);
   for(const key of [
    'detachedOwned',
    'detachedChrome',
    'reviewDone',
    'dividerLabel',
    'chromePageElsewhere',
    'chromeSetupTitle',
    'chromeStep1',
    'chromeStep2',
    'chromeStep3',
    'copyAddress',
    'chromeConfirmProfile',
    'showInChrome',
    'grantUnavailable',
    'chromeConnectAction',
    'chromePickTabTitle',
    'chromeEmptyTabs',
    'chromeOpenInWindow',
    'chromeTabSummary',
   ] as const){
    expect({id,key,text:legacy[key],matchesBanned:banned.test(legacy[key])}).toEqual({
     id,
     key,
     text:legacy[key],
     matchesBanned:false,
    });
   }
  }
 });

 test('A1b gap keys (Hermes logic, H1 Chrome flow and spec audit) exist with matching placeholders across all 7 languages',()=>{
  for(const {id} of APP_LANGUAGES){
   const ui=workroomBrowserUiCopy(id);
   const legacy=workroomBrowserCopy(id);
   expect(ui.toolbar.identityPrivateNetwork.length).toBeGreaterThan(0);
   expect(ui.toolbar.identityPrivateNetwork).not.toBe(ui.toolbar.identityLocal);
   expect(ui.owner.retryConnect.length).toBeGreaterThan(0);
   expect(ui.owner.retryConnect).not.toBe(ui.owner.reconnect);
   expect(ui.activity.reviewed.length).toBeGreaterThan(0);
   expect(placeholders(ui.activity.unnamedTarget)).toEqual(['role']);
   expect(ui.activity.unnamedElement.length).toBeGreaterThan(0);
   for(const role of ['button','link','textbox','checkbox','combobox','generic'] as const){
    expect(ui.activity.roles[role].trim().length).toBeGreaterThan(0);
   }
   expect(placeholders(ui.chrome.tabSummary)).toEqual(['host','title']);
   expect(placeholders(legacy.chromeTabSummary)).toEqual(['host','title']);
   expect(ui.chrome.openInWindow.length).toBeGreaterThan(0);
   expect(ui.chrome.pickTabTitle.length).toBeGreaterThan(0);
   expect(ui.chrome.emptyTabs.length).toBeGreaterThan(0);
   expect(placeholders(ui.recoveries.meta)).toEqual(['host','time']);
   expect(placeholders(ui.toolbar.consoleErrors)).toEqual(['n']);
  }
 });

 test('control-bar and waiting strings are at most 48 characters in en and de',()=>{
  for(const lang of ['en','de'] as const){
   const ui=workroomBrowserUiCopy(lang);
   for(const [groupName,group] of [
    ['owner',ui.owner],
    ['bar',ui.bar],
    ['waiting',ui.waiting],
   ] as const){
    for(const [key,text] of Object.entries(group)){
     expect({lang,groupName,key,text,length:text.length,withinBudget:text.length<=48}).toEqual({
      lang,
      groupName,
      key,
      text,
      length:text.length,
      withinBudget:true,
     });
    }
   }
   const legacy=workroomBrowserCopy(lang);
   for(const key of ['detachedOwned','detachedChrome','reviewDone'] as const){
    const text=legacy[key];
    expect({lang,key,text,length:text.length,withinBudget:text.length<=48}).toEqual({
     lang,
     key,
     text,
     length:text.length,
     withinBudget:true,
    });
   }
  }
 });

 test('Korean templates around {target} and {host} do not attach batchim-dependent particles',()=>{
  const batchimParticle=/\{(target|host)\}(을|를|이|가|은|는|과|와)/;
  for(const [moduleName,accessor] of Object.entries(modules)){
   for(const leaf of collectLeaves(accessor('ko'))){
    expect({moduleName,path:leaf.path,text:leaf.text,hasBatchimParticle:batchimParticle.test(leaf.text)}).toEqual({
     moduleName,
     path:leaf.path,
     text:leaf.text,
     hasBatchimParticle:false,
    });
   }
  }
 });
});
