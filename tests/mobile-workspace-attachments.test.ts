import {describe,expect,test} from 'bun:test';
import {normalizeMobileWorkspaceRequest,normalizeMobileWorkspaceResult,workspaceScope} from '../src/mobileWorkspaceProtocol';
import {createMobileWorkspaceGateway} from '../src/mobileWorkspaceGateway';
import {createCommunityControlExecutor} from '../src/agentDialogueControl';
import {
  normalizeWorkroomAttachmentRequest, normalizeWorkroomAttachmentResult, remoteAttachFailureSummary, workroomAttachmentFailureMessage,
  WORKROOM_ATTACH_COMMUNITY_REFUSAL, WORKROOM_ATTACH_FEATURE, WORKROOM_REMOTE_ATTACHMENT_MAX_BYTES,
} from '../src/workroomRemoteAttachmentProtocol';

const HOST='11111111-2222-4333-8444-555555555555',UID='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const item=(extra:Record<string,unknown>={})=>({path:`${HOST}/${UID}/${crypto.randomUUID()}.bin`,token:'signed-token-'+'x'.repeat(30),key:'A'.repeat(43),sha256:'a'.repeat(64),bytes:1024,kind:'image',...extra});
const receiveRequest=(attachments:unknown,targetId='target-dev-1')=>({operation:'workspace',requestId:'attach-'+crypto.randomUUID(),targetId,workspace:{action:'attachments.receive',attachments}});
const statusRequest=(attachments:unknown)=>({operation:'workspace',requestId:'attach-status-'+crypto.randomUUID(),targetId:'target-dev-1',workspace:{action:'attachments.status',attachments}});
const id=()=>'wa_'+'B'.repeat(32);

describe('wire: the receive request', () => {
  test('one flag, two actions, no workspace scope (the project grant is the input grant)', () => {
    expect(WORKROOM_ATTACH_FEATURE).toBe('workroom-attach-v1');
    expect(workspaceScope('attachments.receive')).toBeNull();
    expect(workspaceScope('attachments.status')).toBeNull();
  });

  test('exact keys, one to five items, files may carry a safe name, images may not', () => {
    const receiveId=crypto.randomUUID();
    const ok=normalizeMobileWorkspaceRequest(receiveRequest({receiveId,items:[item(),item({kind:'file',name:'보고서.pdf'})]}));
    expect(ok.workspace.action).toBe('attachments.receive');
    expect(ok.workspace.attachments).toEqual({receiveId,items:expect.any(Array)});
    const refuse=(attachments:unknown)=>expect(()=>normalizeMobileWorkspaceRequest(receiveRequest(attachments))).toThrow();
    refuse({receiveId,items:[]});
    refuse({receiveId,items:Array.from({length:6},()=>item())});
    refuse({receiveId,items:[item({url:'https://evil.example'})]});
    refuse({receiveId,items:[item({name:'a.png'})]});
    refuse({receiveId,items:[item({kind:'file',name:'a\u202egnp.exe'})]});
    refuse({receiveId,items:[item({kind:'file',name:'line\nbreak'})]});
    refuse({receiveId,items:[item({kind:'file',name:'가'.repeat(81)})]});
    refuse({receiveId,items:[item({bytes:0})]});
    refuse({receiveId,items:[item({bytes:WORKROOM_REMOTE_ATTACHMENT_MAX_BYTES+1})]});
    refuse({receiveId,items:[item({kind:'folder'})]});
    refuse({receiveId,items:[item({path:`${HOST}/../${UID}/x.bin`})]});
    refuse({receiveId,items:[item({sha256:'A'.repeat(64)})]});
    refuse({receiveId,items:[item({key:'short'})]});
    const same=item();refuse({receiveId,items:[same,{...same}]});
    refuse({receiveId:'not-a-uuid',items:[item()]});
    refuse({receiveId,items:[item()],extra:1});
    expect(normalizeWorkroomAttachmentRequest('attachments.receive',{receiveId,items:[item({bytes:WORKROOM_REMOTE_ATTACHMENT_MAX_BYTES})]}).items[0]!.bytes).toBe(WORKROOM_REMOTE_ATTACHMENT_MAX_BYTES);
  });

  test('the worst five items still fit the 10,000-byte JSON budget inside the 11,000-byte relay plaintext', () => {
    const receiveId=crypto.randomUUID();
    // Longest token (1,200), longest name (80 four-byte code points), largest size: the bound holds with room to spare.
    const worst=Array.from({length:5},()=>item({kind:'file',token:'t'.repeat(1200),name:'😀'.repeat(80),bytes:WORKROOM_REMOTE_ATTACHMENT_MAX_BYTES}));
    const normalized=normalizeWorkroomAttachmentRequest('attachments.receive',{receiveId,items:worst});
    expect(new TextEncoder().encode(JSON.stringify(normalized)).length).toBeLessThanOrEqual(10_000);
    const envelope=normalizeMobileWorkspaceRequest(receiveRequest({receiveId,items:worst}));
    expect(new TextEncoder().encode(JSON.stringify({type:'terminal.request',sessionToken:'s'.repeat(43),request:envelope})).length).toBeLessThan(11_000);
    // A name that is not well-formed text (a lone surrogate) is refused: it cannot name a file and would grow in JSON.
    expect(()=>normalizeWorkroomAttachmentRequest('attachments.receive',{receiveId,items:[item({kind:'file',name:'a\ud800b'})]})).toThrow();
    expect(()=>normalizeWorkroomAttachmentRequest('attachments.receive',{receiveId,items:[item({token:'t'.repeat(1201)})]})).toThrow();
  });

  test('a status names its receiveId only', () => {
    const receiveId=crypto.randomUUID();
    expect(normalizeMobileWorkspaceRequest(statusRequest({receiveId})).workspace.attachments).toEqual({receiveId});
    expect(()=>normalizeMobileWorkspaceRequest(statusRequest({receiveId,items:[]}))).toThrow();
    expect(()=>normalizeMobileWorkspaceRequest(statusRequest({}))).toThrow();
    // The field belongs to these two actions only.
    expect(()=>normalizeMobileWorkspaceRequest({operation:'workspace',requestId:'r-12345678',targetId:'target-dev-1',workspace:{action:'voc.inbox',attachments:{receiveId}}})).toThrow();
  });
});

