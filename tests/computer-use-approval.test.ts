import {describe,expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {COMPUTER_USE_APPROVAL_LIMITS,ComputerApprovalVerifier,computerApprovalBytes,computerApprovalKey,parseComputerApproval,verifyComputerApprovalSignature} from '../src/computerUseApproval';
import {ComputerCallerRegistry} from '../src/computerUseCaller';
import {ComputerUseRecovery} from '../src/computerUseRecovery';
import {testApprovalHelper,testComputerUseHost} from './computer-use-test-helper';

const target={bundleId:'com.example.editor',teamId:'ABCDEFGHIJ',codeHash:'ab'.repeat(20),pid:100,processStart:'9007199254740995',windowId:321};
function setup(recovery=new ComputerUseRecovery(':memory:')) {
  let now=50_000,workers=0;
  const callers=new ComputerCallerRegistry();
  const leader=callers.authenticate(callers.issue({sessionId:'workroom_session_a',lane:'leader'}))!;
  const member=callers.authenticate(callers.issue({sessionId:'workroom_session_a',lane:'member-2'}))!;
  const t=testComputerUseHost({now:()=>now,recovery,createWorker:async()=>{workers++;return {close(){},async request(){return {success:true,bound:true,protocolVersion:2};}};}});
  return {...t,leader,member,recovery,workers:()=>workers,setNow:(v:number)=>{now=v;},now:()=>now};
}

describe('C2 · only a helper-signed, one-time human approval becomes a grant',()=>{
  test('a boolean, an unsigned value, another key or an unrequested approval never becomes a grant',async()=>{
    const f=setup();
    for(const value of [true,false,undefined,{confirmed:true},'approved'])await expect(f.host.grant(value)).rejects.toThrow();
    const request=f.host.requestApproval(f.leader,target,'Edit draft');
    const forger=testApprovalHelper();
    await expect(f.host.grant(forger.approve(request))).rejects.toThrow('사람 승인을 확인하지 못했습니다');
    const genuine=f.helper.approve(request);
    await expect(f.host.grant({...genuine,signature:Buffer.alloc(70,1).toString('base64')})).rejects.toThrow('사람 승인을 확인하지 못했습니다');
    await expect(f.host.grant(f.helper.approve({...request,approvalId:'cd'.repeat(32)}))).rejects.toThrow('요청이 없습니다');
    await expect(f.host.grant({...genuine,extra:true})).rejects.toThrow();
    expect(f.workers()).toBe(0);
    expect((await f.host.grant(genuine)).success).toBe(true);expect(f.workers()).toBe(1);
    f.host.dispose();
  });
  test('the approval is bound to the exact target, caller and expiry it was requested for',async()=>{
    const f=setup();
    const request=f.host.requestApproval(f.leader,target,'Edit draft');
    const changed=[{target:{...target,windowId:322}},{target:{...target,pid:101}},{target:{...target,codeHash:'cd'.repeat(20)}},
      {target:{...target,bundleId:'com.example.other'}},{caller:{sessionId:'workroom_session_a',lane:'member-2'}},
      {caller:{sessionId:'workroom_session_b',lane:'leader'}},{expiresAt:request.expiresAt+60_000},{issuedAt:f.now()+60_000}];
    for(const override of changed)await expect(f.host.grant(f.helper.approve(request,override))).rejects.toThrow();
    // Even a valid signature over other values cannot be re-labelled as this request.
    const signedOther=f.helper.approve(request,{target:{...target,windowId:322}});
    await expect(f.host.grant({...signedOther,target})).rejects.toThrow('사람 승인을 확인하지 못했습니다');
    expect(f.workers()).toBe(0);
    const granted=await f.host.grant(f.helper.approve(request));
    expect(f.host.list()[0]).toMatchObject({id:granted.id,caller:{sessionId:'workroom_session_a',lane:'leader'},label:'Edit draft'});
    // The bound caller is the requester; another lane cannot use the resulting grant.
    await expect(f.host.agent(f.member,{grant:granted.grant,epoch:1,operation:'observe'})).rejects.toThrow('사람이 허용한');
    f.host.dispose();
  });
  test('one approval makes one grant; a replay or a late answer is refused',async()=>{
    const f=setup();
    const approval=f.helper.approve(f.host.requestApproval(f.leader,target,'Edit draft'));
    expect((await f.host.grant(approval)).success).toBe(true);
    await expect(f.host.grant(approval)).rejects.toThrow('이미 사용한 승인');
    const late=f.helper.approve(f.host.requestApproval(f.leader,{...target,windowId:322},'Late'));
    f.setNow(f.now()+COMPUTER_USE_APPROVAL_LIMITS.approvalMs+1);
    await expect(f.host.grant(late)).rejects.toThrow('승인 시간');
    expect(f.workers()).toBe(1);
    f.host.dispose();
  });
  test('refused targets and apps awaiting review are never offered for approval; open requests are bounded',async()=>{
    const recovery=new ComputerUseRecovery(':memory:');
    recovery.begin({bundleId:'com.example.reviewme',windowId:9,operation:'press',requestId:'left_unknown_01',sessionId:'workroom_session_z',lane:'leader'});
    const f=setup(recovery);
    for(const bundleId of ['com.apple.Terminal','com.nousresearch.hermes','com.intenet.agentstozbycs.screen'])
      expect(()=>f.host.requestApproval(f.leader,{...target,bundleId},'never')).toThrow('허용하지 않습니다');
    expect(()=>f.host.requestApproval(f.leader,{...target,bundleId:'com.example.reviewme'},'blocked')).toThrow('확인하지 못한 작업');
    const forged={sessionId:'workroom_session_a',lane:'leader'};
    expect(()=>f.host.requestApproval(forged as any,target,'forged')).toThrow('인증된 작업 세션');
    for(let i=0;i<COMPUTER_USE_APPROVAL_LIMITS.pending;i++)f.host.requestApproval(f.leader,{...target,windowId:400+i},`open ${i}`);
    expect(()=>f.host.requestApproval(f.leader,{...target,windowId:999},'one too many')).toThrow('너무 많습니다');
    f.setNow(f.now()+COMPUTER_USE_APPROVAL_LIMITS.approvalMs+COMPUTER_USE_APPROVAL_LIMITS.skewMs+1);
    expect(f.host.requestApproval(f.leader,{...target,windowId:999},'after expiry').approvalId).toMatch(/^[a-f0-9]{64}$/);
    f.host.dispose();
  });
  test('the helper key is an uncompressed P-256 point and the signed bytes are a fixed line format',()=>{
    for(const bad of [Buffer.alloc(0),Buffer.alloc(65,4).subarray(0,64),Buffer.concat([Buffer.from([2]),Buffer.alloc(64,1)]),Buffer.alloc(65,0),
      Buffer.concat([Buffer.from([4]),Buffer.alloc(64,1)])])
      expect(()=>new ComputerApprovalVerifier({helperPublicKey:bad})).toThrow();
    const bytes=computerApprovalBytes({approvalId:'ab'.repeat(32),target,caller:{sessionId:'workroom_session_a',lane:'leader'},issuedAt:1,expiresAt:2}).toString('utf8');
    expect(bytes).toBe(['agentstoz-computer-use-approval/v1','approval='+'ab'.repeat(32),'bundle=com.example.editor','team=ABCDEFGHIJ',
      'code='+'ab'.repeat(20),'pid=100','start=9007199254740995','window=321','session=workroom_session_a','lane=leader','issued=1','expires=2'].join('\n')+'\n');
    expect(()=>computerApprovalBytes({approvalId:'ab'.repeat(32),target:{...target,bundleId:'com.example\nbundle=evil'},caller:{sessionId:'workroom_session_a',lane:'leader'},issuedAt:1,expiresAt:2})).toThrow();
    expect(()=>parseComputerApproval({approvalId:'ab'.repeat(32),target,caller:{sessionId:'workroom_session_a',lane:'leader\nx'},issuedAt:1,expiresAt:2,signature:'A'.repeat(20)})).toThrow();
  });
  test('the Swift helper library produces the same bytes and a signature this verifier accepts',()=>{
    const v=JSON.parse(readFileSync(new URL('./fixtures/computer-use-approval-swift-vector.json',import.meta.url),'utf8'));
    expect(computerApprovalBytes(v.payload).equals(Buffer.from(v.bytes,'base64'))).toBe(true);
    const key=computerApprovalKey(Buffer.from(v.publicKey,'base64'));
    expect(verifyComputerApprovalSignature({...v.payload,signature:v.signature},key)).toBe(true);
    for(const tamper of [{target:{...v.payload.target,windowId:322}},{caller:{...v.payload.caller,lane:'member-2'}},{expiresAt:v.payload.expiresAt+1},{issuedAt:v.payload.issuedAt+1},{approvalId:'cd'.repeat(32)}])
      expect(verifyComputerApprovalSignature({...v.payload,...tamper,signature:v.signature},key)).toBe(false);
    expect(verifyComputerApprovalSignature({...v.payload,signature:v.signature},computerApprovalKey(testApprovalHelper().publicKey))).toBe(false);
  });
});
