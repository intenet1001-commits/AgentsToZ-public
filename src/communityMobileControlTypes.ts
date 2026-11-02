import type {CommunityAccessEnvelope,CommunityMobileRelayPurpose,CommunityRelayTicket} from './communityAccessClient';
import type {CommunityDeviceAuthorization,CommunityMobileAuthority,CommunityMobileUseSession} from './communityMobilePrincipal';
import type {MobileControlTranscript} from './communityMobileControlProtocol';

export interface CommunityMobileHostIdentity {
  context():Promise<{authority:Readonly<CommunityMobileAuthority>;communityId:string;profileId:string;enrollmentId:string;deviceId:string;controlKey:string;agentDeviceId:string|null;revision:number;capabilities:readonly string[]}>;
  authorization(purpose:CommunityMobileRelayPurpose):Promise<CommunityDeviceAuthorization>;
  directory(purpose:CommunityMobileRelayPurpose):Promise<CommunityDeviceAuthorization[]>;
  currentUse(purpose:CommunityMobileRelayPurpose,mobile:CommunityDeviceAuthorization,sessionId:string):Promise<CommunityMobileUseSession>;
  ticket(purpose:CommunityMobileRelayPurpose,connectionId:string):Promise<CommunityRelayTicket>;
  signRelayProof(purpose:CommunityMobileRelayPurpose,ticket:CommunityRelayTicket,challenge:string):Promise<Uint8Array>;
  signHandshake(purpose:CommunityMobileRelayPurpose,transcript:MobileControlTranscript,own:CommunityDeviceAuthorization,mobile:CommunityDeviceAuthorization,use:CommunityMobileUseSession):Promise<string>;
}
export interface CommunityMobilePrincipal {
  readonly receiver:CommunityDeviceAuthorization;
  readonly mobile:CommunityDeviceAuthorization;
  readonly use:CommunityMobileUseSession;
}
export interface CommunityMobileEffectGuard {
  readonly operationId:string|null;
  readonly createdAt:number|null;
  /** Fast local check; every actual effect also requires the asynchronous fresh authority check. */
  active():boolean;
  beforeEffect():Promise<void>;
}
export interface CommunityMobilePreparedCommand {
  /** Private, bounded scope binding kept only in the encrypted host receipt ledger. */
  readonly scope:string;
  run(guard:CommunityMobileEffectGuard):Promise<unknown>;
}
export interface CommunityMobileCommandDescriptor {op:string;mode:'query'|'effect';label:string}
export interface CommunityMobileConsumers {
  capabilities(purpose:CommunityMobileRelayPurpose):readonly CommunityMobileCommandDescriptor[];
  /** Strict parsing and scope resolution only; never starts an AI, writes input or moves a browser. */
  prepare(principal:CommunityMobilePrincipal,purpose:CommunityMobileRelayPurpose,mode:'query'|'effect',command:Readonly<Record<string,unknown>>):Promise<CommunityMobilePreparedCommand>;
  authorizeReceipt(principal:CommunityMobilePrincipal,purpose:CommunityMobileRelayPurpose,scope:string):Promise<boolean>;
  /** Original backend receipt only. A missing/unknown result never authorizes run() again. */
  readReceipt?(principal:CommunityMobilePrincipal,purpose:CommunityMobileRelayPurpose,scope:string,operationId:string,createdAt:number):Promise<{state:'result';result:unknown}|{state:'pending'|'unknown'}>;
}

// Keep the envelope DTO available without any private signing material in consumer contracts.
export type CommunityMobilePublicEnvelope=CommunityAccessEnvelope;