describe('wire: the answer', () => {
  test('ready items carry an opaque id and sizes only; failed items a code and Korean words', () => {
    const receiveId=crypto.randomUUID();
    const result={kind:'workspace',action:'attachments.receive',workroomAttachments:{receiveId,items:[
      {state:'pending'},
      {state:'ready',id:id(),kind:'image',bytes:1024,lineBytes:88,expiresInMs:3_600_000,removed:true},
      {state:'failed',code:'WORKROOM_ATTACH_HASH_MISMATCH',message:workroomAttachmentFailureMessage('WORKROOM_ATTACH_HASH_MISMATCH'),removed:false},
    ]}};
    expect(normalizeMobileWorkspaceResult(result)).toEqual(result as never);
    expect(normalizeWorkroomAttachmentResult(result.workroomAttachments)).toEqual(result.workroomAttachments as never);
    const refuse=(items:unknown[])=>expect(()=>normalizeMobileWorkspaceResult({...result,workroomAttachments:{receiveId,items}})).toThrow();
    refuse([{state:'ready',id:'/Users/x/a.png',kind:'image',bytes:1,lineBytes:1,expiresInMs:1,removed:true}]);
    refuse([{state:'ready',id:id(),kind:'image',bytes:1,lineBytes:1,expiresInMs:1,removed:true,path:'/Users/x/a.png'}]);
    refuse([{state:'pending',id:id()}]);
    refuse([{state:'failed',code:'nope',message:'x',removed:true}]);
    refuse([]);
    expect(()=>normalizeMobileWorkspaceResult({...result,voc:{}})).toThrow();
    expect(()=>normalizeMobileWorkspaceResult({kind:'workspace',action:'voc.inbox',workroomAttachments:result.workroomAttachments})).toThrow();
  });

  test('partial-failure words the composer shows', () => {
    expect(remoteAttachFailureSummary(3,1)).toBe('첨부 3개 중 1개를 전달하지 못했습니다');
    for(const code of ['WORKROOM_ATTACH_HASH_MISMATCH','WORKROOM_ATTACH_NOT_IMAGE','WORKROOM_ATTACH_DOWNLOAD_FAILED','WORKROOM_ATTACH_INTERRUPTED','WORKROOM_ATTACH_UNKNOWN_CODE_X'])
      expect(workroomAttachmentFailureMessage(code)).toMatch(/[가-힣]/);
  });
});

