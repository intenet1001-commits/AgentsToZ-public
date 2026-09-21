/** Controlled scheduling benchmark, not a live iPhone/cellular measurement.
 * Run: bun scripts/measure-workroom-relay-latency.ts /path/to/baseline-worktree
 */
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {buildRemoteControlRelayPairingUrl,encodeRemoteControlRelayBase64Url,REMOTE_CONTROL_RELAY_SCHEMA_VERSION,type RemoteControlRelayEnvelope} from '../src/remoteControlRelayContract';
import {decryptRemoteControlRelayEnvelope,deriveRemoteControlRelaySessionKey,encryptRemoteControlRelayEnvelope,exportRemoteControlRelayPublicKey,fingerprintRemoteControlRelayPublicKey,generateRemoteControlRelayKeyPair,importRemoteControlRelayPublicKey} from '../src/remoteControlRelayCrypto';
import {REMOTE_CONTROL_PROTOCOL_VERSION} from '../src/remoteControlCore';

const baselineRoot=process.argv[2];
if(!baselineRoot)throw new Error('Pass the exact baseline worktree path.');
const candidateRoot=resolve(import.meta.dir,'..');
const loadController=async(root:string)=>{
  const module=await import(pathToFileURL(resolve(root,'src/remoteControlRelayController.ts')).href);
  return module.RemoteControlRelayController as typeof import('../src/remoteControlRelayController').RemoteControlRelayController;
};
const baselineController=await loadController(baselineRoot);
const candidateController=await loadController(candidateRoot);
const encoder=new TextEncoder();
const decoder=new TextDecoder();
const startTime=Date.parse('2099-08-30T12:00:00.000Z');
const expiresAt='2099-08-30T12:30:00.000Z';
const pairingExpiresAt='2099-08-30T12:05:00.000Z';
const hostId='11111111-1111-4111-8111-111111111111';
const pairingId='22222222-2222-4222-8222-222222222222';
const sessionId='33333333-3333-4333-8333-333333333333';
const controllerId='44444444-4444-4444-8444-444444444444';
const pairingSecret=encodeRemoteControlRelayBase64Url(new Uint8Array(32).fill(4));
const phases=[100,200,300,400,500,600,700,800,900];
const rpcCosts=[0,100,250];
const commit=(root:string)=>execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();

