import {Buffer} from 'node:buffer';
import {hash} from './protocol';
import type {AccessPlan} from './accessProtocol';

/** Separate management consent. Feature plans and the 17-field execution authorization stay unchanged. */
export const ACCESS_MANAGEMENT_DOMAIN=Buffer.from('agentstoz.community-access.management/v1\0');
export interface AccessManagementIntent {
  version:1;communityId:string;targetEnrollmentId:string|null;targetKeyEpoch:number;
  previousAdministrator:boolean;administrator:boolean;issuedAt:number;nonce:string;digest:string;
}
export interface AccessReviewContext {admin:string;planId:string;digest:string;revision:number;challenge:string;expiresAt:number}
export function accessManagementBytes(review:AccessReviewContext,plan:AccessPlan,intent:Omit<AccessManagementIntent,'digest'>):Buffer {
  return Buffer.concat([ACCESS_MANAGEMENT_DOMAIN,Buffer.from(JSON.stringify([intent.version,intent.communityId,review.admin,review.planId,review.digest,
    plan.deviceId,plan.hostKey,plan.biometricKey,plan.operationKey,plan.controlKey,plan.agentDeviceId,review.revision,
    intent.targetEnrollmentId,intent.targetKeyEpoch,intent.previousAdministrator,intent.administrator,review.challenge,intent.issuedAt,review.expiresAt,intent.nonce]))]);
}
export function accessManagementDigest(review:AccessReviewContext,plan:AccessPlan,intent:Omit<AccessManagementIntent,'digest'>):string {
  return hash(accessManagementBytes(review,plan,intent));
}
