export interface NativeOAuthRelayOptions {
  ttlMs?: number;
  now?: () => number;
}

interface PendingOAuthRequest {
  expiresAt: number;
  code: string | null;
}

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{32,128}$/;
const MAX_CODE_LENGTH = 4096;

export class NativeOAuthRelay {
  private readonly pending = new Map<string, PendingOAuthRequest>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: NativeOAuthRelayOptions = {}) {
    this.ttlMs = options.ttlMs ?? 10 * 60_000;
    this.now = options.now ?? Date.now;
  }

  register(requestId: string): void {
    this.prune();
    if (!REQUEST_ID_RE.test(requestId)) {
      throw new Error('invalid native OAuth request id');
    }
    if (this.pending.has(requestId)) {
      throw new Error('native OAuth request id is already registered');
    }
    this.pending.set(requestId, { expiresAt: this.now() + this.ttlMs, code: null });
  }

  acceptCallback(requestId: string, code: string): boolean {
    this.prune();
    const request = this.pending.get(requestId);
    if (!request || request.code !== null || !this.validCode(code)) return false;
    request.code = code;
    return true;
  }

  consume(requestId: string): string | null {
    this.prune();
    const request = this.pending.get(requestId);
    if (!request?.code) return null;
    this.pending.delete(requestId);
    return request.code;
  }

  cancel(requestId: string): void {
    this.pending.delete(requestId);
  }

  private validCode(code: string): boolean {
    return code.length > 0
      && code.length <= MAX_CODE_LENGTH
      && !/[\u0000-\u001f\u007f]/.test(code);
  }

  private prune(): void {
    const now = this.now();
    for (const [requestId, request] of this.pending) {
      if (request.expiresAt <= now) this.pending.delete(requestId);
    }
  }
}
