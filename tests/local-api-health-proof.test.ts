import { describe, expect, test } from 'bun:test';
import {
  AGENT_RUNTIME_HEALTH_PROOF_CONTRACT,
  LOCAL_API_HEALTH_PROOF_CONTRACT,
} from '../src/contextApiVersion';
import {
  createAgentRuntimeHealthProof,
  createLocalApiHealthProof,
} from '../src/localApiHealthProof';

const CAPABILITY = 'c'.repeat(64);
const NONCE_A = '11'.repeat(32);
const NONCE_B = '22'.repeat(32);

describe('local API sidecar health proof', () => {
  test('matches the cross-runtime domain-separated HMAC-SHA256 vector', () => {
    expect(LOCAL_API_HEALTH_PROOF_CONTRACT).toMatchObject({
      algorithm: 'hmac-sha256',
      encoding: 'lowercase-hex',
      nonceBytes: 32,
      queryParameter: 'nonce',
      responseField: 'sidecarProof',
    });
    expect(LOCAL_API_HEALTH_PROOF_CONTRACT.domain.endsWith('\0')).toBe(true);
    expect(createLocalApiHealthProof({
      bundled: true,
      capability: CAPABILITY,
      nonce: NONCE_A,
    })).toBe('e5906a92c66f8e34cb3c9d66ef95d58e8aaee69bedf172a30b13cea700bf5d74');
    expect(createLocalApiHealthProof({
      bundled: true,
      capability: CAPABILITY,
      nonce: NONCE_B,
    })).toBe('7a04c2513057a34bbea07a9b82423304d8f61b590c8b06324da9eefb59eea51a');
  });

  test('returns no proof outside a bundled sidecar or for malformed authority input', () => {
    const valid = { bundled: true, capability: CAPABILITY, nonce: NONCE_A };
    expect(createLocalApiHealthProof({ ...valid, bundled: false })).toBeNull();
    expect(createLocalApiHealthProof({ ...valid, capability: null })).toBeNull();
    expect(createLocalApiHealthProof({ ...valid, capability: 'd'.repeat(63) })).toBeNull();
    expect(createLocalApiHealthProof({ ...valid, nonce: null })).toBeNull();
    expect(createLocalApiHealthProof({ ...valid, nonce: '11'.repeat(31) })).toBeNull();
    expect(createLocalApiHealthProof({ ...valid, nonce: 'AA'.repeat(32) })).toBeNull();
  });

  test('uses a distinct Agent Runtime authority field and domain', () => {
    expect(AGENT_RUNTIME_HEALTH_PROOF_CONTRACT).toMatchObject({
      algorithm: 'hmac-sha256',
      encoding: 'lowercase-hex',
      nonceBytes: 32,
      queryParameter: 'nonce',
      responseField: 'agentRuntimeSidecarProof',
    });
    expect(AGENT_RUNTIME_HEALTH_PROOF_CONTRACT.domain.endsWith('\0')).toBe(true);
    expect(AGENT_RUNTIME_HEALTH_PROOF_CONTRACT.domain)
      .not.toBe(LOCAL_API_HEALTH_PROOF_CONTRACT.domain);
    expect(createAgentRuntimeHealthProof({
      bundled: true,
      capability: CAPABILITY,
      nonce: NONCE_A,
    })).toBe('90c857c10fd6cf8a4f2d362f9fc1041e41a2252dc9db5a64eedc73c224351748');
    expect(createAgentRuntimeHealthProof({
      bundled: false,
      capability: CAPABILITY,
      nonce: NONCE_A,
    })).toBeNull();
  });
});
