import {expect,test} from 'bun:test';
import {APP_LANGUAGES,browserContextMessages,browserContextText,projectStateCopy,projectStateTranslations,readToolBatchCopy,readToolBatchMessages,workModeCopy,workModeMessages,type CopyShape,type Lang} from '../src/i18n';
import {workModeDuration,workModeRemaining} from '../src/WorkModeControl';

// Feature copy blocks live beside the main catalog; they follow the same discipline.
const blocks={projectStateTranslations,browserContextMessages,readToolBatchMessages,workModeMessages} as const;
const accessors={projectStateTranslations:projectStateCopy,browserContextMessages:browserContextText,readToolBatchMessages:readToolBatchCopy,workModeMessages:workModeCopy} as const;

type Leaf={path:string;text:unknown};
function leaves(value:unknown,path=''):Leaf[] {
 if(value===null||typeof value!=='object')return [{path,text:value}];
 return Object.keys(value).sort().flatMap(key=>leaves((value as Record<string,unknown>)[key],path?`${path}.${key}`:key));
}
const fields=(text:string)=>[...text.matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort();

test('every feature copy block has exactly the Korean keys, non-empty text and the same placeholders in all seven languages',()=>{
 for(const [name,block] of Object.entries(blocks)){
  const korean=leaves(block.ko);
  expect(Object.keys(block).sort()).toEqual(APP_LANGUAGES.map(l=>l.id).sort());
  for(const {id} of APP_LANGUAGES){
   const own=leaves(block[id]);
   expect({name,id,paths:own.map(l=>l.path)}).toEqual({name,id,paths:korean.map(l=>l.path)});
   own.forEach((leaf,index)=>{
    expect(typeof leaf.text).toBe('string');
    expect({name,id,path:leaf.path,empty:(leaf.text as string).trim().length===0}).toEqual({name,id,path:leaf.path,empty:false});
    expect({name,id,path:leaf.path,fields:fields(leaf.text as string)}).toEqual({name,id,path:leaf.path,fields:fields(korean[index]!.text as string)});
   });
  }
 }
});

test('only Korean and English share wording; the other languages are translated, not English copies',()=>{
 for(const [name,block] of Object.entries(blocks))for(const id of ['ja','zh-CN','es','fr','de'] as const){
  const own=leaves(block[id]),english=leaves(block.en);
  const copied=own.filter((leaf,index)=>leaf.text===english[index]!.text&&/[a-z]{4}/.test(leaf.text as string)).map(l=>l.path);
  // Product names and short technical labels (Git, min, Tester…) may legitimately match English.
  expect({name,id,copied:copied.length<=Math.ceil(own.length*.15)}).toEqual({name,id,copied:true});
 }
});

test('accessors return each language and fall back to English only for an unknown value',()=>{
 for(const [name,accessor] of Object.entries(accessors)){
  const block=blocks[name as keyof typeof blocks];
  for(const {id} of APP_LANGUAGES)expect(accessor(id) as unknown).toBe(block[id]);
  expect(accessor('xx' as Lang) as unknown).toBe(block.en);
 }
});

test('work mode Korean durations keep their original wording, and other languages use their own units',()=>{
 const now=1_700_000_000_000,at=(minutes:number)=>now+minutes*60000;
 expect(workModeRemaining(at(0),now)).toBe('0분');
 expect(workModeRemaining(at(29.2),now)).toBe('30분');
 expect(workModeRemaining(at(60),now)).toBe('1시간');
 expect(workModeRemaining(at(90),now)).toBe('1시간 30분');
 expect(workModeRemaining(at(1440),now)).toBe('24시간');
 expect(workModeRemaining(at(-5),now)).toBe('0분');
 expect([30,60,120,240,480,1440].map(m=>workModeDuration(m))).toEqual(['30분','1시간','2시간','4시간','8시간','24시간']);
 expect(workModeRemaining(at(90),now,'en')).toBe('1 hr 30 min');
 expect(workModeRemaining(at(90),now,'ja')).toBe('1時間30分');
 expect(workModeRemaining(at(90),now,'zh-CN')).toBe('1 小时 30 分钟');
 expect(workModeRemaining(at(90),now,'de')).toBe('1 Std. 30 Min.');
 for(const {id} of APP_LANGUAGES)for(const minutes of [0,30,60,90,1440])expect(workModeDuration(minutes,id)).not.toMatch(/\{\w+\}/);
});

test('a missing key, an extra key, a missing nested key or a missing language is a type error',()=>{
 // Compile-time guarantees, checked by `bun run typecheck` (tests are in the project).
 type W=CopyShape<typeof workModeMessages.ko>;
 const {stop:_stop,...withoutStop}=workModeMessages.de;
 // @ts-expect-error a language that lacks one key is rejected
 const missingKey:Record<Lang,W>={...workModeMessages,de:withoutStop};
 // @ts-expect-error an extra key in one language is rejected
 const extraKey:Record<Lang,W>={...workModeMessages,fr:{...workModeMessages.fr,extra:'x'}};
 const {de:_de,...withoutGerman}=workModeMessages;
 // @ts-expect-error a missing language is rejected
 const missingLanguage:Record<Lang,W>=withoutGerman;
 type R=CopyShape<typeof readToolBatchMessages.ko>;
 const {skipped:_skipped,...states}=readToolBatchMessages.es.states;
 // @ts-expect-error a missing nested key is rejected
 const missingNested:Record<Lang,R>={...readToolBatchMessages,es:{...readToolBatchMessages.es,states}};
 expect([missingKey,extraKey,missingLanguage,missingNested].length).toBe(4);
});
