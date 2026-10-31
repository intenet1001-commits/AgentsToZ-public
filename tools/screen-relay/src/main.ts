#!/usr/bin/env bun
/**
 * Relay entry point.
 *
 * Binds 127.0.0.1 by default on purpose: this process is meant to sit behind a reverse proxy that
 * terminates TLS with a normally validated certificate. See README.md — nothing here disables or
 * works around certificate verification, and no public bind is configured for you.
 *
 * Usage:
 *   bun tools/screen-relay/src/main.ts
 *   RELAY_PORT=8787 bun tools/screen-relay/src/main.ts
 */

import { createRelayServer } from "./server.ts";
import { DEFAULT_LIMITS } from "./limits.ts";

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 0) {
    console.error(`[screen-relay] ${name} must be a non-negative integer; got ${JSON.stringify(raw)}`);
    process.exit(2);
  }
  return value;
}

const hostname = process.env.RELAY_HOST ?? "127.0.0.1";
const port = intFromEnv("RELAY_PORT", 8787);

if (hostname === "0.0.0.0" || hostname === "::") {
  // Refused rather than silently served: a wildcard bind exposes an untrusted-content relay with
  // no TLS directly to the network. Put a reverse proxy in front and keep this on loopback.
  console.error(
    "[screen-relay] refusing to bind a wildcard address. Bind 127.0.0.1 and terminate TLS in a reverse proxy (see README).",
  );
  process.exit(2);
}

const server = createRelayServer({
  hostname,
  port,
  challengeTtlMs: intFromEnv("RELAY_CHALLENGE_TTL_MS", DEFAULT_LIMITS.challengeTtlMs),
  maxRooms: intFromEnv("RELAY_MAX_ROOMS", DEFAULT_LIMITS.maxRooms),
  maxSockets: intFromEnv("RELAY_MAX_SOCKETS", DEFAULT_LIMITS.maxSockets),
  maxSocketsPerIp: intFromEnv("RELAY_MAX_SOCKETS_PER_IP", DEFAULT_LIMITS.maxSocketsPerIp),
  maxAdmissionsPerIp: intFromEnv("RELAY_MAX_ADMISSIONS_PER_IP", DEFAULT_LIMITS.maxAdmissionsPerIp),
  maxPeerBufferedBytes: intFromEnv("RELAY_MAX_PEER_BUFFERED_BYTES", DEFAULT_LIMITS.maxPeerBufferedBytes),
  maxTotalPendingBytes: intFromEnv("RELAY_MAX_TOTAL_PENDING_BYTES", DEFAULT_LIMITS.maxTotalPendingBytes),
  idleWaitingMs: intFromEnv("RELAY_IDLE_WAITING_MS", DEFAULT_LIMITS.idleWaitingMs),
  activeLifetimeMs: intFromEnv("RELAY_ACTIVE_LIFETIME_MS", DEFAULT_LIMITS.activeLifetimeMs),
});

// Counts only. No room capability, no key, no frame, no authentication body is ever logged
// (contract §15) — these numbers are safe because none of them identifies a peer or a session.
console.error(
  `[screen-relay] listening on ${server.hostname}:${server.port}${new URL(server.url).pathname} ` +
    `(loopback; TLS belongs in the reverse proxy)`,
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.error(`[screen-relay] ${signal}: closing`);
    server.stop();
    process.exit(0);
  });
}
