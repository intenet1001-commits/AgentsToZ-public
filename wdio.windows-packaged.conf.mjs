import { resolve } from 'node:path';

const application = process.env.AGENTSTOZ_PACKAGED_EXE;
if (!application) {
  throw new Error('AGENTSTOZ_PACKAGED_EXE is required for the installed Windows native E2E.');
}

const startTimeout = Number(process.env.AGENTSTOZ_PACKAGED_TIMEOUT_MS || 120_000);

export const config = {
  runner: 'local',
  specs: [resolve('./tests/windows-packaged-native.e2e.mjs')],
  maxInstances: 1,
  maxInstancesPerCapability: 1,
  services: [
    ['@wdio/tauri-service', {
      appBinaryPath: application,
      driverProvider: 'external',
      autoInstallTauriDriver: true,
      autoDownloadEdgeDriver: true,
      startTimeout,
      commandTimeout: 60_000,
      logLevel: 'info',
    }],
  ],
  capabilities: [{
    browserName: 'tauri',
    'tauri:options': {
      application,
    },
  }],
  framework: 'mocha',
  reporters: ['spec'],
  logLevel: 'info',
  waitforTimeout: 30_000,
  connectionRetryTimeout: startTimeout,
  connectionRetryCount: 2,
  mochaOpts: {
    ui: 'bdd',
    timeout: startTimeout,
  },
};
