import {test,expect} from 'bun:test';
import {Duplex} from 'node:stream';
import {createECDH,createPrivateKey,randomUUID,sign,verify,randomBytes} from 'node:crypto';
import {ComputerUseMainLink} from '../src/computerUseMainLink';
import {NativeCommunityMobileIdentity} from '../src/communityMobileNativeIdentity';
import {CommunityDeviceAuthorization} from '../src/communityMobilePrincipal';
import {mobileControlProofBytes,verifyMobileControlProof,type MobileControlTranscript} from '../src/communityMobileControlProtocol';
import type {CommunityMobileRelayPurpose} from '../src/communityAccessClient';
import golden from '../native/screen-control/Tests/Fixtures/community-mobile-control-v2.json';

const clone=<T>(v:T)=>structuredClone(v),now=golden.now;
function key(scalar:number){const raw=Buffer.alloc(32);raw.writeUInt32BE(scalar,28);const ecdh=createECDH('prime256v1');ecdh.setPrivateKey(raw);const pub=ecdh.getPublicKey();return createPrivateKey({format:'jwk',key:{kty:'EC',crv:'P-256',d:raw.toString('base64url'),x:pub.subarray(1,33).toString('base64url'),y:pub.subarray(33).toString('base64url')}});}
const issuer=key(golden.softwareKeyScalars.issuer),control=key(golden.softwareKeyScalars.receiverControl);
const proof=(key:ReturnType<typeof createPrivateKey>,bytes:Uint8Array)=>sign('sha256',bytes,{key,dsaEncoding:'ieee-p1363'}).toString('base64url');
const signed=(kind:string,id:string,payload:unknown)=>{const bytes=Buffer.from(JSON.stringify([2,kind,id,now,payload]));return {payload:bytes.toString('base64url'),signature:proof(issuer,Buffer.concat([Buffer.from('agentstoz.community-access.response/v2\0'),bytes]))};};

