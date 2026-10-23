import {describe,expect,test} from 'bun:test';
import {voiceMentionReferences} from '../src/voiceMentionReferences';

const selected = [{id:'project-a',label:'테스트 프로젝트'},{id:'project-b',label:'Alpha'}];

describe('voice dock selected # references',()=>{
  test('keeps exact names with whitespace, punctuation and multiple mentions',()=>{
    expect(voiceMentionReferences('#테스트 프로젝트, #Alpha 확인해 줘',selected)).toEqual(['project-a','project-b']);
    expect(voiceMentionReferences('다음은 #테스트 프로젝트',selected)).toEqual(['project-a']);
  });

  test('drops a selected reference when the user edits its token into a different name',()=>{
    expect(voiceMentionReferences('#테스트 프로젝트X 상태 봐 줘',selected)).toEqual([]);
    expect(voiceMentionReferences('#Alpha2 #Alpha_B #Alpha/다른기기 #Alpha-Next',selected)).toEqual([]);
    expect(voiceMentionReferences('참고 토큰 삭제',selected)).toEqual([]);
  });

  test('a later exact occurrence still counts after a changed prefix',()=>{
    expect(voiceMentionReferences('#Alpha2와 #Alpha 확인',selected)).toEqual(['project-b']);
  });
});
