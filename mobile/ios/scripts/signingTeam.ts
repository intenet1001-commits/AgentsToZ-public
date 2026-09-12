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
