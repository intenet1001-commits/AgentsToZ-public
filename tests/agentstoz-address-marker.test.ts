import {expect,test} from 'bun:test';
import {addressedToAgentsToZ,stripAgentsToZAddressMarker} from '../src/voiceOrchestrationGuidance';

test('@@ addresses 총괄 explicitly, and the rest of the line keeps its own sigils',()=>{
  // 담당자(릴레이) 모드에서는 적은 글이 그 CLI로 그대로 들어간다. `@@`는 그 글을 총괄에게 돌린다.
  for(const text of ['@@아젠투지 테스트해보자','@@ 총괄 상황 알려줘','@@AgentsToZ status?','@@메인: 정리해줘'])
    expect(addressedToAgentsToZ(text)).toBe(true);
  // 프로젝트 호출(@이름)·언급(#이름)과 겹치지 않는다.
  expect(addressedToAgentsToZ('@vibe2 테스트해보자')).toBe(false);
  expect(addressedToAgentsToZ('#vibe2 를 참고해')).toBe(false);
  // 표시를 떼어내면 뒤의 기호는 그대로 남는다 — 「@@아젠투지 @테스트해보자」가 쓰고 싶은 모양이다.
  expect(stripAgentsToZAddressMarker('@@아젠투지 @테스트해보자')).toEqual({addressed:true,text:'@테스트해보자'});
  expect(stripAgentsToZAddressMarker('그냥 글')).toEqual({addressed:false,text:'그냥 글'});
  // 문장 맨 앞에서만 인정한다(가운데의 @@는 내용이다).
  expect(addressedToAgentsToZ('로그에 @@아젠투지 라고 찍혀 있어')).toBe(false);
  // 말로 부르던 기존 규칙은 그대로다.
  expect(addressedToAgentsToZ('아젠투지, 상황 알려줘')).toBe(true);
  expect(addressedToAgentsToZ('총괄적으로 보면')).toBe(false);
});
