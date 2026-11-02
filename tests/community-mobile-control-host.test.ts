import {test,expect} from 'bun:test';import {randomBytes,randomUUID,generateKeyPairSync} from 'node:crypto';
import {createMobileHostFixture,waitFor,point} from './fixtures/communityMobileHostFixture';
function operation(at:number){const b=randomBytes(16);b.writeUIntBE(at,0,6);b[6]=(b[6]!&15)|0x70;b[8]=(b[8]!&63)|0x80;const h=b.toString('hex');return {operationId:`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`,createdAt:at};}
const effect=(at:number)=>({mode:'effect',...operation(at),command:{op:'count'}});

test('mutual proof and confirmation gate all effects; capabilities are real and completed IDs never execute twice',async()=>{
  const f=createMobileHostFixture();try{
    await f.host.start();expect(f.host.status().purposes.every(p=>p.connected)).toBe(true);expect(f.state.ledgerOpens).toBe(0);
    const c=await f.client();await c.handshake();expect(f.state.effects).toBe(0);
    const capId=await c.dispatch({mode:'query',command:{op:'capabilities'}}),caps=await c.result(capId);expect(caps.result).toMatchObject({outcome:'capabilities',purpose:'mobile-agent'});expect(f.state.ledgerOpens).toBe(0);
    const command=effect(f.now()),id=await c.dispatch(command),answer=await c.result(id);expect(answer.result).toEqual({outcome:'done',count:1});expect(f.state.effects).toBe(1);expect(f.state.lastGuard!.operationId).toBe(command.operationId);
    const duplicate=await c.dispatch(command);expect((await c.result(duplicate)).result).toEqual(answer.result);expect(f.state.effects).toBe(1);
    const receipt=await c.dispatch({mode:'receipt',operationId:command.operationId,createdAt:command.createdAt});const stored=await c.result(receipt);expect(stored.response.result).toBe(answer.response.result);expect(stored.response.resultDigest).toBe(answer.response.resultDigest);
    const bad=await c.dispatch({mode:'consumed',operationId:command.operationId,createdAt:command.createdAt,resultDigest:'0'.repeat(64)});expect((await c.result(bad)).result).toMatchObject({outcome:'refused'});
    const consumed=await c.dispatch({mode:'consumed',operationId:command.operationId,createdAt:command.createdAt,resultDigest:answer.response.resultDigest});expect((await c.result(consumed)).result).toEqual({outcome:'consumed',operationId:command.operationId,createdAt:command.createdAt});
  }finally{await f.close();}
});

test('foreign or unproved hello/finish never evicts a live channel and identity-key ephemerals are rejected',async()=>{
  const f=createMobileHostFixture();try{
    await f.host.start();const good=await f.client(0);await good.handshake();const evil=await f.client(1);
    await evil.hello({channelId:(good as any).channel});await evil.send({v:2,type:'finish',channelId:(good as any).channel,clientProof:randomBytes(64).toString('base64url'),clientConfirmation:randomBytes(32).toString('base64url')});
    await evil.hello({senderEphemeral:point(evil.person.session.publicKey)});await new Promise(r=>setTimeout(r,20));expect(f.host.status().activeChannels).toBe(1);expect(f.state.effects).toBe(0);
    const id=await good.dispatch({mode:'query',command:{op:'read'}});expect((await good.result(id)).result).toMatchObject({count:0});
    await evil.hello();await evil.next('challenge');await evil.send({v:2,type:'finish',channelId:(evil as any).channel,clientProof:randomBytes(64).toString('base64url'),clientConfirmation:randomBytes(32).toString('base64url')});
    await waitFor(()=>f.host.status().pendingHandshakes,n=>n===0);expect(f.host.status().activeChannels).toBe(1);expect(f.state.ledgerOpens).toBe(0);
  }finally{await f.close();}
});

test('two mobile identities operate independently and revocation blocks only the revoked channel',async()=>{
  const f=createMobileHostFixture();try{
    await f.host.start();const a=await f.client(0),b=await f.client(1);await Promise.all([a.handshake(),b.handshake()]);expect(f.host.status().activeChannels).toBe(2);
    const one=await a.dispatch(effect(f.now())),two=await b.dispatch(effect(f.now()));await Promise.all([a.result(one),b.result(two)]);expect(f.state.effects).toBe(2);
    f.mobiles[0]!.active=false;await a.dispatch(effect(f.now()));await waitFor(()=>f.host.status().activeChannels,n=>n===1);expect(f.state.effects).toBe(2);
    const live=await b.dispatch({mode:'query',command:{op:'read'}});expect((await b.result(live)).result).toMatchObject({count:2});
  }finally{await f.close();}
});

