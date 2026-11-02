/**
 * Per-run certificate authority for the emulator harness (harness-design §2.4 / WP2).
 *
 * The https door of the Supabase shim must look like production to the phone: the iOS app's
 * bundled portal only accepts an https origin without a port, and the Mac only puts the
 * `supabase` field in a remote-control QR for an https project (src/remoteControlPairingSupabase.ts).
 * So every run mints its own throwaway CA and one localhost server certificate with /usr/bin/openssl:
 *
 *   - Everything lives in the run's scratch directory (0700, files 0600). Nothing touches the Mac
 *     keychain; trust is granted per process (NODE_EXTRA_CA_CERTS) or per OWNED simulator
 *     (`simctl keychain <udid> add-root-cert`, WP6), never system-wide.
 *   - The CA private key is deleted as soon as the server certificate is signed. Once the run is
 *     over nobody can issue another certificate under a root a simulator may still trust.
 *   - The CA carries critical DNS name constraints for exactly the names it signed (localhost by
 *     default), so even a leaked key could not vouch for a real domain. (No IP constraints: Bun's
 *     verifier rejects them outright — see the measurement note below.)
 *   - Only loopback addresses and reserved names (localhost, *.localhost, *.test) are accepted.
 *
 * openssl runs from an environment built from empty (PATH only) with an explicit -config, so
 * neither the agent's environment nor a global openssl.cnf changes what is minted.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export const FIXTURE_CA_DEFAULT_DNS_NAMES = ['localhost'] as const;
export const FIXTURE_CA_DEFAULT_IP_ADDRESSES = ['127.0.0.1', '::1'] as const;
const OPENSSL = '/usr/bin/openssl';
const MAX_VALIDITY_DAYS = 30;

export interface FixtureCaOptions {
  /** Absolute scratch directory for this run's CA. Created 0700 when missing; must not hold an earlier CA. */
  dir: string;
  /** Shown in the CA subject (e.g. the run id) so an owned simulator's trust store shows which run added it. */
  label?: string;
  /** Default 2. At most 30: the CA only has to outlive one run. */
  validityDays?: number;
  dnsNames?: readonly string[];
  ipAddresses?: readonly string[];
  /** Default true. Critical X.509 name constraints limiting the CA to the names it signed. */
  nameConstraints?: boolean;
  /** Default /usr/bin/openssl (LibreSSL on macOS). */
  opensslPath?: string;
}

export interface FixtureCa {
  dir: string;
  caCertPath: string;
  serverCertPath: string;
  serverKeyPath: string;
  caCertPem: string;
  serverCertPem: string;
  serverKeyPem: string;
  /** SHA-256 over the CA certificate's DER, lower-case hex. Safe to log. */
  caFingerprintSha256: string;
  dnsNames: string[];
  ipAddresses: string[];
  validityDays: number;
  nameConstraints: boolean;
  /** Always true on return: the CA private key no longer exists on disk. */
  caKeyDestroyed: true;
}

function assertReservedDnsName(name: string): string {
  const value = name.trim().toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(value)) {
    throw new Error(`fixture CA: invalid DNS name ${JSON.stringify(name)}`);
  }
  // Only names that can never be a real Internet host (RFC 6761 localhost, RFC 2606 .test).
  if (value !== 'localhost' && !value.endsWith('.localhost') && !value.endsWith('.test')) {
    throw new Error(`fixture CA: refusing a certificate for a non-reserved name ${JSON.stringify(name)}`);
  }
  return value;
}

/** Loopback only, written in the long form LibreSSL's config parser accepts. */
function loopbackIp(address: string): { san: string } {
  const value = address.trim().toLowerCase();
  if (/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(value) && value.split('.').every(part => Number(part) <= 255)) {
    return { san: value };
  }
  if (value === '::1' || value === '0:0:0:0:0:0:0:1') return { san: '0:0:0:0:0:0:0:1' };
  throw new Error(`fixture CA: refusing a certificate for a non-loopback address ${JSON.stringify(address)}`);
}

