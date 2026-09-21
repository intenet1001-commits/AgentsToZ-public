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

async function apiPost(path, body) {
  const response = await fetch(`http://127.0.0.1:3001${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.success !== true) {
    throw new Error(`Sidecar request ${path} failed: ${result.error || response.status}`);
  }
  return result;
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
  const pid = Number(value?.pid);
  if (!Number.isInteger(pid) || pid < 1) throw new Error(`Sidecar lifecycle response did not contain a PID: ${JSON.stringify(value)}`);
  return pid;
}

describe('installed Windows Tauri sidecar lifecycle', () => {
  afterEach(async () => {
    try {
      await apiPost('/api/stop-command', { portId, port: listenerPort });
    } catch {
      // The primary assertion reports the failure; this is best-effort cleanup.
    }
    try {
      await apiPost('/api/stop-command', { portId: detachedPortId, port: null });
    } catch {
      // Same best-effort cleanup for the detached-tree case.
    }
  });

  it('keeps native identity while one sidecar authority executes, restarts, and stops', async () => {
    expect(await invokeNative('get_platform')).toBe('windows');

    const health = await waitForPackagedHealth();
    const contract = JSON.parse(await readFile(contractPath, 'utf8'));
    expect(health.service).toBe('agentstoz-api');
    expect(Number(health.schemaVersion)).toBe(Number(contract.schemaVersion));
    for (const capability of contract.requiredCapabilities) {
      expect(health.capabilities).toContain(capability);
    }

    await apiPost('/api/ports', [
      { id: portId, name: 'Windows packaged lifecycle', port: listenerPort, commandPath, folderPath: workspace },
      { id: detachedPortId, name: 'Windows packaged detached tree', commandPath: detachedCommandPath, folderPath: workspace },
    ]);

    const executeResponse = await apiPost('/api/execute-command', {
      portId,
      commandPath,
      folderPath: workspace,
      port: listenerPort,
    });
    const firstPid = responsePid(executeResponse);
    await waitForListener(true, `Native execute_command did not listen on ${listenerPort}.`);

    const restartResponse = await apiPost('/api/force-restart-command', {
      portId,
      commandPath,
      folderPath: workspace,
      port: listenerPort,
    });
    const secondPid = responsePid(restartResponse);
    expect(secondPid).not.toBe(firstPid);
    await waitForListener(true, `Native force_restart_command did not listen on ${listenerPort}.`);

    const stopResponse = await apiPost('/api/stop-command', { portId, port: listenerPort });
    expect(String(stopResponse.message)).toContain('Stopped');
    await waitForListener(false, `Native stop_command left a listener on ${listenerPort}.`);
  });

  it('owns a no-port detached grandchild until native Stop closes the Job Object', async () => {
    await apiPost('/api/execute-command', {
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
    expect(String((await apiPost('/api/stop-command', { portId: detachedPortId, port: null })).message)).toContain('Stopped');
    await browser.waitUntil(async () => !processExists(detachedPid), {
      timeout: 30_000,
      interval: 100,
      timeoutMsg: `detached child PID ${detachedPid} survived native Stop`,
    });
  });
});