describe('gateway: grants, rate, community', () => {
  const gatewayFor=(options:{targetIds?:string[];performed?:string[]}={})=>{
    const performed=options.performed??[];
    return {performed,gateway:createMobileWorkspaceGateway({
      terminal:async()=>{throw new Error('not used');},active:()=>true,
      resolve:async()=>[{controlId:'target-dev-1',runtimeTargetId:'runtime-dev'}],
      consent:async()=>({targetIds:new Set(options.targetIds??['runtime-dev']),workspaceScopes:[],isActive:()=>true,requestOwner:'device:h:internet:c'}),
      perform:async(request,targetId,owner)=>{performed.push(`${request.workspace.action}:${targetId}:${owner}`);
        return {kind:'workspace',action:request.workspace.action,workroomAttachments:{receiveId:(request.workspace.attachments as {receiveId:string}).receiveId,items:[{state:'pending'}]}} as never;},
      opsRuntimeTargetId:()=>'runtime-ops',forward:async()=>{throw new Error('must not forward');},
    })};
  };

  test('the device grant must cover the project: a target outside it is refused', async () => {
    const outside=gatewayFor({targetIds:['other']});
    await expect(outside.gateway(normalizeMobileWorkspaceRequest(receiveRequest({receiveId:crypto.randomUUID(),items:[item()]})) as never,[],'internet:s1')).rejects.toThrow('프로젝트 범위');
    expect(outside.performed).toEqual([]);
    const inside=gatewayFor();
    await inside.gateway(normalizeMobileWorkspaceRequest(receiveRequest({receiveId:crypto.randomUUID(),items:[item()]})) as never,[],'internet:s1');
    expect(inside.performed).toEqual(['attachments.receive:runtime-dev:device:h:internet:c']);
  });

  test('ten receives per minute per owner; the eleventh is refused before anything runs', async () => {
    const {gateway,performed}=gatewayFor();
    for(let i=0;i<10;i++)await gateway(normalizeMobileWorkspaceRequest(receiveRequest({receiveId:crypto.randomUUID(),items:[item()]})) as never,[],'internet:rate');
    await expect(gateway(normalizeMobileWorkspaceRequest(receiveRequest({receiveId:crypto.randomUUID(),items:[item()]})) as never,[],'internet:rate')).rejects.toThrow('(WORKROOM_ATTACH_RATE_LIMITED)');
    expect(performed).toHaveLength(10);
    // A status spends the read budget, not the receive budget.
    await gateway(normalizeMobileWorkspaceRequest(statusRequest({receiveId:crypto.randomUUID()})) as never,[],'internet:rate');
    expect(performed).toHaveLength(11);
  });

  test('another AgentsToZ (a forwarded device request) is refused with the reason', async () => {
    const {gateway,performed}=gatewayFor();
    await expect(gateway(normalizeMobileWorkspaceRequest(receiveRequest({receiveId:crypto.randomUUID(),items:[item()]})) as never,[],'internet:s1',()=>true,'devref1234567890')).rejects.toThrow(WORKROOM_ATTACH_COMMUNITY_REFUSAL);
    await expect(gateway(normalizeMobileWorkspaceRequest(statusRequest({receiveId:crypto.randomUUID()})) as never,[],'internet:s1',()=>true,'devref1234567890')).rejects.toThrow(WORKROOM_ATTACH_COMMUNITY_REFUSAL);
    // A Workroom submission naming attachment ids is not forwarded to another AgentsToZ either.
    const submission={operation:'submission',requestId:'submission-'+crypto.randomUUID(),sessionId:'session-00000001',submission:{phase:'single',id:'submission-0001',bytes:1,digest:'a'.repeat(64),data:'DQ==',attachments:[id()]}};
    await expect(gateway(submission as never,[],'internet:s1',()=>true,'devref1234567890')).rejects.toThrow(WORKROOM_ATTACH_COMMUNITY_REFUSAL);
    expect(performed).toEqual([]);
  });

  test('the community executor refuses attachments outright (its receiver runs only workroom.* actions anyway)', async () => {
    const calls:string[]=[];
    const run=createCommunityControlExecutor({terminal:async()=>{calls.push('terminal');return {};},workspace:async()=>{calls.push('workspace');return {};},projects:async()=>({projects:[],opsTargetId:null,deviceName:'x'})});
    for(const action of ['attachments.receive','attachments.status'])
      await expect(run({kind:'terminal',body:{operation:'workspace',requestId:'request-0001',targetId:'project-aaaa',workspace:{action,attachments:{receiveId:crypto.randomUUID()}}}})).rejects.toThrow(WORKROOM_ATTACH_COMMUNITY_REFUSAL);
    expect(calls).toEqual([]);
  });
});

