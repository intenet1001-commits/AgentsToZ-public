import {describe, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RemoteControlCore, REMOTE_CONTROL_PROTOCOL_VERSION, parseRemoteControlClientMessage, type RemoteControlGateway, type RemoteControlActionRequest} from '../src/remoteControlCore';
import {CodexNewChatReceiptStore} from '../src/codexNewChatReceipts';
import {createCodexNewConversationIntentStore, reserveVerifiedCodexNewIntent} from '../src/codexNewConversationIntent';
import {runCodexNewConversationFlow} from '../src/codexNewConversationFlow';
import {projectCreationIntentFingerprint} from '../src/projectLaunchIntent';

describe('internet Codex new conversation after host restart', () => {
  for (const lostAck of [false, true]) test(`${lostAck ? 'ack' : 'start'} response lost: the same controller rebinds and never starts twice`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-resume-test-'));
    try {
      const now = Date.now(), expiresAt = new Date(now + 60_000).toISOString();
      const authority = {controllerId: 'same-paired-controller', expiresAt};
      const receiptStore = new CodexNewChatReceiptStore(root, () => now);
      const threadId = '2c923dc0-2693-4c4f-8dd5-5c79da7ec10f';
      let starts = 0;
      const gateway: RemoteControlGateway = {
        listRegisteredProjects: () => [{internalId:'project-a', name:'A', kind:'main', folderPath:'/private/project-a', command:'',
          port:null, status:'unknown', actions:['codex.thread.start']}],
        async executeRegisteredProjectAction(request) {
          const binding = {controllerId:request.controllerId!, projectIdentity:request.target.internalId, actionId:request.input ?? request.actionId};
          if (request.action === 'codex.thread.start.v2') {
            const receipt = await receiptStore.reserve({...binding, actionId:request.actionId, expiresAt});
            if (receipt.created) { starts++; await receiptStore.complete({...binding, actionId:request.actionId, threadId}); }
          }
          if (request.action === 'codex.thread.review.v2') return {codexNewChatReceipt: request.input
            ? await receiptStore.reviewExact(binding) : await receiptStore.review(binding)};
          if (request.action === 'codex.thread.ack.v2') await receiptStore.acknowledge(binding);
        },
      };
      const connect = async () => {
        const core = new RemoteControlCore(gateway, {hostName:'Mac'});
        const url = core.enable('http://192.168.1.20:12345').pairingUrl;
        const ready = await core.pair(new URLSearchParams(new URL(url).hash.slice(1)).get('pair')!);
        const controlId = ready.projects[0]!.controlId;
        const send = async (action: RemoteControlActionRequest['action'], actionId: string, input?: string) => {
          const req = parseRemoteControlClientMessage({type:'action.request', protocolVersion:REMOTE_CONTROL_PROTOCOL_VERSION,
            sessionToken:ready.sessionToken, controlId, actionId, action, remoteConfirmed:true, ...(input ? {input} : {})}) as RemoteControlActionRequest;
          const result = await core.perform(req, authority);
          if (!result.ok) throw Object.assign(new Error(result.error.message), {code:result.error.code});
          return result;
        };
        return {controlId,send};
      };
      const browser = new Map<string,string>();
      const storage = {getItem:(key:string)=>browser.get(key)??null,setItem:(key:string,value:string)=>{browser.set(key,value);}};
      const intents = createCodexNewConversationIntentStore(storage, ()=>'saved-action-1', projectCreationIntentFingerprint);
      const old = await connect();
      const initial = intents.reserve('host',authority.controllerId,old.controlId);
      await old.send('codex.thread.start.v2',initial.actionId); // The browser does not receive this success.
      if (lostAck) await old.send('codex.thread.ack.v2','ack-old',initial.actionId); // This reply is lost too.
      const restarted = await connect();
      expect(restarted.controlId).not.toBe(old.controlId);
      const intent = await reserveVerifiedCodexNewIntent({store:intents,hostId:'host',controllerId:authority.controllerId,
        projectControlId:restarted.controlId,fingerprint:projectCreationIntentFingerprint,
        reviewExact:async id=>{const r=await restarted.send('codex.thread.review.v2','review-exact',id);return 'codexNewChatReceipt' in r?r.codexNewChatReceipt:null;}});
      expect(intent?.actionId).toBe(initial.actionId);
      if (!intent) throw new Error('unexpected cancellation');
      const outcome = await runCodexNewConversationFlow({actionId:intent.actionId,
        start:async id=>{await restarted.send('codex.thread.start.v2',id);},
        acknowledge:async id=>{await restarted.send('codex.thread.ack.v2','ack-new',id);},
        review:async()=>null,confirmReview:async()=>false,complete:()=>intents.complete(intent)});
      expect(outcome).toBe('created-or-recovered');
      expect(starts).toBe(1);
      expect(intents.inspect('host',authority.controllerId)).toBeNull();
      expect(await receiptStore.reviewExact({controllerId:authority.controllerId,projectIdentity:'project-a',actionId:initial.actionId}))
        .toEqual({actionId:initial.actionId,state:'acknowledged'});
    } finally { rmSync(root,{recursive:true,force:true}); }
  });
});
