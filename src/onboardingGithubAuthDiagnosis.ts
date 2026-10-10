/** gh JSON mode exits zero even for failed authentication. Never use that as
 * evidence of login, and never request --show-token. Keep only a fixed outcome. */
export type GithubAuthProbe = 'installed' | 'ready' | 'storage-review' | 'unknown';

export function diagnoseGithubAuth(input: {ok: boolean; stdout: string; timedOut: boolean}): GithubAuthProbe {
  if (!input.ok || input.timedOut || input.stdout.length > 65536) return 'unknown';
  try {
    const value = JSON.parse(input.stdout);
    if (!value || typeof value !== 'object' || !value.hosts || Array.isArray(value.hosts)
      || typeof value.hosts !== 'object') return 'unknown';
    const keys = Object.keys(value.hosts);
    // Empty hosts is gh's explicit no-account result, not an unreadable config.
    if (keys.length === 0) return 'installed';
    if (keys.length !== 1 || keys[0] !== 'github.com') return 'unknown';
    const entries = value.hosts['github.com'];
    if (!Array.isArray(entries) || entries.length !== 1) return 'unknown';
    const entry = entries[0];
    if (!entry || entry.host !== 'github.com' || entry.active !== true || entry.state !== 'success'
      || entry.error || entry.token !== undefined) return 'unknown';
    if (entry.tokenSource === 'keyring') return 'ready';
    // gh reports the config path for the active plaintext token. Unknown storage
    // remains unresolved rather than being treated as secure or logged out.
    if (entry.tokenSource === 'oauth_token' || (typeof entry.tokenSource === 'string'
      && /(?:^|\/)hosts\.yml$/.test(entry.tokenSource))) return 'storage-review';
    return 'unknown';
  } catch { return 'unknown'; }
}