describe('api-server wiring (source contract; the boot itself is checked separately)', () => {
  test('the ledger feeds the terminal service and the phone workspace path, and the flag is advertised on both host builds', async () => {
    const api=await Bun.file(new URL('../api-server.ts',import.meta.url)).text();
    expect(api).toContain('remoteAttachments: workroomRemoteAttachments');
    expect(api).toContain("action==='attachments.receive'||action==='attachments.status'||action==='attachments.rebind'||action==='attachments.release'");
    expect(api.match(/historySupported: true, attachmentsSupported: true/g)?.length).toBe(2);
    // The community receiver keeps running only workroom.* actions, so attachments never reach it from another Mac.
    expect(api).toContain("if(!request.workspace.action.startsWith('workroom.'))throw new Error('다른 기기에서는 워크룸 동작만 실행할 수 있습니다.');");
  });
});

describe('wire: rebind and release (review w13)', () => {
  const idsRequest=(action:string,attachments:unknown)=>({operation:'workspace',requestId:'attach-ids-'+crypto.randomUUID(),targetId:'target-dev-1',workspace:{action,attachments}});
  test('they name one to five unique ids and nothing else; no workspace scope', () => {
    const receiveId=crypto.randomUUID();
    for(const action of ['attachments.rebind','attachments.release']){
      expect(workspaceScope(action as never)).toBeNull();
      const ok=normalizeMobileWorkspaceRequest(idsRequest(action,{receiveId,ids:[id(),'wa_'+'C'.repeat(32)]}) as never);
      expect(ok.workspace.attachments).toEqual({receiveId,ids:[id(),'wa_'+'C'.repeat(32)]});
      const refuse=(attachments:unknown)=>expect(()=>normalizeMobileWorkspaceRequest(idsRequest(action,attachments) as never)).toThrow();
      refuse({receiveId,ids:[]});
      refuse({receiveId,ids:Array.from({length:6},(_,i)=>'wa_'+String(i).repeat(32))});
      refuse({receiveId,ids:[id(),id()]});
      refuse({receiveId,ids:['/Users/x/a.png']});
      refuse({receiveId,ids:[id()],items:[]});
      refuse({receiveId:'nope',ids:[id()]});
    }
    const result={kind:'workspace',action:'attachments.release',workroomAttachments:{receiveId,items:[{state:'failed',code:'WORKROOM_ATTACH_RELEASED',message:workroomAttachmentFailureMessage('WORKROOM_ATTACH_RELEASED'),removed:true}]}};
    expect(normalizeMobileWorkspaceResult(result)).toEqual(result as never);
  });

  test('another AgentsToZ cannot rebind or release, here or through the community executor', async () => {
    const run=createCommunityControlExecutor({terminal:async()=>({}),workspace:async()=>({}),projects:async()=>({projects:[],opsTargetId:null,deviceName:'x'})});
    for(const action of ['attachments.rebind','attachments.release'])
      await expect(run({kind:'terminal',body:{operation:'workspace',requestId:'request-0001',targetId:'project-aaaa',workspace:{action,attachments:{receiveId:crypto.randomUUID(),ids:[id()]}}}})).rejects.toThrow(WORKROOM_ATTACH_COMMUNITY_REFUSAL);
  });
});
