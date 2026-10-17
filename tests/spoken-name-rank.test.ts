import {expect,test} from 'bun:test';
import {rankBySpokenName,spokenKey,spokenNameScore} from '../src/spokenNameRank';

test('a Korean transcription of an English name reads like the name itself',()=>{
  for(const [heard,name] of [['바이브2','vibe2'],['클로드','claude'],['헤르메스','hermes'],['코덱스','codex'],['안티그래비티','antigravity'],['깃허브','github']] as const){
    expect(spokenKey(heard),`${heard} ≈ ${name}`).toBe(spokenKey(name));
  }
  expect(spokenKey('바이브2')).not.toBe(spokenKey('vibe'));
  expect(spokenKey('')).toBe('');
});

test('what was said ranks first; a different number ranks below the same number',()=>{
  const projects=[{name:'project-2-app'},{name:'vibe'},{name:'프로젝트2번'},{name:'Vibe Coding Guide v3'},{name:'vibe2'},{name:'vibe3'}];
  expect(rankBySpokenName('바이브2',projects).map(project=>project.name).slice(0,2)).toEqual(['vibe2','vibe']);
  expect(spokenNameScore('바이브2',['vibe2'])).toBeGreaterThan(spokenNameScore('바이브2',['vibe3']));
  // Aliases count: 헤르메스 is called by its English alias too.
  expect(rankBySpokenName('클로드 에이전트 컨피그',[{name:'vibe2'},{name:'헤르메스',aliases:['Claude Agent Config']}])[0]!.name).toBe('헤르메스');
  // Typed Latin text that is part of a name still ranks that name first.
  expect(rankBySpokenName('vibe',[{name:'project-1-app'},{name:'vibe2'}])[0]!.name).toBe('vibe2');
});

test('ranking is only an order: every item stays, and ties keep their original order',()=>{
  const projects=Array.from({length:50},(_,index)=>({name:`project-${index}-app`}));
  const ranked=rankBySpokenName('전혀 다른 이름',projects);
  expect(ranked).toHaveLength(50);
  expect(new Set(ranked)).toEqual(new Set(projects));
  expect(rankBySpokenName('',projects)).toEqual(projects);
});
