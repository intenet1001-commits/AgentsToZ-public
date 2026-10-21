import { X509Certificate } from 'node:crypto';
/** Return Apple Development certificate labels without accepting distribution identities. */
export function appleDevelopmentIdentityLabels(identityOutput: string): string[] {
  return [...new Set(
    [...identityOutput.matchAll(/^\s*\d+\)\s+[0-9A-F]+\s+"(Apple Development:[^"\n]+)"/gm)]
      .map(match => match[1]!),
  )];
}

/** The TeamIdentifier is the certificate subject OU, not its display-name suffix. */
export function appleTeamIdentifierFromSubject(subject: string): string | null {
  return subject.match(/(?:^|[\n,])\s*OU\s*=\s*([A-Z0-9]{10})(?:\s*(?:[\n,]|$))/)?.[1] ?? null;
}

/**
 * The paid team that signs the TestFlight record (`com.intenet.agentstoz.mobile.testflight`)
 * and the v504 device archive. This Mac also carries a second, free development team, so
 * without a preference every USB command failed until the user found `--team`.
 * It is only a preference: it is used when that team is actually installed here.
 */
export const DEFAULT_IOS_DEVELOPMENT_TEAM = 'DA8QKAQ2C9';

export type DevelopmentTeamChoice = { team: string; source: 'requested' | 'only-installed' | 'default' };

/** Pick the signing team without guessing: explicit, then the only one, then the known default. */
export function resolveDevelopmentTeam(installed: readonly string[], requested?: string,
  preferred: string = DEFAULT_IOS_DEVELOPMENT_TEAM): DevelopmentTeamChoice {
  if (requested !== undefined && !/^[A-Z0-9]{10}$/.test(requested)) throw new Error('--team must be a 10-character Apple Team ID.');
  const teams = [...new Set(installed)].sort();
  if (teams.length === 0) throw new Error('A matching Apple Development signing identity is required.');
  if (requested !== undefined) {
    if (teams.includes(requested)) return { team: requested, source: 'requested' };
    throw new Error(`No Apple Development identity for team ${requested} is installed. Installed teams: ${teams.join(', ')}.`);
  }
  if (teams.length === 1) return { team: teams[0]!, source: 'only-installed' };
  if (teams.includes(preferred)) return { team: preferred, source: 'default' };
  throw new Error(`Several Apple Development teams are installed and none is the default ${preferred}. Retry with --team <team-id> (installed: ${teams.join(', ')}).`);
}

/** Team IDs of the Apple Development identities in this login keychain (read-only). */
export function installedDevelopmentTeams(): string[] {
  const identities = Bun.spawnSync(['security', 'find-identity', '-v', '-p', 'codesigning'], { stdout: 'pipe', stderr: 'pipe' });
  if (identities.exitCode !== 0) throw new Error('Apple Development signing identities could not be inspected.');
  return [...new Set(appleDevelopmentIdentityLabels(new TextDecoder().decode(identities.stdout)).flatMap(label => {
    const certificate = Bun.spawnSync(['security', 'find-certificate', '-p', '-c', label], { stdout: 'pipe', stderr: 'pipe' });
    if (certificate.exitCode !== 0 || certificate.stdout.length === 0) return [];
    try {
      const team = appleTeamIdentifierFromSubject(new X509Certificate(certificate.stdout).subject);
      return team ? [team] : [];
    } catch { return []; }
  }))];
}

// `bun signingTeam.ts [--team <id>]` prints the resolved team for non-Bun runners (check-ui.py).
if (import.meta.main) {
  const index = process.argv.indexOf('--team');
  try {
    console.log(JSON.stringify(resolveDevelopmentTeam(installedDevelopmentTeams(), index >= 0 ? process.argv[index + 1] : undefined)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
