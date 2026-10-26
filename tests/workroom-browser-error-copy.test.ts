import {describe,expect,test} from 'bun:test';
import {APP_LANGUAGES,type Lang} from '../src/i18n';
import {BROWSER_ERROR_CODES} from '../src/workroomBrowserErrorCodes';
import {
 BROWSER_LOAD_ERROR_CODES,
 workroomBrowserErrorCopy,
 workroomBrowserErrorMessages,
 workroomBrowserPageErrorCopy,
 workroomBrowserPageErrorMessages,
} from '../src/workroomBrowserErrorCopy';

const placeholders=(text:string)=>[...text.matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort();

function collectPageErrorStrings(lang:Lang):Array<{path:string;text:string}>{
 const page=workroomBrowserPageErrorCopy(lang);
 const entries:Array<{path:string;text:string}>=[
  {path:'title',text:page.title},
  {path:'offlineTitle',text:page.offlineTitle},
  {path:'tryHeading',text:page.tryHeading},
  {path:'tryServer',text:page.tryServer},
  {path:'tryAddress',text:page.tryAddress},
  {path:'tryNetwork',text:page.tryNetwork},
  {path:'retry',text:page.retry},
  {path:'editAddress',text:page.editAddress},
 ];
 page.tryList.forEach((item,idx)=>{
  entries.push({path:`tryList[${idx}]`,text:item});
 });
 for(const code of BROWSER_LOAD_ERROR_CODES){
  const card=page.cards[code];
  entries.push(
   {path:`cards.${code}.title`,text:card.title},
   {path:`cards.${code}.cause`,text:card.cause},
   {path:`cards.${code}.tryHeading`,text:card.tryHeading},
   {path:`cards.${code}.retry`,text:card.retry},
   {path:`cards.${code}.editAddress`,text:card.editAddress},
  );
  card.tryList.forEach((item,idx)=>{
   entries.push({path:`cards.${code}.tryList[${idx}]`,text:item});
  });
 }
 return entries;
}

describe('Workroom browser error and load-failure copy (7 languages)',()=>{
 test('every error code × language is present, non-empty, and distinct from generic where required',()=>{
  expect(Object.keys(workroomBrowserErrorMessages).sort()).toEqual(APP_LANGUAGES.map(l=>l.id).sort());
  expect(Object.keys(workroomBrowserPageErrorMessages).sort()).toEqual(APP_LANGUAGES.map(l=>l.id).sort());
  expect(workroomBrowserErrorCopy('xx' as Lang)).toBe(workroomBrowserErrorMessages.en);
  expect(workroomBrowserPageErrorCopy('xx' as Lang)).toBe(workroomBrowserPageErrorMessages.en);

  for(const {id} of APP_LANGUAGES){
   const table=workroomBrowserErrorCopy(id);
   expect(Object.keys(table).sort()).toEqual([...BROWSER_ERROR_CODES].sort());
   const genericText=table.generic;
   expect(genericText.trim().length).toBeGreaterThan(0);

   for(const code of BROWSER_ERROR_CODES){
    const text=table[code];
    expect(typeof text).toBe('string');
    expect({id,code,empty:text.trim().length===0}).toEqual({
     id,
     code,
     empty:false,
    });
    if(code!=='generic'){
     expect({id,code,sameAsGeneric:text===genericText}).toEqual({
      id,
      code,
      sameAsGeneric:false,
     });
    }
   }

   for(const entry of collectPageErrorStrings(id)){
    expect({id,path:entry.path,empty:entry.text.trim().length===0}).toEqual({
     id,
     path:entry.path,
     empty:false,
    });
   }
  }
 });

 test('placeholders match across all 7 languages for every error code and page-error card field',()=>{
  const koErrors=workroomBrowserErrorCopy('ko');
  const koPage=collectPageErrorStrings('ko');

  for(const {id} of APP_LANGUAGES){
   const langErrors=workroomBrowserErrorCopy(id);
   for(const code of BROWSER_ERROR_CODES){
    expect({id,code,placeholders:placeholders(langErrors[code])}).toEqual({
     id,
     code,
     placeholders:placeholders(koErrors[code]),
    });
   }

   const langPage=collectPageErrorStrings(id);
   langPage.forEach((entry,idx)=>{
    expect({id,path:entry.path,placeholders:placeholders(entry.text)}).toEqual({
     id,
     path:entry.path,
     placeholders:placeholders(koPage[idx]!.text),
    });
   });
  }
 });

 test('no error or page-error string contains Error:, system jargon, or English leaks in non-en languages',()=>{
  const bannedJargon=/Error:|빌드|\bbuild\b|Chromium|\bCDP\b|\bowned\b|아젠투지/i;
  const englishLeakInRomanceOrGerman=/\b(Workroom|timeout|offline|localhost|refused|certificate|disconnected|session ended|could not|try again|check whether|take over|address bar|dev server)\b/i;

  for(const {id} of APP_LANGUAGES){
   const allEntries=[
    ...BROWSER_ERROR_CODES.map(code=>({path:`error.${code}`,text:workroomBrowserErrorCopy(id)[code]})),
    ...collectPageErrorStrings(id).map(e=>({path:`page.${e.path}`,text:e.text})),
   ];

   for(const {path,text} of allEntries){
    expect({id,path,text,matchesBanned:bannedJargon.test(text)}).toEqual({
     id,
     path,
     text,
     matchesBanned:false,
    });

    if(id==='ko'||id==='ja'||id==='zh-CN'){
     const stripped=text.replace(/\{host\}|\bChrome\b|\bGoogle\b/g,'');
     expect({id,path,text,hasEnglishLetters:/[A-Za-z]/.test(stripped)}).toEqual({
      id,
      path,
      text,
      hasEnglishLetters:false,
     });
    }else if(id!=='en'){
     expect({id,path,text,hasEnglishLeak:englishLeakInRomanceOrGerman.test(text)}).toEqual({
      id,
      path,
      text,
      hasEnglishLeak:false,
     });
    }
   }
  }
 });

 test('approval-pending explains that another browser connection is finishing without asking for human approval',()=>{
  const misleadingApproval=/승인|\bapprov(e|al)\b|承認|批准|\baprobar\b|\bapprouver\b|\bgenehmigen\b/i;
  for(const {id} of APP_LANGUAGES){
   const text=workroomBrowserErrorCopy(id)['approval-pending'];
   expect({id,text,mentionsApproval:misleadingApproval.test(text)}).toEqual({
    id,
    text,
    mentionsApproval:false,
   });
  }
 });

 test('Korean {host} templates never attach batchim-dependent particles directly after {host}',()=>{
  const batchimParticle=/\{host\}(을|를|이|가|은|는|과|와)/;
  const koEntries=[
   ...BROWSER_ERROR_CODES.map(code=>({path:`error.${code}`,text:workroomBrowserErrorCopy('ko')[code]})),
   ...collectPageErrorStrings('ko').map(e=>({path:`page.${e.path}`,text:e.text})),
  ];
  for(const {path,text} of koEntries){
   expect({path,text,hasBatchimParticle:batchimParticle.test(text)}).toEqual({
    path,
    text,
    hasBatchimParticle:false,
   });
  }
 });
});
