import { readFile } from 'node:fs/promises';
import net from 'node:net';
import { resolve } from 'node:path';

const workspace = process.env.AGENTSTOZ_PACKAGED_WORKSPACE;
const commandPath = process.env.AGENTSTOZ_PACKAGED_COMMAND;
const listenerScript = process.env.AGENTSTOZ_PACKAGED_LISTENER;
const listenerPort = Number(process.env.AGENTSTOZ_PACKAGED_PORT);
const detachedCommandPath = process.env.AGENTSTOZ_PACKAGED_DETACHED_COMMAND;
const detachedPidFile = process.env.AGENTSTOZ_DETACHED_PID_FILE;
const contractPath = resolve('./context-api-contract.json');
const portId = 'windows-packaged-native-e2e';
const detachedPortId = 'windows-packaged-detached-tree';

if (!workspace || !commandPath || !listenerScript || !detachedCommandPath || !detachedPidFile || !Number.isInteger(listenerPort) || listenerPort < 1) {
  throw new Error('Packaged native E2E environment is incomplete.');
}

async function invokeNative(command, args = {}) {
  const result = await browser.executeAsync((name, payload, done) => {
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    if (typeof invoke !== 'function') {
      done({ ok: false, error: 'window.__TAURI_INTERNALS__.invoke is unavailable' });
      return;
    }
    Promise.resolve(invoke(name, payload)).then(
      value => done({ ok: true, value }),
      error => done({ ok: false, error: String(error) }),
    );
  }, command, args);
  if (!result?.ok) {
    throw new Error(`Native command ${command} failed: ${result?.error || 'unknown error'}`);
  }
  return result.value;
}

function tcpListenerOpen(port) {
  return new Promise(resolveOpen => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = open => {
      socket.destroy();
      resolveOpen(open);
    };
    socket.setTimeout(750);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function waitForListener(expectedOpen, message) {
  await browser.waitUntil(async () => (await tcpListenerOpen(listenerPort)) === expectedOpen, {
    timeout: 30_000,
    interval: 250,
    timeoutMsg: message,
  });
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPackagedHealth() {
  let health;
  await browser.waitUntil(async () => {
    try {
      const response = await fetch('http://127.0.0.1:3001/api/health');
      if (!response.ok) return false;
      health = await response.json();
      return true;
    } catch {
      return false;
    }
  }, {
    timeout: 60_000,
    interval: 500,
    timeoutMsg: 'Installed app sidecar did not become ready on API 3001.',
  });
  return health;
}

function responsePid(value) {
  const match = String(value).match(/PID:\s*(\d+)/i);
  if (!match) throw new Error(`Native lifecycle response did not contain a PID: ${value}`);
  return Number(match[1]);
}

describe('installed Windows native Tauri lifecycle', () => {
  afterEach(async () => {
    try {
      await invokeNative('stop_command', { portId, port: listenerPort });
    } catch {
      // The primary assertion reports the failure; this is best-effort cleanup.
    }
    try {
      await invokeNative('stop_command', { portId: detachedPortId, port: null });
    } catch {
      // Same best-effort cleanup for the detached-tree case.
    }
  });

  it('crosses native IPC for execute, force restart, and stop', async () => {
    expect(await invokeNative('get_platform')).toBe('windows');

    const health = await waitForPackagedHealth();
    const contract = JSON.parse(await readFile(contractPath, 'utf8'));
    expect(health.service).toBe('agentstoz-api');
    expect(Number(health.schemaVersion)).toBe(Number(contract.schemaVersion));
    for (const capability of contract.requiredCapabilities) {
      expect(health.capabilities).toContain(capability);
    }

    const executeResponse = await invokeNative('execute_command', {
      portId,
      commandPath,
      folderPath: workspace,
      port: listenerPort,
    });
    const firstPid = responsePid(executeResponse);
    await waitForListener(true, `Native execute_command did not listen on ${listenerPort}.`);

    const restartResponse = await invokeNative('force_restart_command', {
      portId,
      commandPath,
      folderPath: workspace,
      port: listenerPort,
    });
    const secondPid = responsePid(restartResponse);
    expect(secondPid).not.toBe(firstPid);
    await waitForListener(true, `Native force_restart_command did not listen on ${listenerPort}.`);

    const stopResponse = await invokeNative('stop_command', { portId, port: listenerPort });
    expect(String(stopResponse)).toContain('Stopped');
    await waitForListener(false, `Native stop_command left a listener on ${listenerPort}.`);
  });

  it('owns a no-port detached grandchild until native Stop closes the Job Object', async () => {
    await invokeNative('execute_command', {
      portId: detachedPortId,
      commandPath: detachedCommandPath,
      folderPath: workspace,
      port: null,
    });
    await browser.waitUntil(async () => {
      try {
        return Number.parseInt(await readFile(detachedPidFile, 'utf8'), 10) > 0;
      } catch {
        return false;
      }
    }, { timeout: 30_000, interval: 100, timeoutMsg: 'detached child pid file was not created' });
    const detachedPid = Number.parseInt(await readFile(detachedPidFile, 'utf8'), 10);
    expect(processExists(detachedPid)).toBe(true);
    expect(String(await invokeNative('stop_command', { portId: detachedPortId, port: null }))).toContain('Stopped');
    await browser.waitUntil(async () => !processExists(detachedPid), {
      timeout: 30_000,
      interval: 100,
      timeoutMsg: `detached child PID ${detachedPid} survived native Stop`,
    });
  });
});
