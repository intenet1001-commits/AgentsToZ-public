import {expect,test} from 'bun:test';
import {matchesProjectSearch} from '../src/projectSearch';
import {consonantSkeleton,hangulQuerySkeleton,matchesPhoneticName} from '../src/phoneticSearch';

const shadow={id:'5d8e5071-1111-4111-8111-111111111111',name:'ShadowLoop',aiName:'Shadow Loop English Coach',folderPath:'/Users/x/ShadowLoop'};
const hermes={id:'aaaaaaaa-1111-4111-8111-111111111111',name:'헤르메스',aiName:'Claude Agent Config'};
const project={id:'bbbbbbbb-1111-4111-8111-111111111111',name:'project-tracker'};
const vibe={id:'cccccccc-1111-4111-8111-111111111111',name:'vibe2'};
const all=[shadow,hermes,project,vibe];
const found=(query:string)=>all.filter(p=>matchesProjectSearch(p,query)).map(p=>p.name);

test('the copied reference line finds exactly that project by its code', ()=>{
  expect(found('#ShadowLoop [로컬프로젝트해시: 5D8E5071]')).toEqual(['ShadowLoop']);
  // The code decides, not the name: a renamed project is still found by an old reference.
  expect(found('#옛이름 [로컬프로젝트해시: 5D8E5071]')).toEqual(['ShadowLoop']);
  expect(found('[로컬프로젝트해시: 5d8e5071]')).toEqual(['ShadowLoop']);
  expect(found('5D8E5071')).toEqual(['ShadowLoop']);
  expect(found('#ShadowLoop')).toEqual(['ShadowLoop']);
});

test('a Korean reading of an English name finds it, however it is spelled', ()=>{
  for(const query of ['쉐도우루프','섀도루프','섀도우 루프','ㅅㄷㅇㄹㅍ','ㅅㄷㄹㅍ'])
    expect({query,found:found(query)}).toEqual({query,found:['ShadowLoop']});
  expect(found('프로젝트')).toEqual(['project-tracker']);
  expect(found('ㅍㄹㅈㅌ')).toEqual(['project-tracker']);
});

test('what already worked keeps working', ()=>{
  expect(found('shadow')).toEqual(['ShadowLoop']);
  expect(found('ㅎㄹㅁㅅ')).toEqual(['헤르메스']);
  expect(found('gpfmaptm')).toEqual(['헤르메스']);
  expect(found('claude')).toEqual(['헤르메스']);
});

test('search aliases are searched, including their initials', ()=>{
  const p={id:'dddddddd-1111-4111-8111-111111111111',name:'tradingvolume1',searchAliases:['거래량 분석']};
  expect(matchesProjectSearch(p,'거래량')).toBe(true);
  expect(matchesProjectSearch(p,'ㄱㄹㄹ')).toBe(true);
  expect(matchesProjectSearch(p,'ShadowLoop')).toBe(false);
});

test('short or unrelated readings do not match everything', ()=>{
  // Two consonants are too little to compare by sound; only literal text matches then.
  expect(found('바이')).toEqual([]);
  expect(found('ㅂㅂ')).toEqual([]);
  expect(found('쉐도우루프트레이너')).toEqual([]);
  expect(found('주식')).toEqual([]);
});

test('the consonant skeleton is the same for English and a romanized reading', ()=>{
  expect(consonantSkeleton('ShadowLoop')).toBe('STLP');
  expect(hangulQuerySkeleton('쉐도우루프')).toBe('STLP');
  expect(hangulQuerySkeleton('ㅅㄷㅇㄹㅍ')).toBe('STLP');
  expect(consonantSkeleton('project')).toBe('PLJKT');
  expect(hangulQuerySkeleton('프로젝트')).toBe('PLJKT');
  expect(matchesPhoneticName('Shadow Loop English Coach','잉글리시')).toBe(true);
  expect(matchesPhoneticName('ShadowLoop','dfsf')).toBe(false);
});

test('sound-alike matches stay on word boundaries and agree on how the reading begins', ()=>{
  // Real false positives from the 141-project list (2026-10-06) before these rules.
  expect(matchesPhoneticName('Data Workflow Orchestration','트래커')).toBe(false);   // T + LKPL across words
  expect(matchesPhoneticName('Outlook','트래커')).toBe(false);                       // same TLK, but 아웃룩 opens with ㅇ
  expect(matchesPhoneticName('Outlook','아웃룩')).toBe(true);
  expect(matchesPhoneticName('Schedule Web App','ㅅㄷㅇㄹㅍ')).toBe(false);          // ch opens a syllable; not a batchim
  expect(matchesPhoneticName('Performance Goals Tracker','트래커')).toBe(true);
  expect(matchesPhoneticName('MAU Analytics Dashboard','대시보드')).toBe(true);       // silent r: board → 보드
  expect(matchesPhoneticName('MAU Analytics Dashboard','ㄷㅅㅂㄷ')).toBe(true);
});
