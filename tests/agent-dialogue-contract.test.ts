import {describe,expect,test} from 'bun:test';
import {parseAgentDialogueRequest,parseAgentDialogueTarget} from '../src/agentDialogueContract';

const a='11111111-1111-4111-8111-111111111111';
const b='22222222-2222-4222-8222-222222222222';
describe('cross-device agent dialogue contract',()=>{
  test('OPS and project are distinct exact local targets',()=>{
    expect(parseAgentDialogueTarget({target:'ops'})).toEqual({target:'ops'});
    expect(parseAgentDialogueTarget({portId:'local-a'})).toEqual({portId:'local-a'});
    expect(()=>parseAgentDialogueTarget({target:'ops',portId:'local-a'})).toThrow();
    expect(()=>parseAgentDialogueTarget({portId:' same-name '})).toThrow();
  });
  test('different-memory peers use exact endpoint IDs; names or memory IDs cannot route',()=>{
    expect(parseAgentDialogueRequest({operation:'create',source:{target:'ops'},endpointIds:[a,b],requestId:a})).toEqual({operation:'create',source:{target:'ops'},endpointIds:[a,b],requestId:a});
    expect(()=>parseAgentDialogueRequest({operation:'create',source:{portId:'A'},endpointIds:['qq'],requestId:a})).toThrow();
    expect(()=>parseAgentDialogueRequest({operation:'create',source:{portId:'A'},endpointIds:[a,a],requestId:b})).toThrow();
    expect(()=>parseAgentDialogueRequest({operation:'create',source:{portId:'A'},endpointIds:[a],requestId:b,memoryId:'same'})).toThrow();
  });
  test('bounded untrusted message and cursor input',()=>{
    const base={operation:'send',source:{portId:'A'},roomId:a,participantId:b,requestId:a,kind:'question'};
    expect(parseAgentDialogueRequest({...base,text:' 질문\r\n답 '})).toMatchObject({text:'질문\n답'});
    expect(()=>parseAgentDialogueRequest({...base,text:'a'.repeat(4001)})).toThrow();
    expect(()=>parseAgentDialogueRequest({...base,text:'\0bad'})).toThrow();
    expect(()=>parseAgentDialogueRequest({operation:'wait',source:{target:'ops'},roomId:a,participantId:b,afterSeq:-1})).toThrow();
    expect(()=>parseAgentDialogueRequest({operation:'wait',source:{target:'ops'},roomId:a,participantId:b,afterSeq:0,timeoutMs:30001})).toThrow();
  });
});