function cleanLabel(label: string | undefined): string {
  const value = (label ?? '').replace(/[^A-Za-z0-9 ._-]/g, '').trim().slice(0, 40);
  return value ? `AgentsToZ emulator fixture CA ${value}` : 'AgentsToZ emulator fixture CA';
}

function openssl(binary: string, cwd: string, args: string[]): string {
  const result = Bun.spawnSync([binary, ...args], {
    cwd,
    // Built from empty: no OPENSSL_CONF, RANDFILE or HOME of the calling agent can leak in.
    env: { PATH: '/usr/bin:/bin' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr).trim().slice(0, 600);
    throw new Error(`fixture CA: openssl ${args[0]} failed (${result.exitCode}): ${stderr}`);
  }
  return new TextDecoder().decode(result.stdout);
}

function pemDer(pem: string): Uint8Array {
  const body = pem.match(/-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/);
  if (!body?.[1]) throw new Error('fixture CA: certificate PEM not found');
  return Uint8Array.from(Buffer.from(body[1].replace(/\s+/g, ''), 'base64'));
}

/**
 * Mint a fresh CA and a server certificate for loopback names. The returned paths stay valid until
 * {@link removeFixtureCa} or until the scratch directory is removed.
 */
export function createFixtureCa(options: FixtureCaOptions): FixtureCa {
  if (!isAbsolute(options.dir)) throw new Error('fixture CA: dir must be absolute');
  const binary = options.opensslPath ?? OPENSSL;
  const validityDays = options.validityDays ?? 2;
  if (!Number.isInteger(validityDays) || validityDays < 1 || validityDays > MAX_VALIDITY_DAYS) {
    throw new Error(`fixture CA: validityDays must be 1..${MAX_VALIDITY_DAYS}`);
  }
  const dnsNames = [...new Set((options.dnsNames ?? FIXTURE_CA_DEFAULT_DNS_NAMES).map(assertReservedDnsName))];
  const ips = (options.ipAddresses ?? FIXTURE_CA_DEFAULT_IP_ADDRESSES).map(loopbackIp);
  if (!dnsNames.length && !ips.length) throw new Error('fixture CA: at least one name is required');
  const nameConstraints = options.nameConstraints ?? true;

  mkdirSync(options.dir, { recursive: true, mode: 0o700 });
  chmodSync(options.dir, 0o700);
  const caCertPath = join(options.dir, 'fixture-ca.crt');
  const serverCertPath = join(options.dir, 'fixture-server.crt');
  const serverKeyPath = join(options.dir, 'fixture-server.key');
  const caKeyPath = join(options.dir, 'fixture-ca.key');
  const csrPath = join(options.dir, 'fixture-server.csr');
  const configPath = join(options.dir, 'fixture-ca.cnf');
  for (const path of [caCertPath, serverCertPath, serverKeyPath, caKeyPath]) {
    // One CA per directory: silently replacing a root an owned simulator already trusts would make
    // the evidence (fingerprint) lie about which root that simulator holds.
    if (existsSync(path)) throw new Error(`fixture CA: ${path} already exists`);
  }

  // DNS constraints only. Measured 2026-11-01 (Bun 1.4.2): any iPAddress name constraint makes
  // Bun's TLS verifier fail every handshake with UNSUPPORTED_CONSTRAINT_TYPE, even for a DNS SAN.
  // IP SANs are therefore unconstrained; the destroyed CA key is what keeps them from being reused.
  const constraints = dnsNames.map(name => `permitted;DNS:${name}`).join(', ');
  const san = [...dnsNames.map(name => `DNS:${name}`), ...ips.map(ip => `IP:${ip.san}`)].join(', ');
  writeFileSync(configPath, [
    // No `prompt = no` / [dn] values: LibreSSL then ignores -subj and every certificate gets the
    // same subject, which makes the leaf look self-issued. Subjects come from -subj only.
    '[req]',
    'distinguished_name = dn',
    '[dn]',
    '[v3_ca]',
    'basicConstraints = critical, CA:TRUE, pathlen:0',
    'keyUsage = critical, keyCertSign, cRLSign',
    'subjectKeyIdentifier = hash',
    ...(nameConstraints && constraints ? [`nameConstraints = critical, ${constraints}`] : []),
    '[v3_server]',
    'basicConstraints = critical, CA:FALSE',
    'keyUsage = critical, digitalSignature',
    'extendedKeyUsage = serverAuth',
    `subjectAltName = ${san}`,
    'subjectKeyIdentifier = hash',
    'authorityKeyIdentifier = keyid,issuer',
    '',
  ].join('\n'), { mode: 0o600 });

  try {
    openssl(binary, options.dir, ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', caKeyPath]);
    chmodSync(caKeyPath, 0o600);
    openssl(binary, options.dir, [
      'req', '-new', '-x509', '-key', caKeyPath, '-sha256', '-days', String(validityDays),
      '-subj', `/CN=${cleanLabel(options.label)}`, '-config', configPath, '-extensions', 'v3_ca', '-out', caCertPath,
    ]);
    openssl(binary, options.dir, ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', serverKeyPath]);
    chmodSync(serverKeyPath, 0o600);
    openssl(binary, options.dir, [
      'req', '-new', '-key', serverKeyPath, '-subj', `/CN=${dnsNames[0] ?? ips[0]!.san}`, '-config', configPath, '-out', csrPath,
    ]);
    openssl(binary, options.dir, [
      'x509', '-req', '-in', csrPath, '-CA', caCertPath, '-CAkey', caKeyPath,
      '-set_serial', `0x${randomBytes(16).toString('hex').replace(/^[89a-f]/, '1')}`,
      '-days', String(validityDays), '-sha256', '-extfile', configPath, '-extensions', 'v3_server', '-out', serverCertPath,
    ]);
  } finally {
    // The CA key never outlives minting, success or not.
    rmSync(caKeyPath, { force: true });
    rmSync(csrPath, { force: true });
  }
  const verified = openssl(binary, options.dir, ['verify', '-CAfile', caCertPath, serverCertPath]).trim();
  if (!verified.endsWith(': OK')) throw new Error(`fixture CA: server certificate did not verify (${verified.slice(0, 200)})`);
  for (const path of [caCertPath, serverCertPath]) chmodSync(path, 0o600);
  if ((statSync(serverKeyPath).mode & 0o077) !== 0) throw new Error('fixture CA: server key is not private');

  const caCertPem = readFileSync(caCertPath, 'utf8');
  return {
    dir: options.dir,
    caCertPath,
    serverCertPath,
    serverKeyPath,
    caCertPem,
    serverCertPem: readFileSync(serverCertPath, 'utf8'),
    serverKeyPem: readFileSync(serverKeyPath, 'utf8'),
    caFingerprintSha256: createHash('sha256').update(pemDer(caCertPem)).digest('hex'),
    dnsNames,
    ipAddresses: ips.map(ip => ip.san),
    validityDays,
    nameConstraints,
    caKeyDestroyed: true,
  };
}

/** Human-readable certificate text (subject, SAN, constraints) for evidence. Contains no key material. */
export function describeFixtureCertificate(path: string, opensslPath = OPENSSL): string {
  return openssl(opensslPath, '/', ['x509', '-in', path, '-noout', '-text']);
}

/** Remove the files this module wrote. The directory itself belongs to the caller. */
export function removeFixtureCa(ca: Pick<FixtureCa, 'dir'>): void {
  for (const name of ['fixture-ca.crt', 'fixture-server.crt', 'fixture-server.key', 'fixture-ca.key', 'fixture-server.csr', 'fixture-ca.cnf', 'fixture-ca.srl']) {
    rmSync(join(ca.dir, name), { force: true });
  }
}