function fixture(capabilities=['agent.communicate','computer-use.agent-settings','computer-use.browser','teams.run'],agentDeviceId:string|null=golden.receiverAuthorization.agentDeviceId){
  const auth=clone(golden.receiverAuthorization),mobile=clone(golden.mobileAuthorization),use=clone(golden.useSession);
  auth.agentDeviceId=agentDeviceId as any;auth.capabilities=golden.receiverAuthorization.capabilities.filter(c=>!['agent.communicate','computer-use.agent-settings','computer-use.browser','teams.run'].includes(c)||capabilities.includes(c));
  const context={success:true,halted:false,communityProtocolVersion:3,configured:true,storeAvailable:true,authority:clone(golden.authority),
    binding:{candidatePrepared:true,profileId:auth.profileId,deviceId:auth.deviceId,controlKey:auth.controlKey,revision:auth.revision,localOff:false,
      agentDeviceId,communityId:auth.communityId,enrollmentId:auth.enrollmentId,capabilities:[...capabilities]}};
  const state={trusted:true,closedSession:false,frameIdMismatch:false,dropAccessResponse:false,nativeHook:undefined as undefined|((request:Record<string,any>,response:Record<string,any>)=>void),
    httpHook:undefined as undefined|((operation:string)=>void),nativeRequests:[] as Record<string,any>[],httpRequests:[] as any[]};
  const stream=new Duplex({read(){},write(chunk,_encoding,done){
    const bytes=Buffer.from(chunk);expect(bytes.readUInt32BE(0)).toBe(bytes.length-4);const frame=JSON.parse(bytes.subarray(4).toString());
    const request=frame.request as Record<string,any>;state.nativeRequests.push(clone(request));done();
    queueMicrotask(()=>{try{
      let response:Record<string,any>;
      if(request.operation==='community-component-context')response=clone(context);
      else if(request.operation==='community-component-refresh'){
        const body=JSON.parse(Buffer.from(request.envelope.payload,'base64url').toString())[4];response={success:true,halted:false,installed:true,revision:body.revision,expiresAt:body.expiresAt};
      }else if(request.operation==='community-component-sign'){
        expect(['mobile-agent','mobile-teams','mobile-agent-settings','mobile-browser']).toContain(request.purpose);
        const p=request.payload;let bytes:Uint8Array;
        if(p.kind==='access'){
          const r=p.request;expect(['component-status','component-directory','component-ticket','component-session']).toContain(r.operation);
          const raw=Buffer.from(JSON.stringify([2,r.operation,r.requestId,r.observedAt,r.nonce,r.actor,r.args]));
          bytes=Buffer.concat([Buffer.from('agentstoz.community-access.request/v2\0'),raw]);response={success:true,halted:false,publicKey:auth.controlKey,payload:raw.toString('base64url'),signature:proof(control,bytes)};
        }else if(p.kind==='relay-bind'){
          const body=JSON.parse(Buffer.from(p.ticket.payload,'base64url').toString())[4];bytes=Buffer.from(JSON.stringify(['agentstoz.relay.bind/v2',body.ticketId,body.connectionId,p.challenge]));
          response={success:true,halted:false,publicKey:auth.controlKey,signature:proof(control,bytes)};
        }else if(p.kind==='mobile-host-handshake')response={success:true,halted:false,publicKey:auth.controlKey,signature:proof(control,mobileControlProofBytes(p.transcript,'host'))};
        else throw Error('unexpected native proof kind');
      }else throw Error('unexpected native operation');
      state.nativeHook?.(request,response);
      if(state.dropAccessResponse&&request.payload?.kind==='access')return;
      const body=Buffer.from(JSON.stringify({version:1,id:state.frameIdMismatch?randomUUID():frame.id,response})),header=Buffer.alloc(4);header.writeUInt32BE(body.length);
      // Real MainLink length-prefix handling with fragmented fake-FD response bytes.
      const answer=Buffer.concat([header,body]);stream.push(answer.subarray(0,2));stream.push(answer.subarray(2,7));stream.push(answer.subarray(7));
    }catch(error){stream.destroy(error as Error);}});
  }});
  const link=new ComputerUseMainLink(stream,1000,()=>state.trusted);
  const identity=new NativeCommunityMobileIdentity(link,async(url,init)=>{
    expect(url).toBe(golden.authority.origin+'/v2');expect(init.method).toBe('POST');expect(init.redirect).toBe('error');expect(init.credentials).toBe('omit');
    const wrapped=JSON.parse(String(init.body)),raw=Buffer.from(wrapped.payload,'base64url');expect(verify('sha256',Buffer.concat([Buffer.from('agentstoz.community-access.request/v2\0'),raw]),{key:control,dsaEncoding:'ieee-p1363'},Buffer.from(wrapped.signature,'base64url'))).toBe(true);
    const fields=JSON.parse(raw.toString()),operation=fields[1],args=fields[6];expect(fields[5]).toBe(auth.enrollmentId);expect(args[0]).toBe(auth.communityId);state.httpRequests.push(clone(fields));
    let result:unknown,kind:string;
    if(operation==='component-status'){kind='authorization';result=clone(auth);}
    else if(operation==='component-directory'){kind='directory';result=[clone(auth),clone(mobile)];}
    else if(operation==='component-session'){
      expect(args).toHaveLength(4);expect(args[2]).toBe(mobile.enrollmentId);
      if(state.closedSession||args[3]!==use.sessionId)return Response.json(signed('error',fields[2],{code:'SESSION_EXPIRED'}),{status:400});kind='session';result=clone(use);
    }else if(operation==='component-ticket'){
      expect(args).toHaveLength(4);expect(args[3]).toBe('host');kind='ticket';result={version:1,ticketId:fields[2],communityId:auth.communityId,enrollmentId:auth.enrollmentId,deviceId:auth.deviceId,deviceKind:'desktop',
        connectionId:args[2],publicKey:auth.controlKey,purpose:args[1],role:'host',sessionId:null,revision:auth.revision,issuedAt:now,expiresAt:now+30_000,leaseExpiresAt:now+90_000};
    }else throw Error('unexpected CF operation');
    state.httpHook?.(operation);return Response.json(signed(kind,fields[2],result));
  },()=>now);
  return {identity,link,state,context,auth,mobile,use,close:()=>{identity.close();link.dispose();}};
}
async function mobilePrincipal(f:ReturnType<typeof fixture>){return CommunityDeviceAuthorization.fromEnvelope(golden.envelopes.mobile,golden.authority,{communityId:f.mobile.communityId,deviceId:f.mobile.deviceId,deviceKind:'mobile'},now);}

