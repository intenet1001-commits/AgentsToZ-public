import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Read-only Telegram status for a Hermes profile. Token values never leave
 * this module — callers only learn whether one is declared.
 */

const TOKEN_LINE = /^\s*(?:export\s+)?TELEGRAM_BOT_TOKEN\s*=\s*(.*)$/;

/** True when a `.env` body declares a non-empty, uncommented TELEGRAM_BOT_TOKEN (LF or CRLF). */
export function envDeclaresTelegramBotToken(envText: string): boolean {
  return envText.split(/\r?\n/).some(line => {
    const match = TOKEN_LINE.exec(line);
    if (!match) return false;
    const raw = match[1]!.trim();
    if (!raw || raw.startsWith('#')) return false;
    const quote = raw[0];
    if (quote === '"' || quote === "'") {
      const end = raw.indexOf(quote, 1);
      return (end < 0 ? raw.slice(1) : raw.slice(1, end)).trim().length > 0;
    }
    return true;
  });
}

/**
 * gateway_state.json keeps the last platform state after the gateway process
 * dies, so "connected" is only true while its PID is alive.
 */
export function effectiveTelegramState(recordedState: string, gatewayRunning: boolean): string {
  if (recordedState === 'connected' && !gatewayRunning) return 'gateway-stopped';
  return recordedState;
}

export type HermesTelegramStatus = {
  gatewayRunning: boolean;
  /** gateway_state.json's telegram state, downgraded by {@link effectiveTelegramState}. */
  telegramState: string;
  telegramConfigured: boolean;
};

/**
 * Reads gateway_state.json and .env for one profile home. `isAlive` is injected
 * so tests do not depend on real PIDs.
 */
export function readHermesTelegramStatus(
  profileHome: string,
  isAlive: (pid: number) => boolean,
): HermesTelegramStatus {
  const statePath = join(profileHome, 'gateway_state.json');
  let gatewayRunning = false;
  let recorded = 'not-configured';
  if (existsSync(statePath)) {
    try {
      const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, any>;
      const pid = Number(state.pid);
      gatewayRunning = Number.isInteger(pid) && pid > 0 && isAlive(pid);
      recorded = typeof state.platforms?.telegram?.state === 'string' ? state.platforms.telegram.state : 'not-configured';
    } catch {
      gatewayRunning = false;
      recorded = 'unknown';
    }
  }
  let telegramConfigured = false;
  const envPath = join(profileHome, '.env');
  if (existsSync(envPath)) {
    try { telegramConfigured = envDeclaresTelegramBotToken(readFileSync(envPath, 'utf8')); } catch { telegramConfigured = false; }
  }
  return { gatewayRunning, telegramState: effectiveTelegramState(recorded, gatewayRunning), telegramConfigured };
}
