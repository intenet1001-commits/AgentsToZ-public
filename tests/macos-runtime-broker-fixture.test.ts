import { describe, expect, test } from 'bun:test';
import {
  normalizeMacOSRuntimeBrokerFixtureProof,
  parseMacOSRuntimeBrokerFixtureProofLine,
} from '../src/macOSRuntimeBrokerFixture';

const validProof = Object.freeze({
  schemaVersion: 1,
  kind: 'macos-runtime-broker-harmless-fixture',
  mode: 'development-same-uid',
  result: 'passed',
  protocol: 'bounded-stdio-challenge-v1',
  workerIdentity: 'same-effective-user-and-group-only',
  serviceRegistered: false,
  accountCreated: false,
  containerInvoked: false,
  authoritative: false,
  reusable: false,
  ready: false,
});

describe('macOS runtime broker harmless fixture proof', () => {
  test('accepts only the exact non-authoritative, non-reusable, not-ready proof', () => {
    expect(normalizeMacOSRuntimeBrokerFixtureProof(validProof)).toEqual(validProof);
    const canonical = JSON.stringify(validProof, Object.keys(validProof).sort());
    expect(parseMacOSRuntimeBrokerFixtureProofLine(`${canonical}\n`))
      .toEqual(validProof);
  });

  test('rejects any attempt to promote the fixture to runtime readiness', () => {
    for (const mutation of [
      { ready: true },
      { authoritative: true },
      { reusable: true },
      { serviceRegistered: true },
      { accountCreated: true },
      { containerInvoked: true },
      { mode: 'production' },
      { result: 'ready' },
    ]) {
      expect(() => normalizeMacOSRuntimeBrokerFixtureProof({
        ...validProof,
        ...mutation,
      })).toThrow('fixture proof rejected');
    }
  });

  test('rejects missing, extra, multiline and oversized output', () => {
    const { ready: _ready, ...missing } = validProof;
    expect(() => normalizeMacOSRuntimeBrokerFixtureProof(missing))
      .toThrow('fixture proof rejected');
    expect(() => normalizeMacOSRuntimeBrokerFixtureProof({
      ...validProof,
      extra: 'rejected',
    })).toThrow('fixture proof rejected');
    expect(() => parseMacOSRuntimeBrokerFixtureProofLine(
      `${JSON.stringify(validProof)}\n${JSON.stringify(validProof)}\n`,
    )).toThrow('fixture output rejected');
    expect(() => parseMacOSRuntimeBrokerFixtureProofLine(
      `${JSON.stringify(validProof)}\n`,
    )).toThrow('fixture output rejected');
    const duplicateKey = '{"accountCreated":false,"accountCreated":false,'
      + '"authoritative":false,"containerInvoked":false,'
      + '"kind":"macos-runtime-broker-harmless-fixture",'
      + '"mode":"development-same-uid","protocol":"bounded-stdio-challenge-v1",'
      + '"ready":false,"result":"passed","reusable":false,"schemaVersion":1,'
      + '"serviceRegistered":false,'
      + '"workerIdentity":"same-effective-user-and-group-only"}\n';
    expect(() => parseMacOSRuntimeBrokerFixtureProofLine(duplicateKey))
      .toThrow('fixture output rejected');
    expect(() => parseMacOSRuntimeBrokerFixtureProofLine('x'.repeat(4_097)))
      .toThrow('fixture output rejected');
  });
});