test('an active channel renews expired credential bodies only when fresh policies and use remain identical',async()=>{
  const f=createMobileHostFixture();try{
    f.issueDelay(80_000);await f.host.start();const c=await f.client();await c.handshake();f.advance(11_000);f.issueDelay(0);
    const query=await c.dispatch({mode:'query',command:{op:'read'}});expect((await c.result(query)).result).toMatchObject({count:0});expect(f.host.status().activeChannels).toBe(1);
    f.mobiles[0]!.revision++;await c.dispatch(effect(f.now()));await waitFor(()=>f.host.status().activeChannels,n=>n===0);expect(f.state.effects).toBe(0);
  }finally{await f.close();}
});

test('response loss, restart and a new RAM episode recover the original receipt without an effect replay',async()=>{
  const f=createMobileHostFixture();try{
    await f.host.start();const c=await f.client();await c.handshake();f.state.dropResponses=true;const command=effect(f.now());await c.dispatch(command);await waitFor(()=>f.state.effects,n=>n===1);
    c.close();f.state.dropResponses=false;await f.restart();const p=f.mobiles[0]!;p.session=generateKeyPairSync('ec',{namedCurve:'prime256v1'});p.sessionId=randomUUID();
    const reopened=await f.client();await reopened.handshake();const receipt=await reopened.dispatch({mode:'receipt',operationId:command.operationId,createdAt:command.createdAt});expect((await reopened.result(receipt)).result).toEqual({outcome:'done',count:1});
    const repeated=await reopened.dispatch(command);expect((await reopened.result(repeated)).result).toMatchObject({count:1});expect(f.state.effects).toBe(1);
    f.state.denyScope=true;const denied=await reopened.dispatch({mode:'receipt',operationId:command.operationId,createdAt:command.createdAt});expect((await reopened.result(denied)).result).toEqual({outcome:'refused',code:'MOBILE_RECEIPT_SCOPE_DENIED'});
  }finally{await f.close();}
});

test('queue age and the same backend guard prevent late effects, while execution errors and oversize remain unknown',async()=>{
  const f=createMobileHostFixture();try{
    await f.host.start();const c=await f.client();await c.handshake();let release!:()=>void;f.state.block=new Promise<void>(r=>{release=r;});
    const query=await c.dispatch({mode:'query',command:{op:'read'}});await waitFor(()=>f.state.lastGuard,v=>v!==null);
    const command=effect(f.now()),queued=await c.dispatch(command);f.advance(12_000);f.state.block=undefined;release();await c.result(query);
    expect((await c.result(queued)).result).toMatchObject({outcome:'unknown',operationId:command.operationId});expect(f.state.effects).toBe(0);
    f.state.oversize=true;const big=await c.dispatch(effect(f.now()));expect((await c.result(big)).result).toMatchObject({outcome:'unknown'});expect(f.state.effects).toBe(1);
    f.state.oversize=false;f.state.throwRun=true;const thrown=await c.dispatch(effect(f.now())),answer=await c.result(thrown);expect(answer.result).toMatchObject({outcome:'unknown'});expect(JSON.stringify(answer.result)).not.toContain('secret');expect(f.state.effects).toBe(2);
  }finally{await f.close();}
});

test('unproved handshakes are bounded to eight and cannot allocate a receipt store',async()=>{
  const f=createMobileHostFixture();try{
    for(let i=0;i<7;i++)f.addMobile();await f.host.start();
    for(let i=0;i<8;i++){const c=await f.client(i);await c.hello();await c.next('challenge');}
    const ninth=await f.client(8);await ninth.hello();await new Promise(r=>setTimeout(r,20));
    expect(f.host.status().pendingHandshakes).toBe(8);expect(f.host.status().activeChannels).toBe(0);expect(f.state.ledgerOpens).toBe(0);expect(f.state.effects).toBe(0);
  }finally{await f.close();}
});

