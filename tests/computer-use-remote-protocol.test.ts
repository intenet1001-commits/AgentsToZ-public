import {describe,expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {AgentDialogueHostError} from '../src/agentDialogueHost';
import {
  COMMUNITY_CONTROL_POLL_BUSY_MESSAGE,
  COMPUTER_USE_REMOTE_ACTUAL_RECEIPT_STATES,
  COMPUTER_USE_REMOTE_CALL_OPERATIONS,
  COMPUTER_USE_REMOTE_ENVELOPE_REFUSALS,
  COMPUTER_USE_REMOTE_ERRORS,
  COMPUTER_USE_REMOTE_ERROR_CODES,
  COMPUTER_USE_REMOTE_LIMITS,
  COMPUTER_USE_REMOTE_NOT_RUN_REASONS,
  COMPUTER_USE_REMOTE_REQUEST_BOX_MAX_CHARS,
  COMPUTER_USE_REMOTE_UNKNOWN_FINAL_MESSAGE,
  ComputerUseRemoteError,
  classifyComputerUseRemoteBadAnswer,
  classifyComputerUseRemoteRefusal,
  classifyComputerUseRemoteTransportFailure,
  computerUseRemoteCleanText,
  computerUseRemoteConnectionTag,
  computerUseRemoteEffect,
  computerUseRemoteEnvelopeRefusal,
  computerUseRemoteErrorMessage,
  computerUseRemotePartMatches,
  computerUseRemotePartRequest,
  computerUseRemotePlatform,
  computerUseRemoteReceiptAnswer,
  computerUseRemoteSentAtCheck,
  isComputerUseRemoteInput,
  isComputerUseRemoteRequest,
  isComputerUseRemoteStateChange,
  newComputerUseRemoteId,
  parseComputerUseRemoteCallMeta,
  parseComputerUseRemoteEnvelope,
  parseComputerUseRemoteReply,
  remoteReceiptVerdict,
  type ComputerUseRemoteClassified,
  type ComputerUseRemoteClassifyOptions,
  type ComputerUseRemoteLedgerEntry,
} from '../src/computerUseRemoteProtocol';
import {
  COMMUNITY_CONTROL_EXECUTE_TIMEOUT_MESSAGE,
  COMMUNITY_CONTROL_RESPONSE_TOO_LARGE_MESSAGE,
  OPS_REQUEST_LEGACY_UNSUPPORTED_MESSAGE,
} from '../src/opsRequestProtocol';
import {generateComputerUseRemoteKeyPair} from '../src/computerUseRemoteCrypto';

const session='0123456789abcdef0123456789abcdef';
const instance='fedcba9876543210fedcba9876543210';
const ref='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const box=(chars:number)=>'A'.repeat(chars);
const pub=(await generateComputerUseRemoteKeyPair()).publicKey;
const envelopes={
  hello:{kind:'computer-use',v:1,op:'hello',session,seq:0,sentAt:1_700_000_000_000,pub,instance,platform:'darwin'},
  call:{kind:'computer-use',v:1,op:'call',session,seq:1,sentAt:1_700_000_000_000,box:box(32)},
  part:{kind:'computer-use',v:1,op:'part',session,seq:2,sentAt:1_700_000_000_000,ref,index:1},
  heartbeat:{kind:'computer-use',v:1,op:'heartbeat',session,seq:3,sentAt:1_700_000_000_000,bg:1,box:box(32)},
  disconnect:{kind:'computer-use',v:1,op:'disconnect',session,seq:4,sentAt:1_700_000_000_000,bg:1,box:box(32)},
} as const;
/** One request of each effect: an input, the two state changes without a requestId (and disconnect), reads. */
const INPUT={operation:'scope-click',requestId:'click-0001'} as const satisfies ComputerUseRemoteClassifyOptions;
const STATE_CHANGES=[{operation:'scope-request-access'},{operation:'scope-request-human'},{operation:'disconnect'}] as const satisfies readonly ComputerUseRemoteClassifyOptions[];
const READS=[{operation:'scope-status'},{operation:'scope-observe'},{operation:'scope-capture'},{operation:'scope-receipt'},{operation:'hello'},
  {operation:'heartbeat'}] as const satisfies readonly ComputerUseRemoteClassifyOptions[];
const ALL_OPTIONS:readonly ComputerUseRemoteClassifyOptions[]=[INPUT,...STATE_CHANGES,...READS];
/** A classified result never contradicts its own code's outcome in the §10 table. */
function consistent(result:ComputerUseRemoteClassified){
  expect(result.outcome).toBe(COMPUTER_USE_REMOTE_ERRORS[result.code].outcome);
  return result;
}
function refused(value:unknown){
  try{parseComputerUseRemoteEnvelope(value);}catch(error){
    expect(error).toBeInstanceOf(ComputerUseRemoteError);
    expect((error as ComputerUseRemoteError).code).toBe('REMOTE_BAD_REQUEST');
    expect((error as ComputerUseRemoteError).outcome).toBe('not-run');
    return true;
  }
  return false;
}

describe('computer-use remote envelopes',()=>{
  test('each op parses with exactly its own keys',()=>{
    for(const [op,value] of Object.entries(envelopes)){
      const parsed=parseComputerUseRemoteEnvelope(structuredClone(value));
      expect(parsed.op).toBe(op as never);
      expect(parsed).toEqual(value as never);
      expect(isComputerUseRemoteRequest(value)).toBe(true);
    }
    expect(isComputerUseRemoteRequest({kind:'terminal',body:{}})).toBe(false);
    expect(isComputerUseRemoteRequest(null)).toBe(false);
  });
  test('refuses an unknown key, a missing key and a key of another op',()=>{
    for(const value of Object.values(envelopes)){
      expect(refused({...value,extra:1})).toBe(true);
      for(const key of Object.keys(value)){
        const {[key]:_omitted,...rest}=value as Record<string,unknown>;
        expect(refused(rest)).toBe(true);
      }
    }
    expect(refused({...envelopes.call,bg:1})).toBe(true);
    expect(refused({...envelopes.call,platform:'darwin'})).toBe(true);
    expect(refused({...envelopes.hello,box:box(32)})).toBe(true);
    // Plaintext client names never ride outside the box (§8.1).
    expect(refused({...envelopes.hello,client:'Claude Code'})).toBe(true);
    expect(refused({...envelopes.call,kind:'terminal'})).toBe(true);
    expect(refused({...envelopes.call,v:2})).toBe(true);
    expect(refused({...envelopes.call,op:'receipt'})).toBe(true);
    expect(refused([envelopes.call])).toBe(true);
    expect(refused('{}')).toBe(true);
  });
  test('refuses an oversized or non-canonical box',()=>{
    expect(COMPUTER_USE_REMOTE_REQUEST_BOX_MAX_CHARS).toBe(21_356);
    expect(parseComputerUseRemoteEnvelope({...envelopes.call,box:box(COMPUTER_USE_REMOTE_REQUEST_BOX_MAX_CHARS)}).op).toBe('call');
    expect(refused({...envelopes.call,box:box(COMPUTER_USE_REMOTE_REQUEST_BOX_MAX_CHARS+4)})).toBe(true);
    expect(refused({...envelopes.heartbeat,box:box(COMPUTER_USE_REMOTE_REQUEST_BOX_MAX_CHARS+4)})).toBe(true);
    expect(refused({...envelopes.call,box:box(20)})).toBe(true); // shorter than a GCM tag (24 characters)
    expect(refused({...envelopes.call,box:box(33)})).toBe(true);
    expect(refused({...envelopes.call,box:'A'.repeat(31)+'-'})).toBe(true);
    expect(refused({...envelopes.call,box:'A'.repeat(30)+'=A'})).toBe(true);
    expect(refused({...envelopes.call,box:42})).toBe(true);
  });
  test('refuses a sequence number out of range',()=>{
    expect(refused({...envelopes.hello,seq:1})).toBe(true);
    for(const seq of [0,-1,1.5,2**53,Number.NaN,'1',null])expect(refused({...envelopes.call,seq})).toBe(true);
    expect(parseComputerUseRemoteEnvelope({...envelopes.call,seq:Number.MAX_SAFE_INTEGER}).seq).toBe(Number.MAX_SAFE_INTEGER);
    for(const sentAt of [0,-5,1.5,'1700000000000',2**53])expect(refused({...envelopes.call,sentAt})).toBe(true);
  });
  test('refuses a platform outside darwin, win32, other and bad identifiers',()=>{
    for(const platform of ['darwin','win32','other'])expect(parseComputerUseRemoteEnvelope({...envelopes.hello,platform}).op).toBe('hello');
    for(const platform of ['linux','Darwin','',null])expect(refused({...envelopes.hello,platform})).toBe(true);
    expect(computerUseRemotePlatform('darwin')).toBe('darwin');
    expect(computerUseRemotePlatform('win32')).toBe('win32');
    expect(computerUseRemotePlatform('linux')).toBe('other');
    expect(refused({...envelopes.hello,instance:instance.toUpperCase()})).toBe(true);
    expect(refused({...envelopes.hello,instance:instance+'00'})).toBe(true);
    expect(refused({...envelopes.call,session:session.slice(1)})).toBe(true);
    expect(refused({...envelopes.part,index:2})).toBe(true);
    expect(refused({...envelopes.part,ref:'z'.repeat(32)})).toBe(true);
    expect(refused({...envelopes.heartbeat,bg:0})).toBe(true);
    expect(refused({...envelopes.disconnect,bg:true})).toBe(true);
    expect(refused({...envelopes.hello,pub:pub.slice(0,-2)})).toBe(true);
    // A compressed point (0x02 prefix) or anything not 65 bytes is not this protocol's key.
    expect(refused({...envelopes.hello,pub:'Ag'+pub.slice(2)})).toBe(true);
  });
  test('a part is built with the seq of the call whose reply it fetches, and matched on session, seq and ref',()=>{
    const call=parseComputerUseRemoteEnvelope(structuredClone(envelopes.call));
    const part=computerUseRemotePartRequest(call,ref,1_700_000_000_900);
    expect(part).toEqual({kind:'computer-use',v:1,op:'part',session,seq:call.seq,sentAt:1_700_000_000_900,ref,index:1});
    expect(parseComputerUseRemoteEnvelope(structuredClone(part))).toEqual(part);
    const cached={session,seq:call.seq,ref};
    expect(computerUseRemotePartMatches(part,cached)).toBe(true);
    // Another call's seq, another reference or another session is not this rest.
    expect(computerUseRemotePartMatches(part,{...cached,seq:call.seq+1})).toBe(false);
    expect(computerUseRemotePartMatches(computerUseRemotePartRequest({session,seq:call.seq+1},ref,1_700_000_000_900),cached)).toBe(false);
    expect(computerUseRemotePartMatches(part,{...cached,ref:'b'.repeat(32)})).toBe(false);
    expect(computerUseRemotePartMatches(part,{...cached,session:'f'.repeat(32)})).toBe(false);
    // A part has no seq of its own: the builder refuses anything a receiver would refuse.
    expect(()=>computerUseRemotePartRequest({session,seq:0},ref,1_700_000_000_900)).toThrow(ComputerUseRemoteError);
    expect(()=>computerUseRemotePartRequest({session,seq:1},'not-a-ref',1_700_000_000_900)).toThrow(ComputerUseRemoteError);
  });
});

describe('computer-use remote replies',()=>{
  const bootId='b'.repeat(32);
  test('hello, call (one or two parts), part and background replies are closed',()=>{
    expect(parseComputerUseRemoteReply('hello',{v:1,pub,bootId})).toEqual({v:1,pub,bootId});
    expect(()=>parseComputerUseRemoteReply('hello',{v:1,pub,bootId,extra:1})).toThrow(ComputerUseRemoteError);
    expect(()=>parseComputerUseRemoteReply('hello',{v:1,pub,bootId:'B'.repeat(32)})).toThrow(ComputerUseRemoteError);
    expect(parseComputerUseRemoteReply('call',{v:1,box:box(32),parts:1})).toEqual({v:1,box:box(32),parts:1});
    const first=box(COMPUTER_USE_REMOTE_LIMITS.partMaxChars);
    expect(parseComputerUseRemoteReply('call',{v:1,box:first,parts:2,ref})).toEqual({v:1,box:first,parts:2,ref});
    // Two parts need the reference and a full first part; one part takes no reference.
    expect(()=>parseComputerUseRemoteReply('call',{v:1,box:first,parts:2})).toThrow(ComputerUseRemoteError);
    expect(()=>parseComputerUseRemoteReply('call',{v:1,box:box(32),parts:2,ref})).toThrow(ComputerUseRemoteError);
    expect(()=>parseComputerUseRemoteReply('call',{v:1,box:box(32),parts:1,ref})).toThrow(ComputerUseRemoteError);
    expect(()=>parseComputerUseRemoteReply('call',{v:1,box:box(32),parts:3,ref})).toThrow(ComputerUseRemoteError);
    expect(()=>parseComputerUseRemoteReply('call',{v:1,box:box(COMPUTER_USE_REMOTE_LIMITS.partMaxChars+4),parts:1})).toThrow(ComputerUseRemoteError);
    expect(parseComputerUseRemoteReply('part',{v:1,box:'AAA='})).toEqual({v:1,box:'AAA='});
    expect(parseComputerUseRemoteReply('heartbeat',{v:1,box:box(32)})).toEqual({v:1,box:box(32)});
    expect(()=>parseComputerUseRemoteReply('disconnect',{v:1,box:box(32),error:'x'})).toThrow(ComputerUseRemoteError);
    expect(()=>parseComputerUseRemoteReply('call',{v:2,box:box(32),parts:1})).toThrow(ComputerUseRemoteError);
    try{parseComputerUseRemoteReply('call',null);}catch(error){expect((error as ComputerUseRemoteError).code).toBe('REMOTE_BAD_ANSWER');}
  });
});

describe('a receiver answer read by its exact sentence',()=>{
  test('the busy sentence is the mailbox poll\'s own answer, character for character',()=>{
    // controlPoll answers it inline (src/agentDialogueHost.ts); if it is reworded there, this mapping would silently stop.
    const source=readFileSync(new URL('../src/agentDialogueHost.ts',import.meta.url),'utf8');
    expect(source).toContain(`'${COMMUNITY_CONTROL_POLL_BUSY_MESSAGE}'`);
  });
  test('an older executor\'s sentence → REMOTE_HOST_OUTDATED, not run',()=>{
    for(const options of ALL_OPTIONS){
      expect(consistent(classifyComputerUseRemoteRefusal(OPS_REQUEST_LEGACY_UNSUPPORTED_MESSAGE,options))).toEqual({outcome:'not-run',
        code:'REMOTE_HOST_OUTDATED',message:COMPUTER_USE_REMOTE_ERRORS.REMOTE_HOST_OUTDATED.message});
    }
  });
  test('the busy sentence → not-run (busy)',()=>{
    for(const options of ALL_OPTIONS){
      const result=consistent(classifyComputerUseRemoteRefusal(COMMUNITY_CONTROL_POLL_BUSY_MESSAGE,options));
      expect(result.outcome).toBe('not-run');
      expect(result).toMatchObject({code:'REMOTE_NOT_RUN',reason:'busy'});
    }
  });
  test('the execution deadline sentence → an input unknown, a state change state-unknown, a read just failed',()=>{
    const input=consistent(classifyComputerUseRemoteRefusal(COMMUNITY_CONTROL_EXECUTE_TIMEOUT_MESSAGE,INPUT));
    expect(input).toEqual({outcome:'unknown',code:'REMOTE_UNKNOWN_OUTCOME',message:computerUseRemoteErrorMessage('REMOTE_UNKNOWN_OUTCOME',{requestId:'click-0001'})});
    expect(input.message).toContain('click-0001');
    expect(input.message).toContain('receipt');
    for(const options of STATE_CHANGES){
      expect(consistent(classifyComputerUseRemoteRefusal(COMMUNITY_CONTROL_EXECUTE_TIMEOUT_MESSAGE,options))).toEqual({outcome:'state-unknown',
        code:'REMOTE_STATE_UNKNOWN',message:COMPUTER_USE_REMOTE_ERRORS.REMOTE_STATE_UNKNOWN.message});
    }
    for(const options of READS)
      expect(consistent(classifyComputerUseRemoteRefusal(COMMUNITY_CONTROL_EXECUTE_TIMEOUT_MESSAGE,options))).toMatchObject({outcome:'read',code:'REMOTE_NO_ANSWER'});
  });
  test('a too-large answer is a bug here: open by effect, flagged',()=>{
    expect(consistent(classifyComputerUseRemoteRefusal(COMMUNITY_CONTROL_RESPONSE_TOO_LARGE_MESSAGE,INPUT))).toMatchObject({outcome:'unknown',bug:true});
    expect(consistent(classifyComputerUseRemoteRefusal(COMMUNITY_CONTROL_RESPONSE_TOO_LARGE_MESSAGE,STATE_CHANGES[0]))).toMatchObject({outcome:'state-unknown',bug:true});
    expect(consistent(classifyComputerUseRemoteRefusal(COMMUNITY_CONTROL_RESPONSE_TOO_LARGE_MESSAGE,READS[1]))).toMatchObject({outcome:'read',bug:true});
  });
  test('every envelope refusal is recovered from its sentence and is unique',()=>{
    const sentences=new Set<string>();
    for(const code of COMPUTER_USE_REMOTE_ENVELOPE_REFUSALS){
      const answer=computerUseRemoteEnvelopeRefusal(code);
      expect(answer.ok).toBe(false);
      expect(sentences.has(answer.error)).toBe(false);sentences.add(answer.error);
      if(code==='REMOTE_PART_LOST')continue;
      for(const options of ALL_OPTIONS)expect(consistent(classifyComputerUseRemoteRefusal(answer.error,options))).toMatchObject({outcome:'not-run',code});
    }
    for(const other of [OPS_REQUEST_LEGACY_UNSUPPORTED_MESSAGE,COMMUNITY_CONTROL_POLL_BUSY_MESSAGE,COMMUNITY_CONTROL_EXECUTE_TIMEOUT_MESSAGE,
      COMMUNITY_CONTROL_RESPONSE_TOO_LARGE_MESSAGE])expect(sentences.has(other)).toBe(false);
  });
  test('a lost part is the loss of its call\'s reply: read for a read (as §10 says), never not-run',()=>{
    const lost=computerUseRemoteEnvelopeRefusal('REMOTE_PART_LOST').error;
    expect(COMPUTER_USE_REMOTE_ERRORS.REMOTE_PART_LOST.outcome).toBe('read');
    for(const part of [true,false]){
      for(const options of READS)
        expect(consistent(classifyComputerUseRemoteRefusal(lost,{...options,part}))).toEqual({outcome:'read',code:'REMOTE_PART_LOST',
          message:COMPUTER_USE_REMOTE_ERRORS.REMOTE_PART_LOST.message});
      // A split reply to an input or a state change cannot happen today (their replies are small); if it ever did, the
      // reply is lost after the call ran — open, never not-run.
      expect(consistent(classifyComputerUseRemoteRefusal(lost,{...INPUT,part}))).toMatchObject({outcome:'unknown',code:'REMOTE_UNKNOWN_OUTCOME'});
      expect(consistent(classifyComputerUseRemoteRefusal(lost,{...STATE_CHANGES[1],part}))).toMatchObject({outcome:'state-unknown'});
    }
    // Any refusal of a part request — even one that would mean "not run" for the request itself — is the call's lost reply.
    for(const error of [computerUseRemoteEnvelopeRefusal('REMOTE_SESSION_MISSING').error,COMMUNITY_CONTROL_POLL_BUSY_MESSAGE,
      OPS_REQUEST_LEGACY_UNSUPPORTED_MESSAGE,COMMUNITY_CONTROL_EXECUTE_TIMEOUT_MESSAGE,'x',undefined]){
      expect(consistent(classifyComputerUseRemoteRefusal(error,{operation:'scope-observe',part:true}))).toMatchObject({outcome:'read',code:'REMOTE_PART_LOST'});
      expect(consistent(classifyComputerUseRemoteRefusal(error,{...INPUT,part:true})).outcome).toBe('unknown');
    }
    const busy=new AgentDialogueHostError('AGENT_DIALOGUE_REMOTE_FAILED','AGENT_DIALOGUE_CONTROL_BUSY');
    expect(consistent(classifyComputerUseRemoteTransportFailure(busy,{operation:'scope-capture',part:true,sent:false}))).toMatchObject({outcome:'read',code:'REMOTE_PART_LOST'});
    expect(consistent(classifyComputerUseRemoteBadAnswer({operation:'scope-capture',part:true}))).toMatchObject({outcome:'read',code:'REMOTE_PART_LOST'});
  });
  test('any other text proves nothing about admission',()=>{
    for(const error of ['제어 요청을 처리하지 못했습니다.','',undefined,{message:'x'},42]){
      expect(consistent(classifyComputerUseRemoteRefusal(error,INPUT))).toMatchObject({outcome:'unknown',code:'REMOTE_UNKNOWN_OUTCOME'});
      for(const options of STATE_CHANGES)expect(consistent(classifyComputerUseRemoteRefusal(error,options)).outcome).toBe('state-unknown');
      for(const options of READS)expect(consistent(classifyComputerUseRemoteRefusal(error,options)).outcome).toBe('read');
    }
  });
});

describe('what a request may change decides how its open outcome is read',()=>{
  test('inputs, state changes without a requestId, and reads',()=>{
    for(const operation of ['scope-click','scope-type-text','scope-key','scope-scroll','scope-drag','scope-focus-app'])
      expect(computerUseRemoteEffect(operation)).toBe('input');
    for(const operation of ['scope-request-access','scope-request-human','disconnect'])expect(computerUseRemoteEffect(operation)).toBe('state-change');
    for(const operation of ['scope-status','scope-observe','scope-capture','scope-receipt','hello','heartbeat'])expect(computerUseRemoteEffect(operation)).toBe('read');
    // Every call operation is placed; something unknown is never reported as having changed nothing.
    for(const operation of COMPUTER_USE_REMOTE_CALL_OPERATIONS)expect(['input','state-change','read']).toContain(computerUseRemoteEffect(operation));
    for(const operation of ['scope-revoke','part','',undefined,42])expect(computerUseRemoteEffect(operation)).toBe('input');
  });
  test('a state change whose outcome is open says a grant may have changed, and blocks nothing',()=>{
    const {outcome,message}=COMPUTER_USE_REMOTE_ERRORS.REMOTE_STATE_UNKNOWN;
    expect(outcome).toBe('state-unknown');
    expect(message).toContain('모릅니다');
    expect(message).toContain('status');
    expect(message).toContain('자동으로 다시 보내지 않았습니다');
    // Not the input sentence: there is no requestId and no receipt to read for it.
    expect(message).not.toContain('receipt');
    expect(message).not.toBe(COMPUTER_USE_REMOTE_ERRORS.REMOTE_UNKNOWN_OUTCOME.message);
  });
});

describe('a failed mailbox call',()=>{
  const db=(token:string)=>new AgentDialogueHostError('AGENT_DIALOGUE_REMOTE_FAILED',token);
  test('a database refusal before the row was written is not run',()=>{
    for(const options of ALL_OPTIONS){
      const send=(error:unknown)=>consistent(classifyComputerUseRemoteTransportFailure(error,{...options,sent:false}));
      expect(send(db('AGENT_DIALOGUE_CONTROL_BUSY'))).toMatchObject({outcome:'not-run',code:'REMOTE_RATE_LIMITED'});
      expect(send(db('AGENT_DIALOGUE_CONTROL_TARGET_UNAVAILABLE'))).toMatchObject({outcome:'not-run',code:'REMOTE_NOT_IN_COMMUNITY'});
      expect(send(new AgentDialogueHostError('AGENT_DIALOGUE_CONTROL_NOT_IN_COMMUNITY','이 기기가 커뮤니티에 입장해야…')))
        .toMatchObject({outcome:'not-run',code:'REMOTE_NOT_IN_COMMUNITY'});
      expect(send(new AgentDialogueHostError('AGENT_DIALOGUE_SHARED_PROFILE_REQUIRED','…'))).toMatchObject({outcome:'not-run',code:'REMOTE_PROFILE_REQUIRED'});
      expect(send(new AgentDialogueHostError('AGENT_DIALOGUE_CONTROL_TARGET_INVALID','…'))).toMatchObject({outcome:'not-run',code:'REMOTE_DEVICE_UNKNOWN'});
    }
  });
  test('a network failure may have written the row: an input is unknown, a state change state-unknown',()=>{
    const network=new AgentDialogueHostError('AGENT_DIALOGUE_REMOTE_FAILED','대화 DB 요청을 처리하지 못했습니다.');
    expect(consistent(classifyComputerUseRemoteTransportFailure(network,{operation:'scope-type-text',requestId:'type-0001',sent:false})))
      .toMatchObject({outcome:'unknown'});
    expect(consistent(classifyComputerUseRemoteTransportFailure(new TypeError('fetch failed'),{...INPUT,sent:false})).outcome).toBe('unknown');
    for(const options of STATE_CHANGES)
      expect(consistent(classifyComputerUseRemoteTransportFailure(network,{...options,sent:false}))).toMatchObject({outcome:'state-unknown',code:'REMOTE_STATE_UNKNOWN'});
    for(const options of READS)
      expect(consistent(classifyComputerUseRemoteTransportFailure(network,{...options,sent:false}))).toMatchObject({outcome:'read',code:'REMOTE_NO_ANSWER'});
  });
  test('after the row was written every failure leaves the outcome open — the 20 s deadline included',()=>{
    const timeout=new AgentDialogueHostError('AGENT_DIALOGUE_CONTROL_TIMEOUT','상대 기기가 제때 답하지 않았습니다.',504);
    expect(consistent(classifyComputerUseRemoteTransportFailure(timeout,{...INPUT,sent:true}))).toMatchObject({outcome:'unknown',code:'REMOTE_UNKNOWN_OUTCOME'});
    // request-access may have opened a grant and request-human halted one: never "nothing changed".
    for(const options of STATE_CHANGES)
      expect(consistent(classifyComputerUseRemoteTransportFailure(timeout,{...options,sent:true}))).toMatchObject({outcome:'state-unknown',code:'REMOTE_STATE_UNKNOWN'});
    for(const options of READS)
      expect(consistent(classifyComputerUseRemoteTransportFailure(timeout,{...options,sent:true}))).toMatchObject({outcome:'read',code:'REMOTE_NO_ANSWER'});
    // Even a refusal token is no proof once the row exists.
    expect(consistent(classifyComputerUseRemoteTransportFailure(db('AGENT_DIALOGUE_CONTROL_BUSY'),{...INPUT,sent:true})).outcome).toBe('unknown');
    expect(consistent(classifyComputerUseRemoteTransportFailure(db('AGENT_DIALOGUE_CONTROL_BUSY'),{operation:'scope-request-access',sent:true})).outcome)
      .toBe('state-unknown');
  });
  test('an answer that cannot be used leaves the outcome open, never not-run',()=>{
    expect(consistent(classifyComputerUseRemoteBadAnswer({operation:'scope-drag',requestId:'drag-0001'}))).toEqual({outcome:'unknown',
      code:'REMOTE_UNKNOWN_OUTCOME',message:computerUseRemoteErrorMessage('REMOTE_UNKNOWN_OUTCOME',{requestId:'drag-0001'})});
    for(const options of STATE_CHANGES)expect(consistent(classifyComputerUseRemoteBadAnswer(options))).toEqual({outcome:'state-unknown',
      code:'REMOTE_STATE_UNKNOWN',message:COMPUTER_USE_REMOTE_ERRORS.REMOTE_STATE_UNKNOWN.message});
    for(const options of READS)expect(consistent(classifyComputerUseRemoteBadAnswer(options))).toEqual({outcome:'read',code:'REMOTE_BAD_ANSWER',
      message:COMPUTER_USE_REMOTE_ERRORS.REMOTE_BAD_ANSWER.message});
  });
});

describe('remoteReceiptVerdict',()=>{
  const sentAt=1_700_000_000_000,bootId='c'.repeat(32),requestId='click-0001';
  const entry:ComputerUseRemoteLedgerEntry={requestId,deviceId:'11111111-1111-4111-8111-111111111111',sentAt,bootId};
  const within=sentAt+60_000,window=COMPUTER_USE_REMOTE_LIMITS.senderLedgerWindowMs;
  const answer=(receipt:Record<string,unknown>,extra:Record<string,unknown>={})=>({success:true,bootId,evictedThroughSentAt:null,receipt:{requestId,...receipt},...extra});
  test('an actual receipt settles as it is, even after the window',()=>{
    for(const state of COMPUTER_USE_REMOTE_ACTUAL_RECEIPT_STATES){
      for(const now of [within,sentAt+window+60_000]){
        const verdict=remoteReceiptVerdict(entry,answer({state}),now);
        expect(verdict).toMatchObject({verdict:'receipt',settled:true,receipt:{requestId,state}});
      }
    }
    expect(remoteReceiptVerdict(entry,answer({state:'refused',reason:'person-has-control',guardReason:'protected-foreground'},{owner:'person',guidance:'30초마다 status'}),within))
      .toEqual({verdict:'receipt',settled:true,receipt:{requestId,state:'refused',reason:'person-has-control',guardReason:'protected-foreground'},owner:'person',guidance:'30초마다 status'});
  });
  test('not-run settles as not run with its reason',()=>{
    for(const reason of COMPUTER_USE_REMOTE_NOT_RUN_REASONS){
      const verdict=remoteReceiptVerdict(entry,answer({state:'not-run',reason}),within);
      expect(verdict).toMatchObject({verdict:'not-run',settled:true,reason});
      expect((verdict as {message:string}).message).toContain('실행하지 않았습니다');
    }
  });
  test('in-progress keeps the entry open until the window passes',()=>{
    expect(remoteReceiptVerdict(entry,answer({state:'in-progress'}),within)).toMatchObject({verdict:'pending',settled:false,why:'in-progress'});
    expect(remoteReceiptVerdict(entry,answer({state:'in-progress'}),sentAt+window)).toMatchObject({verdict:'unknown-final',why:'window-passed'});
  });
  test('unseen is not run only with the same boot, nothing evicted at or after sentAt, and inside sentAt + 10 min',()=>{
    expect(remoteReceiptVerdict(entry,answer({state:'unseen'}),within)).toMatchObject({verdict:'not-run',settled:true,reason:'unseen'});
    expect(remoteReceiptVerdict(entry,{bootId,evictedThroughSentAt:sentAt-1,receipt:{requestId,state:'unseen'}},within)).toMatchObject({verdict:'not-run',reason:'unseen'});
    expect(remoteReceiptVerdict(entry,answer({state:'unseen'}),sentAt+window-1)).toMatchObject({verdict:'not-run',reason:'unseen'});
    // Each condition alone turns it into unknown-final.
    expect(remoteReceiptVerdict(entry,{...answer({state:'unseen'}),bootId:'d'.repeat(32)},within)).toMatchObject({verdict:'unknown-final',why:'boot-changed'});
    expect(remoteReceiptVerdict(entry,{...answer({state:'unseen'}),evictedThroughSentAt:sentAt},within)).toMatchObject({verdict:'unknown-final',why:'evicted-range'});
    expect(remoteReceiptVerdict(entry,{...answer({state:'unseen'}),evictedThroughSentAt:sentAt+1},within)).toMatchObject({verdict:'unknown-final',why:'evicted-range'});
    expect(remoteReceiptVerdict(entry,answer({state:'unseen'}),sentAt+window)).toMatchObject({verdict:'unknown-final',why:'window-passed'});
  });
  test('evicted and a bootId mismatch are always unknown-final',()=>{
    expect(remoteReceiptVerdict(entry,answer({state:'evicted'}),within)).toEqual({verdict:'unknown-final',settled:true,why:'evicted',message:COMPUTER_USE_REMOTE_UNKNOWN_FINAL_MESSAGE});
    for(const receipt of [{state:'confirmed'},{state:'not-run',reason:'busy'},{state:'in-progress'},{state:'unseen'},{state:'evicted'}]){
      expect(remoteReceiptVerdict(entry,{...answer(receipt),bootId:'e'.repeat(32)},within)).toMatchObject({verdict:'unknown-final',why:'boot-changed'});
    }
    expect(COMPUTER_USE_REMOTE_UNKNOWN_FINAL_MESSAGE).toContain('다시 보내지 말고');
  });
  test('an answer that does not parse, or names another request, settles nothing',()=>{
    const bad=[
      answer({state:'confirmed'},{extra:1}),
      {...answer({state:'confirmed'}),success:false},
      {receipt:{requestId,state:'confirmed'},evictedThroughSentAt:null},
      {...answer({state:'confirmed'}),evictedThroughSentAt:-1},
      {...answer({state:'confirmed'}),evictedThroughSentAt:'0'},
      answer({state:'not-run'}),
      answer({state:'not-run',reason:'tired'}),
      answer({state:'unseen',reason:'busy'}),
      answer({state:'evicted',guardReason:'x'}),
      answer({state:'done'}),
      answer({state:'confirmed',secret:'grant'}),
      {...answer({state:'confirmed'}),receipt:{requestId:'click-0002',state:'confirmed'}},
      // A receiver newer than this parser (an extra key), or a boxed error instead of a receipt.
      {...answer({state:'confirmed'}),connection:'x'},{error:'영수증을 읽지 못했습니다.'},
      // No answer at all: the receipt call itself failed.
      undefined,
      null,'unseen',
    ];
    for(const value of bad){
      expect(remoteReceiptVerdict(entry,value,within)).toMatchObject({verdict:'pending',settled:false,why:'bad-answer'});
      expect(remoteReceiptVerdict(entry,value,sentAt+window-1)).toMatchObject({verdict:'pending',why:'bad-answer'});
    }
  });
  test('…but once the window has passed it settles as unknown-final, so the device\'s input is not blocked forever',()=>{
    const bad=[answer({state:'confirmed'},{extra:1}),{error:'x'},undefined,null];
    for(const value of bad){
      for(const now of [sentAt+window,sentAt+60*60_000]){
        expect(remoteReceiptVerdict(entry,value,now)).toEqual({verdict:'unknown-final',settled:true,why:'window-passed',
          message:COMPUTER_USE_REMOTE_UNKNOWN_FINAL_MESSAGE});
      }
    }
    // A clock that cannot be read never turns a bad answer into "not run".
    expect(remoteReceiptVerdict(entry,undefined,Number.NaN)).toMatchObject({verdict:'unknown-final',why:'window-passed'});
  });
  test('a broken ledger entry is never read as not run',()=>{
    for(const broken of [{...entry,bootId:''},{...entry,sentAt:1.5},{...entry,requestId:'x'}])
      expect(remoteReceiptVerdict(broken,answer({state:'unseen'}),within)).toMatchObject({verdict:'unknown-final',why:'invalid-entry'});
  });
  test('guard samples pass only small and well-formed; the builder refuses a shape the sender would refuse',()=>{
    const samples={before:{idleMs:5,counters:null}};
    expect(remoteReceiptVerdict(entry,answer({state:'refused',guardSamples:samples}),within)).toMatchObject({receipt:{guardSamples:samples}});
    const huge={before:{idleMs:5,counters:{pad:'x'.repeat(3000)}}};
    const verdict=remoteReceiptVerdict(entry,answer({state:'refused',guardSamples:huge}),within);
    if(verdict.verdict!=='receipt')throw new Error(`expected a receipt verdict, got ${verdict.verdict}`);
    expect(verdict.receipt.state).toBe('refused');
    expect(verdict.receipt.guardSamples).toBeUndefined();
    expect(computerUseRemoteReceiptAnswer({bootId,evictedThroughSentAt:null,receipt:{requestId,state:'unseen'}})).toEqual({bootId,evictedThroughSentAt:null,receipt:{requestId,state:'unseen'}});
    expect(()=>computerUseRemoteReceiptAnswer({bootId,evictedThroughSentAt:null,receipt:{requestId,state:'not-run'}})).toThrow(ComputerUseRemoteError);
  });
});

describe('RC-6 sentAt guard and operation classes',()=>{
  test('12 s late and 5 s early are the boundaries, judged at execution start',()=>{
    const now=1_700_000_100_000;
    expect(computerUseRemoteSentAtCheck(now-12_000,now)).toBe('ok');
    expect(computerUseRemoteSentAtCheck(now-12_001,now)).toBe('stale');
    expect(computerUseRemoteSentAtCheck(now+5_000,now)).toBe('ok');
    expect(computerUseRemoteSentAtCheck(now+5_001,now)).toBe('clock');
    expect(computerUseRemoteSentAtCheck(now,now)).toBe('ok');
    expect(computerUseRemoteSentAtCheck(1.5,now)).toBe('clock');
    // A sender gives up at 20 s; anything the receiver still starts must be younger than that minus the skew.
    expect(COMPUTER_USE_REMOTE_LIMITS.staleAfterMs).toBeLessThan(COMPUTER_USE_REMOTE_LIMITS.callTimeoutMs-COMPUTER_USE_REMOTE_LIMITS.futureSkewMs);
    expect(COMPUTER_USE_REMOTE_LIMITS.receiverAnswerMs).toBeLessThan(COMPUTER_USE_REMOTE_LIMITS.callTimeoutMs);
    expect(COMPUTER_USE_REMOTE_LIMITS.routeBudgetMs).toBeLessThan(COMPUTER_USE_REMOTE_LIMITS.mcpFetchMs);
    expect(COMPUTER_USE_REMOTE_LIMITS.senderLedgerWindowMs).toBeLessThan(COMPUTER_USE_REMOTE_LIMITS.ledgerRetentionMs);
  });
  test('request-access and request-human change state without a requestId; reads change nothing',()=>{
    for(const op of ['scope-request-access','scope-request-human']){expect(isComputerUseRemoteStateChange(op)).toBe(true);expect(isComputerUseRemoteInput(op)).toBe(false);}
    // D11: every pointer input is an ordinary remote input.
    for(const op of ['scope-click','scope-type-text','scope-key','scope-scroll','scope-drag','scope-focus-app']){expect(isComputerUseRemoteStateChange(op)).toBe(true);expect(isComputerUseRemoteInput(op)).toBe(true);}
    for(const op of ['scope-status','scope-observe','scope-capture','scope-receipt']){expect(isComputerUseRemoteStateChange(op)).toBe(false);expect(isComputerUseRemoteInput(op)).toBe(false);}
  });
});

describe('the call box content',()=>{
  test('takes only agent operations and cleans the sender\'s names',()=>{
    expect(parseComputerUseRemoteCallMeta({operation:'scope-status',client:'Claude‮ Code​',host:'Terminal\n'}))
      .toEqual({request:{operation:'scope-status'},client:'Claude Code',host:'Terminal'});
    expect(parseComputerUseRemoteCallMeta({operation:'scope-click',grant:'g',epoch:1}).request).toEqual({operation:'scope-click',grant:'g',epoch:1});
    expect(COMPUTER_USE_REMOTE_CALL_OPERATIONS).toContain('scope-scroll');
    expect(COMPUTER_USE_REMOTE_CALL_OPERATIONS).toContain('scope-drag');
    for(const operation of ['scope-revoke','scope-open-grant','scope-request-approval','scope-approval-status','scope-catalog','scope-revoke-session',
      'scope-disconnect-owner','scope-access-set','scope-remote-set','status','observe'])
      expect(()=>parseComputerUseRemoteCallMeta({operation})).toThrow(ComputerUseRemoteError);
    expect(()=>parseComputerUseRemoteCallMeta({operation:'scope-status',client:7})).toThrow(ComputerUseRemoteError);
    expect(parseComputerUseRemoteCallMeta({operation:'scope-status',client:'​‮'})).toEqual({request:{operation:'scope-status'}});
  });
  test('clean text removes control, format and bidirectional characters and counts code points',()=>{
    expect(computerUseRemoteCleanText('3호‮ / 아젠투지\u0007 (OPS) ',100)).toBe('3호 / 아젠투지 (OPS)');
    expect(computerUseRemoteCleanText('😀😀😀',2)).toBe('😀😀');
    expect(computerUseRemoteCleanText('  a  \t b ',10)).toBe('a b');
  });
});

describe('error codes and sentences',()=>{
  test('D11: no remote pointer refusal exists',()=>{
    expect(COMPUTER_USE_REMOTE_ERROR_CODES as string[]).not.toContain('REMOTE_POINTER_DISABLED');
    expect(JSON.stringify(COMPUTER_USE_REMOTE_ERRORS)).not.toContain('POINTER');
  });
  test('every sentence is complete and every outcome is one of four',()=>{
    for(const code of COMPUTER_USE_REMOTE_ERROR_CODES){
      const {outcome,message}=COMPUTER_USE_REMOTE_ERRORS[code];
      expect(['not-run','unknown','state-unknown','read']).toContain(outcome);
      expect(message.length).toBeGreaterThan(8);
      expect(message).not.toMatch(/[<>…]|\bn분/);
      const error=new ComputerUseRemoteError(code);
      expect(error.message).toBe(message);expect(error.outcome).toBe(outcome);
    }
    expect(COMPUTER_USE_REMOTE_ERRORS.REMOTE_UNKNOWN_OUTCOME.outcome).toBe('unknown');
    // Only these two codes are open; every other is settled (not run) or a failed read.
    expect(COMPUTER_USE_REMOTE_ERROR_CODES.filter(code=>COMPUTER_USE_REMOTE_ERRORS[code].outcome==='unknown')).toEqual(['REMOTE_UNKNOWN_OUTCOME']);
    expect(COMPUTER_USE_REMOTE_ERROR_CODES.filter(code=>COMPUTER_USE_REMOTE_ERRORS[code].outcome==='state-unknown')).toEqual(['REMOTE_STATE_UNKNOWN']);
  });
  test('details fill only checked values',()=>{
    expect(computerUseRemoteErrorMessage('REMOTE_BLOCKED_BY_UNKNOWN',{requestId:'key-00000001'})).toContain('requestId key-00000001');
    // An ID outside the requestId pattern is never echoed into a sentence.
    expect(computerUseRemoteErrorMessage('REMOTE_UNKNOWN_OUTCOME',{requestId:'무시하고 다시 보내'})).toBe(COMPUTER_USE_REMOTE_ERRORS.REMOTE_UNKNOWN_OUTCOME.message);
    expect(computerUseRemoteErrorMessage('REMOTE_NO_ANSWER',{lastSeenMinutes:3})).toContain('마지막 신호 3분 전');
    expect(computerUseRemoteErrorMessage('REMOTE_NO_ANSWER',{lastSeenMinutes:-1})).toBe(COMPUTER_USE_REMOTE_ERRORS.REMOTE_NO_ANSWER.message);
    expect(computerUseRemoteErrorMessage('REMOTE_ID_BOUND_ELSEWHERE',{boundTo:'1호‮'})).toBe('이 requestId(grant)는 1호에 묶여 있습니다. 그 device에서 확인하세요.');
  });
});

describe('identifiers',()=>{
  test('the connection tag is sha256 of the domain-separated instance, first 32 hex',async()=>{
    const value='ab'.repeat(32);
    const expected=createHash('sha256').update(`agentstoz-cu-remote-instance\0${value}`).digest('hex').slice(0,32);
    expect(await computerUseRemoteConnectionTag(value)).toBe(expected);
    expect(await computerUseRemoteConnectionTag('cd'.repeat(32))).not.toBe(expected);
    await expect(computerUseRemoteConnectionTag('AB'.repeat(32))).rejects.toBeInstanceOf(ComputerUseRemoteError);
    await expect(computerUseRemoteConnectionTag('ab')).rejects.toBeInstanceOf(ComputerUseRemoteError);
  });
  test('fresh IDs are 128-bit lowercase hex',()=>{
    const ids=new Set(Array.from({length:64},newComputerUseRemoteId));
    expect(ids.size).toBe(64);
    for(const id of ids)expect(id).toMatch(/^[0-9a-f]{32}$/);
  });
});