test('native mobile identity uses framed Main proofs, scoped issuer replies and all four host-only aliases',async()=>{
  const f=fixture();try{
    const c=await f.identity.context();expect(c.controlKey).toBe(f.auth.controlKey);expect(c.agentDeviceId).toBe(f.auth.agentDeviceId);
    const mobile=await mobilePrincipal(f);
    for(const purpose of ['mobile-agent','mobile-teams','mobile-agent-settings','mobile-browser'] as const){
      const auth=await f.identity.authorization(purpose);expect(auth.body.deviceId).toBe(c.deviceId);
      expect((await f.identity.directory(purpose)).map(v=>v.body.deviceKind)).toEqual(['desktop','mobile']);
      const use=await f.identity.currentUse(purpose,mobile,f.use.sessionId);expect(use.policyDigest).toBe(golden.transcript.senderUsePolicyDigest);
      const ticket=await f.identity.ticket(purpose,randomUUID());expect(ticket.body.purpose).toBe(purpose);expect(ticket.body.role).toBe('host');
      const challenge=randomBytes(32).toString('base64url');expect((await f.identity.signRelayProof(purpose,ticket,challenge)).length).toBe(64);
    }
    const own=await f.identity.authorization('mobile-agent'),use=await f.identity.currentUse('mobile-agent',mobile,f.use.sessionId);
    const result=await f.identity.signHandshake('mobile-agent',golden.transcript as MobileControlTranscript,own,mobile,use);
    expect(await verifyMobileControlProof(golden.transcript as MobileControlTranscript,'host',f.auth.controlKey,result)).toBe(true);
    const request=f.state.nativeRequests.findLast(r=>r.payload?.kind==='mobile-host-handshake')!;
    expect(Object.keys(request.payload).sort()).toEqual(['kind','transcript','ownAuthorization','controllerAuthorization','controllerUseSession'].sort());
    expect(f.state.httpRequests.filter(r=>r[1]==='component-session').length).toBeGreaterThan(4);
  }finally{f.close();}
});

test('browser-only nullable portal identity works, while missing purpose and bare legacy purpose never sign',async()=>{
  const f=fixture(['computer-use.browser'],null);try{
    expect((await f.identity.authorization('mobile-browser')).body.agentDeviceId).toBeNull();
    expect((await f.identity.directory('mobile-browser')).length).toBe(2);
    const before=f.state.nativeRequests.filter(r=>r.operation==='community-component-sign').length;
    await expect(f.identity.authorization('mobile-agent')).rejects.toThrow('NATIVE_CAPABILITY_DENIED');
    await expect(f.identity.authorization('agent' as CommunityMobileRelayPurpose)).rejects.toThrow('NATIVE_INVALID_PURPOSE');
    expect(f.state.nativeRequests.filter(r=>r.operation==='community-component-sign')).toHaveLength(before);
  }finally{f.close();}
});

test('unverified or late-lost Main and unmatched FD replies cannot dispatch CF or recover through another signer',async()=>{
  for(const mode of ['untrusted','late','wrong-frame'] as const){
    const f=fixture();try{
      if(mode==='untrusted')f.state.trusted=false;
      if(mode==='late')f.state.nativeHook=request=>{if(request.operation==='community-component-sign')f.state.trusted=false;};
      if(mode==='wrong-frame')f.state.frameIdMismatch=true;
      await expect(f.identity.authorization('mobile-agent')).rejects.toThrow();expect(f.state.httpRequests).toEqual([]);
      expect(f.link.verifiedMain).toBe(false);const count=f.state.nativeRequests.length;await expect(f.identity.authorization('mobile-agent')).rejects.toThrow();expect(f.state.nativeRequests).toHaveLength(count);
    }finally{f.close();}
  }
});

test('context off/revision/cap/issuer substitution is fenced before a late CF credential can escape',async()=>{
  for(const mode of ['off','revision','caps','issuer','origin'] as const){
    const f=fixture();try{
      await f.identity.context();f.state.httpHook=()=>{
        if(mode==='off')f.context.binding.localOff=true;if(mode==='revision')f.context.binding.revision++;
        if(mode==='caps')f.context.binding.capabilities=['computer-use.browser'];if(mode==='issuer')f.context.authority.issuerPublicKey=f.auth.hostPublicKey;
        if(mode==='origin')f.context.authority.origin='https://other.workers.dev';
      };
      await expect(f.identity.authorization('mobile-agent')).rejects.toThrow();expect(f.state.nativeRequests.some(r=>r.operation==='community-component-refresh')).toBe(false);
      await expect(f.identity.context()).rejects.toThrow('NATIVE_IDENTITY_ENDED');
    }finally{f.close();}
  }
});