test('active channels stop at thirty-two and a peer-end releases only that exact peer/purpose channel',async()=>{
  const f=createMobileHostFixture();try{
    for(let i=0;i<7;i++)f.addMobile();await f.host.start();const clients=[];
    for(let i=0;i<8;i++)for(const purpose of ['mobile-agent','mobile-teams','mobile-agent-settings','mobile-browser'] as const){const c=await f.client(i,purpose);await c.handshake();clients.push(c);}
    expect(f.host.status().activeChannels).toBe(32);const extra=await f.client(8);await extra.hello();await new Promise(r=>setTimeout(r,20));expect(f.host.status().activeChannels).toBe(32);expect(f.host.status().pendingHandshakes).toBe(0);
    clients[0]!.close();await waitFor(()=>f.host.status().activeChannels,n=>n===31);await extra.handshake();expect(f.host.status().activeChannels).toBe(32);expect(f.state.effects).toBe(0);
  }finally{await f.close();}
},10000);

test('a blocked peer has eight ordered admissions while another mobile still makes progress',async()=>{
  const f=createMobileHostFixture();try{
    await f.host.start();const a=await f.client(0),b=await f.client(1);await a.handshake();await b.handshake();let release!:()=>void;f.state.block=new Promise<void>(r=>{release=r;});
    const query=await a.dispatch({mode:'query',command:{op:'read'}});await waitFor(()=>f.state.lastGuard,v=>v!==null);const ids=[];
    for(let i=0;i<12;i++)ids.push(await a.dispatch(effect(f.now())));await new Promise(r=>setTimeout(r,10));
    expect(Math.max(...[...(f.host as any).queues.values()].map((q:any)=>q.count))).toBe(8);
    const other=await b.dispatch(effect(f.now()));await waitFor(()=>f.state.effects,n=>n===1);f.state.block=undefined;release();
    await a.result(query);await b.result(other);for(const id of ids.slice(0,7))await a.result(id);
    expect(f.state.effects).toBe(8);expect(a.packets.filter(p=>p.type==='record')).toHaveLength(8);
  }finally{await f.close();}
});

test('unlocking after the first protected store preparation failure permits only original receipt reads and a fresh new intent',async()=>{
  const f=createMobileHostFixture();try{
    f.state.ledgerFailure='STORAGE_LOCKED';await f.host.start();const first=await f.client(0,'mobile-browser');await first.handshake();
    const original=effect(f.now()),lost=await first.dispatch(original);await waitFor(()=>f.state.ledgerOpens,n=>n===1);await waitFor(()=>f.host.status().activeChannels,n=>n===0);
    await expect(first.result(lost,40)).rejects.toThrow('fixture timeout');expect(f.state.effects).toBe(0);first.close();
    f.state.ledgerFailure=null;const resumed=await f.client(0,'mobile-browser');await resumed.handshake();
    const read=await resumed.dispatch({mode:'receipt',operationId:original.operationId,createdAt:original.createdAt}),answer=await resumed.result(read);
    expect(answer.result).toMatchObject({outcome:expect.stringMatching(/^(unseen|unknown)$/)});expect(f.state.effects).toBe(0);expect(f.state.ledgerOpens).toBe(2);expect(f.state.ledgerPurposes).toEqual(['mobile-browser','mobile-browser']);
    const fresh=effect(f.now()),sent=await resumed.dispatch(fresh);expect((await resumed.result(sent)).result).toEqual({outcome:'done',count:1});expect(f.state.effects).toBe(1);
    const duplicate=await resumed.dispatch(fresh);expect((await resumed.result(duplicate)).result).toMatchObject({count:1});expect(f.state.effects).toBe(1);
    const old=await resumed.dispatch({mode:'receipt',operationId:original.operationId,createdAt:original.createdAt});expect((await resumed.result(old)).result).toMatchObject({outcome:expect.stringMatching(/^(unseen|unknown)$/)});expect(f.state.effects).toBe(1);expect(f.state.ledgerOpens).toBe(2);
  }finally{await f.close();}
});

test.each(['KEY_MISSING','MOBILE_STORE_KEY_MISMATCH'])('releasing failed preparation never turns persistent %s into authority or an effect',async failure=>{
  const f=createMobileHostFixture();try{
    f.state.ledgerFailure=failure;await f.host.start();
    for(let attempt=1;attempt<=2;attempt++){
      const client=await f.client();await client.handshake();await client.dispatch(effect(f.now()));await waitFor(()=>f.state.ledgerOpens,n=>n===attempt);await waitFor(()=>f.host.status().activeChannels,n=>n===0);client.close();
      expect(f.state.effects).toBe(0);expect(f.state.lookup).toBe(0);
    }
    expect(f.state.ledgerOpens).toBe(2);expect(f.state.effects).toBe(0);
  }finally{await f.close();}
});
