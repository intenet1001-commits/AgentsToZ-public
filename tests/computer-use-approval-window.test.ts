import {describe,expect,test} from 'bun:test';
import {generateKeyPairSync,sign} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {COMPUTER_USE_APPROVAL_LIMITS as L,ComputerApprovalVerifier} from '../src/computerUseApproval';
import {ComputerCallerRegistry} from '../src/computerUseCaller';
import {COMPUTER_USE_SCOPE_APPROVAL_MAX_MS,ComputerScopeApprovalVerifier,computerScopeApprovalBytes} from '../src/computerUseScopeApproval';
import {COMPUTER_USE_SCOPE_PERMISSIONS} from '../src/computerUseScopeProtocol';
import {testApprovalHelper} from './computer-use-test-helper';

// 2026-10-31: a request waits 10 minutes for the person. At 120 s it often ran out before they reached Control,
// and the expired request then had to be asked again.
const NINE_MINUTES=540_000;
const swiftLiteral=(file:string,name:string)=>Number(readFileSync(new URL(`../native/computer-use/Sources/${file}`,import.meta.url),'utf8')
  .match(new RegExp(`static let ${name}(?:: Int64)? = ([0-9_]+)\\n`))?.[1]?.replaceAll('_',''));
const caller=()=>{const registry=new ComputerCallerRegistry();return registry.authenticate(registry.issue({sessionId:'workroom_session_a',lane:'leader'}))!;};
const desktop={kind:'desktop' as const},owner={pid:912,start:'100001'};
const keys=()=>{const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});const jwk=pair.publicKey.export({format:'jwk'});
  return {...pair,point:Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x!,'base64url'),Buffer.from(jwk.y!,'base64url')])};};
const signedScope=(r:any,k:ReturnType<typeof keys>,issuedAt:number)=>{
  const payload={version:2 as const,approvalId:r.approvalId,scope:r.scope,permissions:[...COMPUTER_USE_SCOPE_PERMISSIONS],caller:r.caller,owner:r.owner,issuedAt,expiresAt:r.expiresAt};
  return {...payload,signature:sign('sha256',computerScopeApprovalBytes(payload),{key:k.privateKey,dsaEncoding:'der'}).toString('base64')};
};

describe('a computer-use request waits 10 minutes for the person',()=>{
  test('the main app and AgentsToZ Control hold the same limits',()=>{
    expect<number>(L.approvalMs).toBe(600_000);
    expect(swiftLiteral('ComputerUseControlCore/ControlProtocol.swift','approvalMs')).toBe(L.approvalMs);
    expect(swiftLiteral('ComputerUseControlCore/ControlProtocol.swift','skewMs')).toBe(L.skewMs);
    expect(swiftLiteral('ComputerUseApproval/ScopeApproval.swift','maxGrantMs')).toBe(COMPUTER_USE_SCOPE_APPROVAL_MAX_MS);
    // A signature made the moment a request arrives still spans its whole wait.
    expect(COMPUTER_USE_SCOPE_APPROVAL_MAX_MS).toBeGreaterThanOrEqual(L.approvalMs+L.skewMs);
  });
  test('switched on: approved nine minutes later still opens; after ten minutes it is refused',()=>{
    const k=keys(),c=caller();let now=100_000;
    const v=new ComputerScopeApprovalVerifier(()=>now);
    const late=v.request(c,desktop,'scope',owner);
    expect(late.expiresAt).toBe(100_000+L.approvalMs);
    const atOnce=v.request(c,desktop,'scope',owner);
    expect(v.verify(signedScope(atOnce,k,now),k.point).approvalId).toBe(atOnce.approvalId);
    now+=NINE_MINUTES;
    expect(v.verify(signedScope(late,k,now),k.point).approvalId).toBe(late.approvalId);
    v.redeem(late.approvalId);
    const expired=v.request(c,desktop,'scope',owner);
    now+=L.approvalMs+1;
    expect(()=>v.verify(signedScope(expired,k,now-1),k.point)).toThrow();
  });
  test('one window: approved nine minutes later still verifies; after ten minutes it is refused',()=>{
    const helper=testApprovalHelper();let now=50_000;
    const v=new ComputerApprovalVerifier({helperPublicKey:helper.publicKey,now:()=>now});
    const target={bundleId:'com.example.editor',teamId:'ABCDEFGHIJ',codeHash:'ab'.repeat(20),pid:100,processStart:'9007199254740995',windowId:321};
    const late=v.request(caller(),target,'Edit draft');
    expect(late.expiresAt).toBe(50_000+L.approvalMs);
    now+=NINE_MINUTES;
    expect(v.verify(helper.approve(late,{issuedAt:now})).approvalId).toBe(late.approvalId);
    const expired=v.request(caller(),{...target,windowId:322},'Edit draft');
    now+=L.approvalMs+1;
    expect(()=>v.verify(helper.approve(expired,{issuedAt:now-1}))).toThrow('승인 시간');
  });
});
