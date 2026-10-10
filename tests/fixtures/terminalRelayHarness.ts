import {RemoteControlInternetAgent,type RemoteControlInternetHostTransport,type RemoteControlInternetHostRegistration,type RemoteControlInternetSessionRow,type RemoteControlInternetReceivedEnvelope} from '../../src/remoteControlInternetAgent';
import {RemoteControlRelayController,type RemoteControlRelayControllerTransport} from '../../src/remoteControlRelayController';
import {fingerprintRemoteControlRelayPublicKey} from '../../src/remoteControlRelayCrypto';
import type {RemoteControlRelayEnvelope} from '../../src/remoteControlRelayContract';
import type {RemoteControlGateway} from '../../src/remoteControlCore';
import type {RemoteTerminalGateway} from '../../src/remoteControlTerminalProtocol';

/** Memory relay preserves the production encrypted envelope and approval protocols. */
export async function terminalRelayHarness(gateway:RemoteControlGateway,terminalGateway:RemoteTerminalGateway,options:{now?:()=>number}={}) {
 const now=options.now??Date.now;
 const sessionId=crypto.randomUUID(),controllerId=crypto.randomUUID();
 const expiresAt=new Date(now()+30*24*3600_000).toISOString();
 let registration!:RemoteControlInternetHostRegistration;
 let session:RemoteControlInternetSessionRow|null=null;
 const hostInbox:RemoteControlInternetReceivedEnvelope[]=[],phoneInbox:RemoteControlInternetReceivedEnvelope[]=[];
 let loseHostReply=false,losePhoneReply=false;
 const hostTransport:RemoteControlInternetHostTransport={
  async registerHost(input){registration=input;return{expiresAt,hostPublicKeyFingerprint:await fingerprintRemoteControlRelayPublicKey(input.hostPublicKey)}},
  async createPairing(){return{pairingId:crypto.randomUUID(),expiresAt,hostPublicKey:registration.hostPublicKey,hostPublicKeyFingerprint:await fingerprintRemoteControlRelayPublicKey(registration.hostPublicKey),retiredPairingIds:[]}},
  async listSessions(){return session?[{...session}]:[]},
  async approveSession(){session={...session!,approvalState:'approved',approvedAt:new Date().toISOString()};return session},
  async revokeSession(){if(session)session={...session,approvalState:'revoked',revokedAt:new Date().toISOString()}},
  async disableHost(){if(session)session={...session,approvalState:'revoked'}},
  async receiveEnvelopes(_h,_s,after){return hostInbox.filter(e=>BigInt(e.relaySequence)>BigInt(after)&&Date.parse(e.envelope.expiresAt)>now())},
  async sendEnvelope(_h,_s,_c,_t,envelope){if(!phoneInbox.some(e=>e.envelope.messageId===envelope.messageId))phoneInbox.push({relaySequence:String(phoneInbox.length+1),envelope});if(loseHostReply){loseHostReply=false;throw new Error('fixture host reply lost')}},
  async acknowledge(){},
 };
 const hostOptions={gateway,terminalGateway,transport:hostTransport,controllerOrigin:'https://terminal-fixture.example.test',hostName:'AI terminal test Mac',onRecordChanged:()=>{},autoPoll:false,now};
 let host=new RemoteControlInternetAgent(hostOptions);
 const pairing=await host.initialize();
 const phoneTransport:RemoteControlRelayControllerTransport={
  async claimPairing(input){session={sessionId,controllerId,pairingId:input.pairingId,controllerName:input.controllerName,controllerPublicKey:input.controllerPublicKey,controllerKeyFingerprint:await fingerprintRemoteControlRelayPublicKey(input.controllerPublicKey),approvalState:'pending',createdAt:new Date().toISOString(),expiresAt,approvedAt:null,revokedAt:null};return{sessionId,controllerId,hostId:registration.hostId,hostName:'AI terminal test Mac',hostPublicKey:registration.hostPublicKey,hostPublicKeyFingerprint:await fingerprintRemoteControlRelayPublicKey(registration.hostPublicKey),approvalState:'pending',expiresAt}},
  async status(){return{sessionId,controllerId,approvalState:session?.approvalState??'pending',hostEnabled:true,hostExpiresAt:expiresAt,sessionExpiresAt:expiresAt,revokedAt:session?.revokedAt??null,hostLastSeenAt:new Date().toISOString()}},
  async sendEnvelope(_h,_s,envelope){if(Date.parse(envelope.expiresAt)<=now())throw new Error('REMOTE_CONTROL_ENVELOPE_EXPIRY_INVALID');if(!hostInbox.some(e=>e.envelope.messageId===envelope.messageId))hostInbox.push({relaySequence:String(hostInbox.length+1),envelope});if(losePhoneReply){losePhoneReply=false;throw new Error('fixture phone reply lost')}},
  async receiveEnvelopes(_h,_s,after){await host.pollNow();return phoneInbox.filter(e=>BigInt(e.relaySequence)>BigInt(after)&&Date.parse(e.envelope.expiresAt)>now())},
  async acknowledge(){},async revoke(){await host.revokeSession(sessionId)},
 };
 const controller=new RemoteControlRelayController({pairingUrl:pairing.pairingUrl,transport:phoneTransport,controllerName:'Fixture phone',now,sleep:async()=>{await Bun.sleep(5)}});
 return{get host(){return host},controller,phoneTransport,pairing,sessionId,hostInbox,phoneInbox,owner:'internet:'+sessionId,
  async restartHost(){const record=host.record();if(!record)throw Error('Missing restore record');host=new RemoteControlInternetAgent({...hostOptions,restore:record});await host.restore();},
  loseHostReply(){loseHostReply=true},losePhoneReply(){losePhoneReply=true},
  async approve(){await host.pollNow();const sas=host.status().sessions[0]?.sasCode;if(!sas)throw new Error('no SAS');await host.approveSession(sessionId,sas,false,false)},
  async connect(){await controller.initialize();await this.approve();await controller.refresh();},
  restore(snapshot:unknown){return new RemoteControlRelayController({restoredSession:snapshot,transport:phoneTransport,controllerName:'Fixture phone',now,sleep:async()=>{await Bun.sleep(5)}})},
  ciphertexts(){return JSON.stringify({hostInbox,phoneInbox})},
 };
}
