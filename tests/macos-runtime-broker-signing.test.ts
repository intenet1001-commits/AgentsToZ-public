import { describe, expect, test } from 'bun:test';

import {
  MACOS_RUNTIME_BROKER_APP_BUNDLE_PATH,
  MACOS_RUNTIME_BROKER_APP_EXECUTABLE_PATH,
  MACOS_RUNTIME_BROKER_APP_IDENTIFIER,
  MACOS_RUNTIME_BROKER_CLIENT_ENTITLEMENT,
  MACOS_RUNTIME_BROKER_CODESIGN_MAX_OUTPUT_BYTES,
  MACOS_RUNTIME_BROKER_CODESIGN_TIMEOUT_MS,
  MACOS_RUNTIME_BROKER_DEVELOPER_ID_APPLICATION_OID,
  MACOS_RUNTIME_BROKER_DEVELOPER_ID_ISSUER_OID,
  MACOS_RUNTIME_BROKER_EXECUTABLE_PATH,
  MACOS_RUNTIME_BROKER_IDENTIFIER,
  MACOS_RUNTIME_BROKER_SERVICE_ENTITLEMENT,
  MACOS_RUNTIME_BROKER_CLIENT_ENTITLEMENT_VALUE,
  MACOS_RUNTIME_BROKER_SERVICE_ENTITLEMENT_VALUE,
  verifyMacOSRuntimeBrokerSigningPreflightForTest,
  type MacOSRuntimeBrokerCodesignResult,
  type MacOSRuntimeBrokerSigningDependencies,
  type MacOSRuntimeBrokerSigningFileStat,
} from '../src/macOSRuntimeBrokerSigning';

const TEAM_ID = 'A1B2C3D4E5';

interface SignatureFixture {
  mode: 'production' | 'ad-hoc';
  identifier: string;
  teamIdentifier: string;
  runtime: boolean;
  timestamp: boolean;
  authorities: readonly string[];
  entitlements: Readonly<Record<string, string>>;
  executable: string;
  format: string;
  cdHash: string;
}

interface CodesignCall {
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly env: Readonly<Record<string, string>>;
}

function stat(kind: 'file' | 'directory' | 'symlink'): MacOSRuntimeBrokerSigningFileStat {
  return {
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'directory',
    isSymbolicLink: () => kind === 'symlink',
    mode: kind === 'file' ? 0o100755 : 0o040755,
    size: kind === 'file' ? 20_000 : 512,
    dev: 17,
    ino: kind === 'file' ? 101 : 100,
    uid: 501,
    gid: 20,
    nlink: 1,
    ctimeMs: 1_788_474_000_000,
  };
}

function success(stdout = '', stderr = ''): MacOSRuntimeBrokerCodesignResult {
  return {
    exitCode: 0,
    stdout,
    stderr,
    timedOut: false,
    outputTruncated: false,
  };
}

