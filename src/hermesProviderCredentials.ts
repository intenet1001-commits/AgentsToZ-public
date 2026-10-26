/**
 * Which inference providers this Mac's Hermes has credentials for — **by name only** (사용자 규칙 2026-10-25:
 * 「판정은 provider 이름만 보고 비밀값은 읽지도 출력하지도 않습니다」).
 *
 * How: `hermes auth list` prints one header line per provider — `anthropic (2 credentials):` — followed by indented
 * rows for each credential (a label, an auth type, a short id). Only the **header** lines are read, and only their
 * provider name is kept. The indented rows are never parsed, stored, logged or returned, `~/.hermes/auth.json` is
 * never opened, and no token, key or label leaves this module. A provider name is not a secret; a credential is.
 *
 * Why not the file: auth.json holds the tokens themselves. Why not an exit code: `hermes auth status <provider>`
 * answers 0 for a provider it has never heard of (measured, 2026-10-25), so it cannot tell the two apart.
 */
export const HERMES_AUTH_PROVIDER_LINE = /^([a-z0-9][a-z0-9._-]{0,63})\s\(\d{1,4}\scredentials?\):$/;

/** The provider names a `hermes auth list` output claims credentials for. Nothing else in that output is read. */
export function hermesAuthProviders(stdout: string): string[] {
  const names: string[] = [];
  for (const line of stdout.split('\n', 4_000)) {
    // Only a line that starts at column 0 is a header; a credential row is indented and is skipped whole.
    const name = HERMES_AUTH_PROVIDER_LINE.exec(line.replace(/\r$/, ''))?.[1];
    if (name && !names.includes(name)) names.push(name);
    if (names.length >= 64) break;
  }
  return names;
}

/** Runs `hermes auth list` and returns its stdout. Supplied by the host so this module starts no process itself. */
export type HermesAuthListReader = () => Promise<string>;

/**
 * The provider names, cached for a short window because each read is a CLI start. `null` = this Mac could not be
 * asked (no Hermes CLI, a timeout, an error): the caller must then treat every variant as offerable instead of
 * telling a person that a provider they do have is missing.
 */
export class HermesProviderCredentials {
  #providers: ReadonlySet<string> | null = null;
  #readAt = 0;
  #inFlight: Promise<ReadonlySet<string> | null> | null = null;
  constructor(readonly read: HermesAuthListReader, readonly ttlMs = 30_000, readonly now: () => number = Date.now) {}
  providers(): Promise<ReadonlySet<string> | null> {
    if (this.#readAt && this.now() - this.#readAt < this.ttlMs) return Promise.resolve(this.#providers);
    return this.#inFlight ??= (async () => {
      try {
        const names = hermesAuthProviders(await this.read());
        this.#providers = new Set(names);
      } catch {
        // Never cached as 「none」: an unanswerable CLI is not a provider list.
        this.#providers = null;
      }
      this.#readAt = this.now();
      this.#inFlight = null;
      return this.#providers;
    })();
  }
}