test('bogus/unknown native proofs stop before HTTP, and bad native refresh or key epochs do not install JS authority',async()=>{
  for(const mode of ['signature','public-key','extra','unknown'] as const){
    const f=fixture();try{
      f.state.nativeHook=(request,response)=>{if(request.payload?.kind==='access'){
        if(mode==='signature')response.signature=Buffer.alloc(64).toString('base64url');if(mode==='public-key')response.publicKey=f.auth.hostPublicKey;
        if(mode==='extra')response.untypedProof=true;if(mode==='unknown'){delete response.payload;response.bytes='arbitrary';}
      }};
      await expect(f.identity.authorization('mobile-agent')).rejects.toThrow();expect(f.state.httpRequests).toEqual([]);
      expect(f.state.nativeRequests.filter(r=>r.operation==='community-component-sign')).toHaveLength(1);
    }finally{f.close();}
  }
  const f=fixture();try{
    await f.identity.authorization('mobile-agent');const refreshed=f.state.nativeRequests.filter(r=>r.operation==='community-component-refresh').length;
    f.auth.keyEpoch++;await expect(f.identity.authorization('mobile-agent')).rejects.toThrow('NATIVE_KEY_EPOCH_CHANGED');expect(f.state.nativeRequests.filter(r=>r.operation==='community-component-refresh')).toHaveLength(refreshed);
  }finally{f.close();}
  const wrong=fixture();try{
    wrong.state.nativeHook=(request,response)=>{if(request.operation==='community-component-refresh')response.revision++;};await expect(wrong.identity.authorization('mobile-agent')).rejects.toThrow('NATIVE_REFRESH_MISMATCH');
  }finally{wrong.close();}
});

test('session closure, substituted transcript or forged host proof never returns a valid native handshake',async()=>{
  const f=fixture();try{
    const mobile=await mobilePrincipal(f),own=await f.identity.authorization('mobile-agent'),use=await f.identity.currentUse('mobile-agent',mobile,f.use.sessionId);
    const before=()=>f.state.nativeRequests.filter(r=>r.payload?.kind==='mobile-host-handshake').length;
    for(const patch of [{senderDeviceId:randomUUID()},{receiverEnrollmentId:randomUUID()},{senderUsePolicyDigest:'0'.repeat(64)},{purpose:'mobile-browser'}]){
      const count=before();await expect(f.identity.signHandshake('mobile-agent',{...golden.transcript,...patch} as MobileControlTranscript,own,mobile,use)).rejects.toThrow();expect(before()).toBe(count);
    }
    f.state.closedSession=true;await expect(f.identity.signHandshake('mobile-agent',golden.transcript as MobileControlTranscript,own,mobile,use)).rejects.toThrow('SESSION_EXPIRED');expect(before()).toBe(0);
    f.state.closedSession=false;f.state.nativeHook=(request,response)=>{if(request.payload?.kind==='mobile-host-handshake')response.signature=Buffer.alloc(64).toString('base64url');};
    await expect(f.identity.signHandshake('mobile-agent',golden.transcript as MobileControlTranscript,own,mobile,use)).rejects.toThrow('NATIVE_INVALID_PROOF');
    f.identity.close();const count=f.state.nativeRequests.length;await expect(f.identity.context()).rejects.toThrow('NATIVE_IDENTITY_ENDED');expect(f.state.nativeRequests).toHaveLength(count);expect(f.link.verifiedMain).toBe(true);
  }finally{f.close();}
});

test('the wrapper retains MainLink bounded admission and never retries a dispatched proof with an unknown outcome',async()=>{
  const burst=fixture();try{
    const results=await Promise.allSettled(Array.from({length:64},()=>burst.identity.context()));
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(17);expect(burst.state.nativeRequests).toHaveLength(17);expect(burst.state.httpRequests).toEqual([]);
  }finally{burst.close();}
  const lost=fixture();try{
    lost.state.dropAccessResponse=true;let error:any;try{await lost.identity.authorization('mobile-agent');}catch(e){error=e;}
    expect(error.code).toBe('outcome-unknown');expect(error.notDispatched).toBe(false);expect(lost.state.httpRequests).toEqual([]);
    expect(lost.state.nativeRequests.filter(r=>r.payload?.kind==='access')).toHaveLength(1);
    const count=lost.state.nativeRequests.length;await expect(lost.identity.authorization('mobile-agent')).rejects.toThrow();expect(lost.state.nativeRequests).toHaveLength(count);
  }finally{lost.close();}
},5000);

test('initial unenrolled Native state cannot sign, and later actual enrollment can bind without a fallback identity',async()=>{
  const f=fixture();try{
    f.context.configured=false;await expect(f.identity.authorization('mobile-agent')).rejects.toThrow('NATIVE_ENROLLMENT_REQUIRED');
    expect(f.state.httpRequests).toEqual([]);expect(f.state.nativeRequests.some(r=>r.operation==='community-component-sign')).toBe(false);
    f.context.configured=true;expect((await f.identity.authorization('mobile-agent')).body.deviceId).toBe(f.auth.deviceId);
  }finally{f.close();}
});