function failure(overrides: Partial<MacOSRuntimeBrokerCodesignResult> = {}) {
  return {
    exitCode: 1,
    stdout: '',
    stderr: 'private diagnostic that must not escape',
    timedOut: false,
    outputTruncated: false,
    ...overrides,
  };
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function entitlementXml(
  entries: Readonly<Record<string, string>>,
): string {
  const body = Object.entries(entries).map(([key, value]) => {
    const encoded = xmlEscape(key);
    if (value === 'true' || value === 'false') {
      return `  <key>${encoded}</key>\n  <${value}/>`;
    }
    return `  <key>${encoded}</key>\n  <string>${xmlEscape(value)}</string>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}
</dict>
</plist>`;
}

function details(fixture: SignatureFixture): string {
  const flags = fixture.mode === 'ad-hoc'
    ? '0x2(adhoc)'
    : fixture.runtime ? '0x10000(runtime)' : '0x0(none)';
  return [
    `Executable=${fixture.executable}`,
    `Identifier=${fixture.identifier}`,
    `Format=${fixture.format}`,
    `CodeDirectory v=20500 size=123 flags=${flags} hashes=1+7 location=embedded`,
    'Hash type=sha256 size=32',
    `CandidateCDHashFull sha256=${fixture.cdHash}`,
    fixture.mode === 'ad-hoc' ? 'Signature=adhoc' : 'Signature size=9123',
    ...fixture.authorities.map(authority => `Authority=${authority}`),
    ...(fixture.timestamp ? ['Timestamp=Sep 4, 2026 at 12:00:00'] : []),
    `TeamIdentifier=${fixture.teamIdentifier}`,
    entitlementXml(fixture.entitlements),
  ].join('\n');
}

function productionApp(): SignatureFixture {
  return {
    mode: 'production',
    identifier: MACOS_RUNTIME_BROKER_APP_IDENTIFIER,
    teamIdentifier: TEAM_ID,
    runtime: true,
    timestamp: true,
    authorities: [
      `Developer ID Application: AgentsToZ Test (${TEAM_ID})`,
      'Developer ID Certification Authority',
      'Apple Root CA',
    ],
    entitlements: {
      [MACOS_RUNTIME_BROKER_CLIENT_ENTITLEMENT]:
        MACOS_RUNTIME_BROKER_CLIENT_ENTITLEMENT_VALUE,
    },
    executable: MACOS_RUNTIME_BROKER_APP_EXECUTABLE_PATH,
    format: 'app bundle with Mach-O thin (arm64)',
    cdHash: 'a'.repeat(64),
  };
}

function productionBroker(): SignatureFixture {
  return {
    mode: 'production',
    identifier: MACOS_RUNTIME_BROKER_IDENTIFIER,
    teamIdentifier: TEAM_ID,
    runtime: true,
    timestamp: true,
    authorities: [
      `Developer ID Application: AgentsToZ Test (${TEAM_ID})`,
      'Developer ID Certification Authority',
      'Apple Root CA',
    ],
    entitlements: {
      [MACOS_RUNTIME_BROKER_SERVICE_ENTITLEMENT]:
        MACOS_RUNTIME_BROKER_SERVICE_ENTITLEMENT_VALUE,
    },
    executable: MACOS_RUNTIME_BROKER_EXECUTABLE_PATH,
    format: 'Mach-O thin (arm64)',
    cdHash: 'b'.repeat(64),
  };
}

function adHoc(fixture: SignatureFixture): SignatureFixture {
  return {
    ...fixture,
    mode: 'ad-hoc',
    teamIdentifier: 'not set',
    runtime: false,
    timestamp: false,
    authorities: [],
  };
}

class FakeSigningHost implements MacOSRuntimeBrokerSigningDependencies {
  readonly calls: CodesignCall[] = [];
  readonly paths = new Map<string, MacOSRuntimeBrokerSigningFileStat>([
    [MACOS_RUNTIME_BROKER_APP_BUNDLE_PATH, stat('directory')],
    [MACOS_RUNTIME_BROKER_APP_EXECUTABLE_PATH, stat('file')],
    [MACOS_RUNTIME_BROKER_EXECUTABLE_PATH, stat('file')],
  ]);
  readonly canonical = new Map<string, string>([
    [MACOS_RUNTIME_BROKER_APP_BUNDLE_PATH, MACOS_RUNTIME_BROKER_APP_BUNDLE_PATH],
    [MACOS_RUNTIME_BROKER_APP_EXECUTABLE_PATH, MACOS_RUNTIME_BROKER_APP_EXECUTABLE_PATH],
    [MACOS_RUNTIME_BROKER_EXECUTABLE_PATH, MACOS_RUNTIME_BROKER_EXECUTABLE_PATH],
  ]);
  app = productionApp();
  broker = productionBroker();
  failVerifyFor: string | null = null;
  failRequirementFor: string | null = null;
  nextResult: MacOSRuntimeBrokerCodesignResult | null = null;
  readonly displayOverrides = new Map<string, string>();

  async lstat(path: string): Promise<MacOSRuntimeBrokerSigningFileStat> {
    const value = this.paths.get(path);
    if (value === undefined) throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' });
    return value;
  }

  async realpath(path: string): Promise<string> {
    const value = this.canonical.get(path);
    if (value === undefined) throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' });
    return value;
  }

  async runCodesign(
    args: readonly string[],
    options: {
      readonly timeoutMs: number;
      readonly maxOutputBytes: number;
      readonly env: Readonly<Record<string, string>>;
    },
  ): Promise<MacOSRuntimeBrokerCodesignResult> {
    this.calls.push({ args: [...args], ...options });
    if (this.nextResult !== null) {
      const result = this.nextResult;
      this.nextResult = null;
      return result;
    }
    const path = args.at(-1)!;
    const requirement = args.includes('-R');
    if ((!requirement && path === this.failVerifyFor)
      || (requirement && path === this.failRequirementFor)) {
      return failure();
    }
    if (args.includes('--display')) {
      const fixture = path === MACOS_RUNTIME_BROKER_APP_EXECUTABLE_PATH
        ? this.app
        : this.broker;
      return success('', this.displayOverrides.get(path) ?? details(fixture));
    }
    return success('', 'valid on disk\nsatisfies its Designated Requirement');
  }
}

async function verify(host: FakeSigningHost, teamIdentifier: string | undefined = TEAM_ID) {
  return verifyMacOSRuntimeBrokerSigningPreflightForTest(
    {
      platform: 'darwin',
      testOnlyPinnedProductionTeamIdentifier: teamIdentifier,
    },
    host,
  );
}

describe('macOS runtime broker signing/channel preflight', () => {
  test('verifies exact production identities while remaining unable to unlock containment', async () => {
    const host = new FakeSigningHost();
    const result = await verify(host);

    expect(result).toEqual({
      schemaVersion: 2,
      kind: 'macos-runtime-broker-signing',
      scope: 'static-signature-snapshot-only',
      mode: 'production',
      result: 'snapshot-verified',
      reason: 'static-signature-snapshot-verified',
      authoritative: false,
      reusable: false,
      ready: false,
    });
    expect(Object.keys(result).sort()).toEqual([
      'authoritative', 'kind', 'mode', 'ready', 'reason', 'result', 'reusable',
      'schemaVersion', 'scope',
    ]);
    expect(JSON.stringify(result)).not.toContain(TEAM_ID);
    expect(JSON.stringify(result)).not.toContain('/Applications');

    const requirements = host.calls.filter(call => call.args.includes('-R'));
    expect(requirements).toHaveLength(2);
    expect(requirements.map(call => call.args.at(-1)).sort()).toEqual([
      MACOS_RUNTIME_BROKER_APP_EXECUTABLE_PATH,
      MACOS_RUNTIME_BROKER_EXECUTABLE_PATH,
    ].sort());
    for (const call of requirements) {
      const requirement = call.args[call.args.indexOf('-R') + 1]!;
      expect(requirement).toContain(`field.${MACOS_RUNTIME_BROKER_DEVELOPER_ID_APPLICATION_OID}`);
      expect(requirement).toContain(`certificate 1[field.${MACOS_RUNTIME_BROKER_DEVELOPER_ID_ISSUER_OID}] exists`);
      expect(requirement).toContain(`subject.OU] = "${TEAM_ID}"`);
      expect(requirement).toContain('anchor apple generic');
      expect(requirement).toContain(`identifier "${call.args.at(-1) === MACOS_RUNTIME_BROKER_APP_EXECUTABLE_PATH
        ? MACOS_RUNTIME_BROKER_APP_IDENTIFIER
        : MACOS_RUNTIME_BROKER_IDENTIFIER}"`);
    }
    for (const call of host.calls) {
      expect(call.timeoutMs).toBe(MACOS_RUNTIME_BROKER_CODESIGN_TIMEOUT_MS);
      expect(call.maxOutputBytes).toBe(MACOS_RUNTIME_BROKER_CODESIGN_MAX_OUTPUT_BYTES);
      expect(call.env).toEqual({ PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' });
      expect(call.args.at(-1)).toBeOneOf([
        MACOS_RUNTIME_BROKER_APP_BUNDLE_PATH,
        MACOS_RUNTIME_BROKER_APP_EXECUTABLE_PATH,
        MACOS_RUNTIME_BROKER_EXECUTABLE_PATH,
      ]);
    }
    const bundleVerification = host.calls.find(call =>
      call.args.at(-1) === MACOS_RUNTIME_BROKER_APP_BUNDLE_PATH);
    expect(bundleVerification?.args).toContain('--deep');
    expect(bundleVerification?.args).toContain('--all-architectures');
    for (const call of host.calls.filter(call => call.args.includes('--verify'))) {
      expect(call.args).toContain('--all-architectures');
    }
  });

  test('distinguishes valid ad-hoc development signing and never calls it production', async () => {
    const host = new FakeSigningHost();
    host.app = adHoc(host.app);
    host.broker = adHoc(host.broker);

    expect(await verify(host)).toEqual({
      schemaVersion: 2,
      kind: 'macos-runtime-broker-signing',
      scope: 'static-signature-snapshot-only',
      mode: 'development-ad-hoc',
      result: 'development-only',
      reason: 'development-ad-hoc-signing',
      authoritative: false,
      reusable: false,
      ready: false,
    });
    expect(host.calls.some(call => call.args.includes('-R'))).toBe(false);
  });

  test('returns a stable unsupported proof without touching the host off macOS', async () => {
    const host = new FakeSigningHost();
    const result = await verifyMacOSRuntimeBrokerSigningPreflightForTest(
      { platform: 'linux', testOnlyPinnedProductionTeamIdentifier: TEAM_ID },
      host,
    );
    expect(result.mode).toBe('unavailable');
    expect(result.reason).toBe('platform-unsupported');
    expect(result.ready).toBe(false);
    expect(host.calls).toHaveLength(0);
  });

  test('fails closed when the bundle-contained broker helper is absent', async () => {
    const host = new FakeSigningHost();
    host.paths.delete(MACOS_RUNTIME_BROKER_EXECUTABLE_PATH);
    expect((await verify(host)).reason).toBe('broker-helper-missing');
    expect(host.calls).toHaveLength(0);
  });

  test('fails closed when the main executable is absent', async () => {
    const host = new FakeSigningHost();
    host.paths.delete(MACOS_RUNTIME_BROKER_APP_EXECUTABLE_PATH);
    expect((await verify(host)).reason).toBe('app-executable-missing');
    expect(host.calls).toHaveLength(0);
  });

  test('rejects symlinks and canonical-path substitution before codesign', async () => {
    const symlinkHost = new FakeSigningHost();
    symlinkHost.paths.set(MACOS_RUNTIME_BROKER_EXECUTABLE_PATH, stat('symlink'));
    expect((await verify(symlinkHost)).reason).toBe('bundle-path-unverified');
    expect(symlinkHost.calls).toHaveLength(0);

    const redirectedHost = new FakeSigningHost();
    redirectedHost.canonical.set(
      MACOS_RUNTIME_BROKER_EXECUTABLE_PATH,
      '/tmp/attacker/runtime-broker',
    );
    expect((await verify(redirectedHost)).reason).toBe('bundle-path-unverified');
    expect(redirectedHost.calls).toHaveLength(0);
  });

  test('rejects unsigned or invalid signatures without reflecting diagnostics', async () => {
    const host = new FakeSigningHost();
    host.failVerifyFor = MACOS_RUNTIME_BROKER_EXECUTABLE_PATH;
    const result = await verify(host);
    expect(result.reason).toBe('signature-unverified');
    expect(result.ready).toBe(false);
    expect(JSON.stringify(result)).not.toContain('private diagnostic');
  });

  test('rejects truncated, timed-out and aggregate oversized codesign output', async () => {
    for (const commandResult of [
      failure({ timedOut: true }),
      failure({ outputTruncated: true }),
      success('x'.repeat(MACOS_RUNTIME_BROKER_CODESIGN_MAX_OUTPUT_BYTES + 1)),
    ]) {
      const host = new FakeSigningHost();
      host.nextResult = commandResult;
      const result = await verify(host);
      expect(result.reason).toBe('signature-unverified');
      expect(result.ready).toBe(false);
    }
  });

  test('rejects different app and broker signing modes', async () => {
    const host = new FakeSigningHost();
    host.broker = adHoc(host.broker);
    expect((await verify(host)).reason).toBe('signing-mode-mismatch');
  });

  test('requires exact app and broker signing identifiers and executable paths', async () => {
    const wrongAppIdentifier = new FakeSigningHost();
    wrongAppIdentifier.app = { ...wrongAppIdentifier.app, identifier: 'com.example.lookalike' };
    expect((await verify(wrongAppIdentifier)).reason).toBe('signature-unverified');

    const wrongBrokerPath = new FakeSigningHost();
    wrongBrokerPath.broker = { ...wrongBrokerPath.broker, executable: '/tmp/runtime-broker' };
    expect((await verify(wrongBrokerPath)).reason).toBe('signature-unverified');
  });

  test('requires a build-pinned, non-placeholder production Team ID', async () => {
    const absentHost = new FakeSigningHost();
    const absent = await verifyMacOSRuntimeBrokerSigningPreflightForTest(
      { platform: 'darwin' },
      absentHost,
    );
    expect(absent.reason).toBe('production-team-unconfigured');

    for (const candidate of ['XXXXXXXXXX', 'TEAMID1234', '1234567890', 'SHORT']) {
      const host = new FakeSigningHost();
      const result = await verify(host, candidate);
      expect(result.reason).toBe('production-team-unconfigured');
      expect(result.ready).toBe(false);
      expect(host.calls.some(call => call.args.includes('-R'))).toBe(false);
    }
  });

  test('requires both production peers to have the same pinned Team ID', async () => {
    const host = new FakeSigningHost();
    host.broker = { ...host.broker, teamIdentifier: 'F6E7D8C9B0' };
    expect((await verify(host)).reason).toBe('production-team-unverified');
  });

  test('requires the exact Developer ID Application authority chain', async () => {
    const wrongLeaf = new FakeSigningHost();
    wrongLeaf.broker = {
      ...wrongLeaf.broker,
      authorities: [
        `Apple Development: AgentsToZ Test (${TEAM_ID})`,
        'Apple Worldwide Developer Relations Certification Authority',
        'Apple Root CA',
      ],
    };
    expect((await verify(wrongLeaf)).reason).toBe('developer-id-unverified');

    const missingRoot = new FakeSigningHost();
    missingRoot.broker = {
      ...missingRoot.broker,
      authorities: missingRoot.broker.authorities.slice(0, 2),
    };
    expect((await verify(missingRoot)).reason).toBe('developer-id-unverified');
  });

  test('requires the codesign OID/designated requirement to validate for both peers', async () => {
    const host = new FakeSigningHost();
    host.failRequirementFor = MACOS_RUNTIME_BROKER_EXECUTABLE_PATH;
    const result = await verify(host);
    expect(result.reason).toBe('developer-id-unverified');
    expect(result.ready).toBe(false);
  });

  test('requires hardened runtime on the app and broker', async () => {
    const host = new FakeSigningHost();
    host.broker = { ...host.broker, runtime: false };
    expect((await verify(host)).reason).toBe('hardened-runtime-required');
  });

  test('requires a secure timestamp on the app and broker', async () => {
    const host = new FakeSigningHost();
    host.app = { ...host.app, timestamp: false };
    expect((await verify(host)).reason).toBe('secure-timestamp-required');
  });

  test('requires the exact role entitlement on each channel peer', async () => {
    const missingClient = new FakeSigningHost();
    missingClient.app = { ...missingClient.app, entitlements: {} };
    expect((await verify(missingClient)).reason).toBe('channel-entitlement-unverified');

    const falseService = new FakeSigningHost();
    falseService.broker = {
      ...falseService.broker,
      entitlements: { [MACOS_RUNTIME_BROKER_SERVICE_ENTITLEMENT]: 'false' },
    };
    expect((await verify(falseService)).reason).toBe('channel-entitlement-unverified');

    const crossedRoles = new FakeSigningHost();
    crossedRoles.app = {
      ...crossedRoles.app,
      entitlements: {
        [MACOS_RUNTIME_BROKER_CLIENT_ENTITLEMENT]:
          MACOS_RUNTIME_BROKER_CLIENT_ENTITLEMENT_VALUE,
        [MACOS_RUNTIME_BROKER_SERVICE_ENTITLEMENT]:
          MACOS_RUNTIME_BROKER_SERVICE_ENTITLEMENT_VALUE,
      },
    };
    expect((await verify(crossedRoles)).reason).toBe('channel-entitlement-unverified');

    const dangerousExtra = new FakeSigningHost();
    dangerousExtra.broker = {
      ...dangerousExtra.broker,
      entitlements: {
        ...dangerousExtra.broker.entitlements,
        'com.apple.security.cs.disable-library-validation': 'true',
      },
    };
    expect((await verify(dangerousExtra)).reason)
      .toBe('channel-entitlement-unverified');
  });

  test('does not accept an entitlement name hidden inside a string value', async () => {
    const host = new FakeSigningHost();
    host.app = {
      ...host.app,
      entitlements: {
        'com.intenet.decoy': MACOS_RUNTIME_BROKER_CLIENT_ENTITLEMENT,
      },
    };
    expect((await verify(host)).reason).toBe('channel-entitlement-unverified');
  });

  test('rejects malformed nested entitlement values', async () => {
    const host = new FakeSigningHost();
    host.displayOverrides.set(
      MACOS_RUNTIME_BROKER_APP_EXECUTABLE_PATH,
      details(host.app).replace(
        `<string>${MACOS_RUNTIME_BROKER_CLIENT_ENTITLEMENT_VALUE}</string>`,
        `<string>${MACOS_RUNTIME_BROKER_CLIENT_ENTITLEMENT_VALUE}<true/></string>`,
      ),
    );
    expect((await verify(host)).reason).toBe('channel-entitlement-unverified');
  });

  test('rejects universal or non-arm64 signature display snapshots', async () => {
    const universal = new FakeSigningHost();
    universal.app = {
      ...universal.app,
      format: 'app bundle with Mach-O universal (x86_64 arm64)',
    };
    expect((await verify(universal)).reason).toBe('signature-unverified');

    const x64Broker = new FakeSigningHost();
    x64Broker.broker = { ...x64Broker.broker, format: 'Mach-O thin (x86_64)' };
    expect((await verify(x64Broker)).reason).toBe('signature-unverified');
  });

  test('rejects hard-linked helpers and path fingerprint drift', async () => {
    const hardLinked = new FakeSigningHost();
    hardLinked.paths.set(MACOS_RUNTIME_BROKER_EXECUTABLE_PATH, {
      ...stat('file'),
      nlink: 2,
    });
    expect((await verify(hardLinked)).reason).toBe('bundle-path-unverified');
    expect(hardLinked.calls).toHaveLength(0);

    const drifted = new FakeSigningHost();
    const baseLstat = drifted.lstat.bind(drifted);
    let brokerReads = 0;
    drifted.lstat = async (path: string) => {
      const value = await baseLstat(path);
      if (path === MACOS_RUNTIME_BROKER_EXECUTABLE_PATH && ++brokerReads > 1) {
        return { ...value, ino: 999 };
      }
      return value;
    };
    expect((await verify(drifted)).reason).toBe('bundle-path-unverified');
  });
});
