import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { effectiveTelegramState, envDeclaresTelegramBotToken, readHermesTelegramStatus } from '../src/hermesTelegramStatus';

const api = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
const route = api.slice(api.indexOf('if (url.pathname === "/api/hermes/profiles"'), api.indexOf('if (url.pathname === "/api/hermes/profile/open-delete"'));

describe('Telegram bot token detection in a Hermes profile .env', () => {
  test('finds a token on an LF line', () => {
    expect(envDeclaresTelegramBotToken('OPENAI_API_KEY=x\nTELEGRAM_BOT_TOKEN=123:abc\n')).toBe(true);
  });

  test('finds a token on a CRLF line', () => {
    expect(envDeclaresTelegramBotToken('OPENAI_API_KEY=x\r\nTELEGRAM_BOT_TOKEN=123:abc\r\n')).toBe(true);
  });

  test('accepts spacing, export and quoted values', () => {
    expect(envDeclaresTelegramBotToken('  TELEGRAM_BOT_TOKEN = 123:abc')).toBe(true);
    expect(envDeclaresTelegramBotToken('export TELEGRAM_BOT_TOKEN="123:abc"')).toBe(true);
    expect(envDeclaresTelegramBotToken("TELEGRAM_BOT_TOKEN='123:abc'")).toBe(true);
  });

  test('ignores a commented-out or empty token', () => {
    expect(envDeclaresTelegramBotToken('# TELEGRAM_BOT_TOKEN=123:abc\n')).toBe(false);
    expect(envDeclaresTelegramBotToken('TELEGRAM_BOT_TOKEN=\n')).toBe(false);
    expect(envDeclaresTelegramBotToken('TELEGRAM_BOT_TOKEN=""\r\n')).toBe(false);
    expect(envDeclaresTelegramBotToken('TELEGRAM_BOT_TOKEN=  # set me\n')).toBe(false);
    expect(envDeclaresTelegramBotToken('MY_TELEGRAM_BOT_TOKEN=123:abc\n')).toBe(false);
  });

  test('the route reads status through the shared module, not an inline double-escaped regex', () => {
    // The inline regex was written as /^\\s*TELEGRAM.../ in plain TS, so it matched a
    // literal backslash and every profile reported telegramConfigured=false.
    expect(route).toContain('readHermesTelegramStatus(profileHome, isPidAlive)');
    expect(route).not.toContain('TELEGRAM_BOT_TOKEN');
  });
});

describe('Telegram connected state needs a live gateway', () => {
  test('a recorded connected state from a dead gateway is not connected', () => {
    expect(effectiveTelegramState('connected', true)).toBe('connected');
    expect(effectiveTelegramState('connected', false)).toBe('gateway-stopped');
  });

  test('other recorded states pass through', () => {
    expect(effectiveTelegramState('not-configured', false)).toBe('not-configured');
    expect(effectiveTelegramState('error', true)).toBe('error');
    expect(effectiveTelegramState('unknown', false)).toBe('unknown');
  });

  test('profile status reads a CRLF .env and downgrades a dead gateway', () => {
    const home = mkdtempSync(join(tmpdir(), 'hermes-telegram-'));
    writeFileSync(join(home, '.env'), 'A=1\r\nTELEGRAM_BOT_TOKEN=123:abc\r\n');
    writeFileSync(join(home, 'gateway_state.json'), JSON.stringify({ pid: 4242, platforms: { telegram: { state: 'connected' } } }));
    expect(readHermesTelegramStatus(home, () => false)).toEqual({ gatewayRunning: false, telegramState: 'gateway-stopped', telegramConfigured: true });
    expect(readHermesTelegramStatus(home, pid => pid === 4242)).toEqual({ gatewayRunning: true, telegramState: 'connected', telegramConfigured: true });
  });

  test('missing or unreadable gateway state is reported honestly', () => {
    const home = mkdtempSync(join(tmpdir(), 'hermes-telegram-'));
    expect(readHermesTelegramStatus(home, () => true)).toEqual({ gatewayRunning: false, telegramState: 'not-configured', telegramConfigured: false });
    writeFileSync(join(home, 'gateway_state.json'), '{not json');
    expect(readHermesTelegramStatus(home, () => true).telegramState).toBe('unknown');
  });
});
