import {expect,test} from 'bun:test';
import {parseVoicePopout} from '../src/voicePopout';
import {parseTesterRequest} from '../src/testerAgentContract';

test('voice popout route carries no paths, provider settings or secrets',()=>{
  expect(parseVoicePopout('?voice-popout=1')).toEqual({panel:false});
  expect(parseVoicePopout('?voice-popout=1&panel=1')).toEqual({panel:true});
  for(const query of ['?voice-popout=1&token=abc','?voice-popout=1&panel=2','?voice-popout=1&voice-popout=1','?voice-popout=%31','?voice-popout=1#x'])expect(parseVoicePopout(query)).toBeNull();
});
test('persona review wire requires a current revision and real bounded check choices',()=>{
  const request={operation:'persona-accept' as const,portId:'project',candidateId:'context-123',revision:'a'.repeat(64),goal:'작성 중인 사용자',checkIds:['web']};
  expect(parseTesterRequest(request)).toEqual(request);
  for(const patch of [{revision:''},{checkIds:[]},{checkIds:['web','web']},{checkIds:['../shell']},{goal:''},{goal:'invalid\0goal'},{candidateId:'../role'},{path:'/tmp'}])expect(()=>parseTesterRequest({...request,...patch})).toThrow();
  expect(parseTesterRequest({operation:'handoff',portId:'project',mode:'persona-context'}).mode).toBe('persona-context');
  expect(()=>parseTesterRequest({operation:'persona-review',portId:'project',goal:'cannot mutate while reading'})).toThrow();
});
