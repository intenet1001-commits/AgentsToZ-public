import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const workflow = readFileSync(new URL('../.github/workflows/build-windows.yml', import.meta.url), 'utf8');
const wrapper = readFileSync(new URL('../build-win.ts', import.meta.url), 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const runnerUrl = new URL('../scripts/run-windows-e2e.ps1', import.meta.url);
const packagedRunnerUrl = new URL('../scripts/run-windows-packaged-e2e.ps1', import.meta.url);
const packagedWdioConfigUrl = new URL('../wdio.windows-packaged.conf.mjs', import.meta.url);
const packagedNativeSpecUrl = new URL('./windows-packaged-native.e2e.mjs', import.meta.url);
const supervisorUrl = new URL('../src-tauri/resources/windows-process-supervisor.ps1', import.meta.url);
const attributes = readFileSync(new URL('../.gitattributes', import.meta.url), 'utf8');
const detachedSidecarRunnerUrl = new URL('../scripts/run-windows-detached-sidecar-e2e.ps1', import.meta.url);
const tauriConfig = readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
const stampIconSource = readFileSync(new URL('../stamp-icon.py', import.meta.url), 'utf8');
const updateVersionSource = readFileSync(new URL('../update-version.ts', import.meta.url), 'utf8');
const cargoManifest = readFileSync(new URL('../src-tauri/Cargo.toml', import.meta.url), 'utf8');
const tauriConfigJson = JSON.parse(tauriConfig);

describe('Windows release workflow', () => {
  test('keeps source and shell-script line endings stable across Windows checkouts', () => {
    expect(attributes).toContain('* text=auto');
    expect(attributes).toContain('*.ps1 text eol=crlf');
  });

  test('runs automatically for pull requests and main updates, not only manual dispatch', () => {
    expect(workflow).toContain('pull_request:');
    expect(workflow).toContain('push:');
    expect(workflow).toContain('branches: [main]');
    expect(workflow).toContain('workflow_dispatch:');
  });

  test('uses the supported Windows wrapper from a reproducible install', () => {
    expect(workflow).toContain('bun install --frozen-lockfile');
    expect(workflow).toContain('python -m pip install Pillow');
    expect(workflow).toContain('run: bun run tauri:build:win');
    expect(workflow).not.toContain('run: bun run tauri build --bundles');
  });

  test('regenerates the Windows ICO without requiring macOS iconutil', () => {
    expect(stampIconSource).toContain('sys.stdout.reconfigure(encoding="utf-8")');
    expect(stampIconSource).toContain('ico_path = os.path.join(icons_dir, "icon.ico")');
    expect(stampIconSource).toContain('stamp(256).save(');
    expect(stampIconSource).toContain('if sys.platform == "darwin":');
  });

  test('uploads the wrapper target instead of the unused repository target', () => {
    expect(workflow).toContain('CARGO_TARGET_DIR: ${{ github.workspace }}\\cargo-targets\\portmanager');
    expect(workflow).toContain('${{ env.CARGO_TARGET_DIR }}/release/bundle/nsis/*.exe');
    expect(workflow).not.toContain('src-tauri/target/release/bundle');
  });

  test('wrapper honors an explicit CI target while retaining the user-home default', () => {
    expect(wrapper).toContain('process.env.CARGO_TARGET_DIR');
    expect(wrapper).toContain('join(homedir(), "cargo-targets", "portmanager")');
  });

  test('CI packages the committed release version without incrementing it again', () => {
    expect(wrapper).toContain('process.env.CI?.toLowerCase() === "true"');
    expect(wrapper).toContain('[build-win] CI — committed version is preserved');
    expect(wrapper).toContain('await $`bun update-version.ts`');
  });

  test('keeps the Windows executable metadata aligned with the release version', () => {
    expect(updateVersionSource).toContain('const CARGO_TOML_PATH');
    expect(updateVersionSource).toContain('src-tauri/Cargo.toml package version was not found');
    expect(cargoManifest).toContain(`version = "${tauriConfigJson.version}"`);
  });

  test('uses a writable per-user temporary folder for prerequisite installers', () => {
    expect(apiSource).toContain("mkdtempSync(join(tmpdir(), 'agentstoz-build-prereqs-'))");
    expect(apiSource).not.toContain("const tmpDir = 'C:/tmp'");
  });

  test('discovers the default Scoop installation under the Windows user profile', () => {
    expect(apiSource).toContain('`${home}\\\\scoop\\\\apps\\\\supabase\\\\current\\\\supabase.exe`');
    expect(apiSource).toContain('`${home}\\\\scoop\\\\shims;${process.env.PATH ?? ""}`');
  });

  test('runs the standalone Windows E2E suite through a supervised dev server', () => {
    expect(packageJson.scripts['test:windows:e2e']).toBe('tsx tests/windows-e2e.spec.ts');
    expect(packageJson.devDependencies.tsx).toBe('4.23.12');
    expect(existsSync(fileURLToPath(runnerUrl))).toBe(true);
    const runner = readFileSync(runnerUrl, 'utf8');
    expect(runner).toContain('Start-Process');
    expect(runner).toContain('function Get-FreeTcpPort');
    expect(runner).toContain('$env:API_PORT = $apiPort.ToString()');
    expect(runner).toContain('$env:PORT = $uiPort.ToString()');
    expect(runner).toContain('"$apiBase/api/health"');
    expect(runner).toContain('bun run test:windows:e2e');
    expect(runner).toContain('bun run test:smoke');
    expect(runner).toContain('run-windows-detached-sidecar-e2e.ps1');
    const detachedRunner = readFileSync(new URL('../scripts/run-windows-detached-sidecar-e2e.ps1', import.meta.url), 'utf8');
    expect(detachedRunner).toContain('/api/execute-command');
    expect(detachedRunner).toContain('/api/stop-command');
    expect(detachedRunner).toContain('survived Stop');
    expect(detachedRunner).toContain('Windows sidecar PowerShell-launcher E2E passed');
    expect(detachedRunner).toContain('function Add-BaselinePortRows');
    expect(detachedRunner).toContain("$id -like 'windows-sidecar-detached-tree-*'");
    expect(detachedRunner).toContain('$SeenIds.Add($id)');
    expect(detachedRunner).toContain('$originalPorts.ToArray()');
    expect(detachedRunner).toContain('failed to restore the original ports');
    expect(detachedRunner).toContain('/api/ports/merge');
    expect(detachedRunner).toContain("source = 'windows-sidecar-e2e-restore'");
    expect(runner).toContain('taskkill.exe /PID $devProcess.Id /T /F');
    expect(workflow).toContain('bun node_modules/playwright/cli.js install chromium');
    expect(workflow).not.toContain('bunx playwright install chromium');
    expect(workflow).toContain('scripts/run-windows-e2e.ps1');
  });

  test('installs and validates the packaged artifact before upload', () => {
    expect(existsSync(fileURLToPath(packagedRunnerUrl))).toBe(true);
    const runner = readFileSync(packagedRunnerUrl, 'utf8');
    expect(runner).toContain("'/S'");
    expect(runner).toContain("Join-Path $installRoot 'app.exe'");
    expect(runner).toContain("Join-Path $installRoot 'uninstall.exe'");
    expect(runner).toContain('[switch]$HostedRunnerSmoke');
    expect(runner).toContain("Filter 'agentstoz-api-sidecar.exe'");
    expect(runner).toContain("Filter 'windows-process-supervisor.ps1'");
    expect(runner).toContain('Installed API sidecar health contract did not match');
    expect(runner).toContain('Hosted Windows package smoke passed');
    expect(runner).toContain("run%prod% & packaged.ps1");
    expect(runner).toContain('bunx wdio run wdio.windows-packaged.conf.mjs');
    expect(runner).toContain('Remove-Item -Recurse -Force $installRoot, $workspace, $isolatedAppData');
    expect(existsSync(fileURLToPath(packagedWdioConfigUrl))).toBe(true);
    expect(existsSync(fileURLToPath(packagedNativeSpecUrl))).toBe(true);

    const config = readFileSync(packagedWdioConfigUrl, 'utf8');
    expect(config).toContain("driverProvider: 'external'");
    expect(config).toContain('AGENTSTOZ_PACKAGED_EXE');
    expect(config).toContain("browserName: 'tauri'");

    const nativeSpec = readFileSync(packagedNativeSpecUrl, 'utf8');
    const supervisor = readFileSync(supervisorUrl, 'utf8');
    expect(nativeSpec).toContain('window.__TAURI_INTERNALS__.invoke');
    expect(nativeSpec).toContain("invokeNative('execute_command'");
    expect(nativeSpec).toContain("invokeNative('force_restart_command'");
    expect(nativeSpec).toContain("invokeNative('stop_command'");
    expect(nativeSpec).toContain("const detachedPortId = 'windows-packaged-detached-tree'");
    expect(nativeSpec).toContain('await browser.waitUntil(async () => !processExists(detachedPid)');
    expect(nativeSpec).toContain("invokeNative('get_platform'");
    expect(nativeSpec).toContain("expect(health.service).toBe('agentstoz-api')");
    expect(wrapper).toContain('windows-process-supervisor.ps1');
    expect(wrapper).toContain('[stagedSupervisor]: "windows-process-supervisor.ps1"');
    expect(wrapper).toContain('[stagedGlob]: sidecarName');
    expect(tauriConfig).toContain('resources/windows-process-supervisor.ps1');
    expect(supervisor).toContain('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE');
    expect(supervisor).toContain("Join-Path $PSHOME 'powershell.exe'");
    expect(supervisor).toContain('foreach ($childArg in $decodedChildArgs)');
    expect(supervisor).toContain('CREATE_SUSPENDED');
    expect(supervisor).toContain('AssignProcessToJobObject');
    expect(supervisor).toContain('ResumeThread');
    expect(supervisor).toContain('QueryInformationJobObject');
    expect(supervisor).toContain('while(Active(job)>0)');
    const detachedSidecar = readFileSync(detachedSidecarRunnerUrl, 'utf8');
    expect(detachedSidecar).toContain('/api/execute-command');
    expect(detachedSidecar).toContain('/api/stop-command');
    expect(detachedSidecar).toContain('Get-Process -Id $detachedPid -ErrorAction SilentlyContinue');
    expect(packageJson.devDependencies['@wdio/tauri-service']).toBe('1.3.0');
    expect(workflow).toContain('Run installed Windows package smoke');
    expect(workflow).toContain('scripts/run-windows-packaged-e2e.ps1 -HostedRunnerSmoke');
    expect(workflow).toContain('Run without -HostedRunnerSmoke on an interactive Windows');
    expect(workflow).not.toContain('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS');
  });
});