async function sample(Controller:typeof candidateController,inputPhase:number,readPhase:number,rpcCost:number):Promise<number>{
  const host=await generateRemoteControlRelayKeyPair();
  const hostPublicKey=await exportRemoteControlRelayPublicKey(host.publicKey);
  const hostFingerprint=await fingerprintRemoteControlRelayPublicKey(hostPublicKey);
  let elapsed=0,clock=startTime,measuring=false,sequence=1;
  let hostReceive:CryptoKey,hostSend:CryptoKey;
  let pending:{requestId:string;operation:string;readyAt:number;delivered:boolean}|null=null;
  const deliveries:Array<{relaySequence:string;envelope:RemoteControlRelayEnvelope}>=[];
  const advance=(ms:number)=>{if(measuring){elapsed+=ms;clock=startTime+elapsed;}};
  const deliver=async(message:unknown)=>{
    const current=sequence++;
    deliveries.push({relaySequence:String(current),envelope:await encryptRemoteControlRelayEnvelope({
      key:hostSend,metadata:{schemaVersion:REMOTE_CONTROL_RELAY_SCHEMA_VERSION,
        messageId:`9999999${current}-9999-4999-8999-999999999999`,sessionId,controllerId,
        sequence:current,expiresAt:pairingExpiresAt},
      plaintext:encoder.encode(JSON.stringify(message)),now:clock,
    })});
  };
  const transport={
    controllerPublicKey:'',
    async claimPairing(input:{controllerPublicKey:string}){
      this.controllerPublicKey=input.controllerPublicKey;
      return {sessionId,controllerId,hostId,hostName:'Benchmark Mac',hostPublicKey,hostPublicKeyFingerprint:hostFingerprint,
        approvalState:'pending' as const,expiresAt};
    },
    async status(){return {sessionId,controllerId,approvalState:'approved' as const,hostEnabled:true,
      hostExpiresAt:expiresAt,sessionExpiresAt:expiresAt,revokedAt:null,hostLastSeenAt:null};},
    async sendEnvelope(_hostId:string,_sessionId:string,envelope:RemoteControlRelayEnvelope){
      advance(rpcCost);
      if(!measuring)return;
      const message=JSON.parse(decoder.decode(await decryptRemoteControlRelayEnvelope({key:hostReceive,envelope,now:clock})));
      if(message.type!=='terminal.request')throw new Error('Unexpected relay request');
      const operation=message.request.operation as string;
      pending={requestId:message.request.requestId,operation,readyAt:elapsed+(operation==='input'?inputPhase:readPhase),delivered:false};
    },
    async receiveEnvelopes(_hostId:string,_sessionId:string,after:string){
      advance(rpcCost);
      const due=pending;
      if(due&&!due.delivered&&elapsed>=due.readyAt){
        due.delivered=true;
        const session={id:'test-session',targetId:'test-project',agent:'codex',state:'running',
          createdAt:new Date(startTime).toISOString(),exitCode:null,cols:100,rows:28};
        const body=due.operation==='read'?{session,chunks:[],nextCursor:0,truncated:false,hasMore:false}:{session};
        await deliver({type:'terminal.result',requestId:due.requestId,ok:true,body});
      }
      return deliveries.filter(item=>BigInt(item.relaySequence)>BigInt(after));
    },
    async acknowledge(){advance(rpcCost);},
    async revoke(){},
  };
  const controller=new Controller({transport,pairingUrl:buildRemoteControlRelayPairingUrl('https://remote.example.test/remote/',{
    schemaVersion:REMOTE_CONTROL_RELAY_SCHEMA_VERSION,hostId,pairingId,pairingSecret,hostPublicKey,expiresAt:pairingExpiresAt,
  }),controllerName:'Benchmark iPhone',now:()=>clock,sleep:async(ms:number)=>advance(ms)});
  await controller.initialize();
  const controllerPublic=await importRemoteControlRelayPublicKey(transport.controllerPublicKey);
  hostReceive=await deriveRemoteControlRelaySessionKey({privateKey:host.privateKey,peerPublicKey:controllerPublic,
    sessionId,controllerId,direction:'controller-to-host',usages:['decrypt']});
  hostSend=await deriveRemoteControlRelaySessionKey({privateKey:host.privateKey,peerPublicKey:controllerPublic,
    sessionId,controllerId,direction:'host-to-controller',usages:['encrypt']});
  await controller.refresh();
  await deliver({type:'session.ready',protocolVersion:REMOTE_CONTROL_PROTOCOL_VERSION,sessionToken:'T'.repeat(43),
    hostName:'Benchmark Mac',expiresAt,idleExpiresAt:'2099-08-30T12:10:00.000Z',projects:[],projectCount:0,nextPage:null});
  await controller.refresh();
  if(controller.status().state!=='online')throw new Error('Controller did not pair');
  measuring=true;
  await controller.sendTerminal({operation:'input',requestId:'benchmark-key',sessionId:'test-session',data:'2'});
  await controller.sendTerminal({operation:'read',requestId:'benchmark-read',sessionId:'test-session',after:0});
  if(!pending?.delivered)throw new Error('Output result not delivered');
  return elapsed;
}

const median=(values:number[])=>values[Math.floor(values.length/2)]!;
console.log(JSON.stringify({kind:'virtual-relay-fixture',baselineCommit:commit(baselineRoot),candidateCommit:commit(candidateRoot),
  hostResultPhasesMs:phases,scope:'control key input acknowledgement + first output read; no real network, CLI, or screen paint'}));
for(const rpcCost of rpcCosts){
  const before:number[]=[],after:number[]=[];
  for(const inputPhase of phases)for(const readPhase of phases){
    before.push(await sample(baselineController,inputPhase,readPhase,rpcCost));
    after.push(await sample(candidateController,inputPhase,readPhase,rpcCost));
  }
  before.sort((a,b)=>a-b);after.sort((a,b)=>a-b);
  const mean=(values:number[])=>Math.round(values.reduce((a,b)=>a+b,0)/values.length);
  const oldMean=mean(before),newMean=mean(after);
  console.log(JSON.stringify({rpcRoundTripMs:rpcCost,cases:before.length,
    baseline:{meanMs:oldMean,medianMs:median(before),p95Ms:before[Math.ceil(before.length*0.95)-1]},
    candidate:{meanMs:newMean,medianMs:median(after),p95Ms:after[Math.ceil(after.length*0.95)-1]},
    meanReductionMs:oldMean-newMean,meanReductionPercent:Math.round((oldMean-newMean)/oldMean*1000)/10}));
}
