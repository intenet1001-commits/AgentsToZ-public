/**
 * Every bound this server enforces. All of them are configurable so a deterministic fixture can
 * drive a budget to its edge without sending megabytes (contract §15).
 */

export interface RelayLimits {
  /** How long a socket has to send its join after the challenge (contract §6). */
  readonly challengeTtlMs: number;
  /** Binary cap before the host's `authenticated` signal, and always for registration. */
  readonly preAuthMaxFrameBytes: number;
  /**
   * Binary cap on a screen room after `authenticated`: the existing GCM record limit,
   * 8 MiB payload + 9 header + 16 tag (SecureChannel.swift).
   */
  readonly screenMaxFrameBytes: number;
  /** Live rooms, counted per room+purpose. */
  readonly maxRooms: number;
  /** Live sockets across the server. */
  readonly maxSockets: number;
  /** Simultaneous sockets from one IP. */
  readonly maxSocketsPerIp: number;
  /** Admissions (joins) allowed per IP inside `admissionWindowMs`. */
  readonly maxAdmissionsPerIp: number;
  readonly admissionWindowMs: number;
  /** Buffered-but-unsent bytes tolerated on one socket. */
  readonly maxPeerBufferedBytes: number;
  /** Buffered-but-unsent bytes tolerated across every socket. */
  readonly maxTotalPendingBytes: number;
  /** A host or controller may wait unpaired this long. */
  readonly idleWaitingMs: number;
  /** A paired session's absolute lifetime. */
  readonly activeLifetimeMs: number;
  /** Largest text frame accepted at all, so a join cannot be a denial of service by itself. */
  readonly maxTextFrameBytes: number;
}

export const DEFAULT_LIMITS: RelayLimits = {
  challengeTtlMs: 5_000,
  preAuthMaxFrameBytes: 16 * 1024,
  screenMaxFrameBytes: 8 * 1024 * 1024 + 25,
  maxRooms: 256,
  maxSockets: 512,
  maxSocketsPerIp: 8,
  maxAdmissionsPerIp: 30,
  admissionWindowMs: 60_000,
  maxPeerBufferedBytes: 16 * 1024 * 1024,
  maxTotalPendingBytes: 128 * 1024 * 1024,
  idleWaitingMs: 120_000,
  activeLifetimeMs: 60 * 60_000,
  maxTextFrameBytes: 4 * 1024,
};

export function resolveLimits(overrides: Partial<RelayLimits> = {}): RelayLimits {
  return { ...DEFAULT_LIMITS, ...overrides };
}

/**
 * A fixed-window counter per key. Windows rather than token buckets because the only question here
 * is "has this IP had too many admissions lately", and a window cannot be gamed by pacing.
 */
export class WindowCounter {
  private readonly counts = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 4096,
  ) {}

  /** True when the key is inside its budget; the attempt is counted either way. */
  admit(key: string, now: number): boolean {
    const entry = this.counts.get(key);
    if (!entry || now >= entry.resetAt) {
      if (!entry) this.evictIfFull(now);
      this.counts.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }

  /** Drops windows that have already elapsed; refuses a new key only if none can be freed. */
  private evictIfFull(now: number): void {
    if (this.counts.size < this.maxKeys) return;
    for (const [key, entry] of this.counts) {
      if (now >= entry.resetAt) this.counts.delete(key);
    }
    if (this.counts.size >= this.maxKeys) {
      // Still full of live windows: drop the oldest so tracking cannot grow without bound.
      const oldest = this.counts.keys().next();
      if (!oldest.done) this.counts.delete(oldest.value);
    }
  }

  get size(): number {
    return this.counts.size;
  }
}
