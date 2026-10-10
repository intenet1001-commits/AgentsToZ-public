import { createHmac } from 'node:crypto';
import {
  AGENT_RUNTIME_HEALTH_PROOF_CONTRACT,
  LOCAL_API_HEALTH_PROOF_CONTRACT,
} from './contextApiVersion';

const LOWER_HEX_32_BYTES = /^[0-9a-f]{64}$/;

/**
 * Proves that the listener answering the public health route knows the
 * persisted sidecar capability without ever placing that capability on the
 * wire. A fresh 32-byte nonce makes a previously observed proof useless.
 */
interface HealthProofInput {
  bundled: boolean;
  capability: string | null | undefined;
  nonce: string | null | undefined;
}

interface HealthProofContract {
  algorithm: string;
  encoding: string;
  nonceBytes: number;
  domain: string;
}

function createHealthProof(
  input: HealthProofInput,
  contract: HealthProofContract,
): string | null {
  if (!input.bundled
    || !LOWER_HEX_32_BYTES.test(input.capability ?? '')
    || !LOWER_HEX_32_BYTES.test(input.nonce ?? '')
    || contract.algorithm !== 'hmac-sha256'
    || contract.encoding !== 'lowercase-hex'
    || contract.nonceBytes !== 32
    || !contract.domain.endsWith('\0')) {
    return null;
  }
  return createHmac('sha256', Buffer.from(input.capability!, 'hex'))
    .update(contract.domain, 'utf8')
    .update(Buffer.from(input.nonce!, 'hex'))
    .digest('hex');
}

export function createLocalApiHealthProof(input: HealthProofInput): string | null {
  return createHealthProof(input, LOCAL_API_HEALTH_PROOF_CONTRACT);
}

/** Independent proof for the Agent Runtime proxy authority. */
export function createAgentRuntimeHealthProof(input: HealthProofInput): string | null {
  return createHealthProof(input, AGENT_RUNTIME_HEALTH_PROOF_CONTRACT);
}
