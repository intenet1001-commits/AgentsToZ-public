// Shared normal-profile check: existing contracts, native control regressions and one isolated UI suite.
// No installed app, user browser, real authentication, permission grant or AI call is used.
const tests=[
  "./tests/read-tool-bundle.test.ts",
  "./tests/work-pack.test.ts",
  "./tests/work-pack-store.test.ts",
  "./tests/workroom-thread-read-execution.test.ts",
  "./tests/read-tool-batch-client.test.ts",
  "./tests/read-tool-batch-host.test.ts",
  "./tests/read-tool-batch-http.test.ts",
  "./tests/work-pack-host.test.ts",
  "./tests/work-pack-http.test.ts",
  "./tests/computer-use.test.ts",
  "./tests/computer-use-scope.test.ts",
  "./tests/computer-use-scope-mcp.test.ts",
  "./tests/computer-use-access-switch.test.ts",
  "./tests/workroom-schedules.test.ts",
  "./tests/workroom-schedule-terminal.test.ts",
  "./tests/workroom-schedule-integration.test.ts",
  "./tests/desktop-effort-native.test.ts",
  "./tests/desktop-session-effort.test.ts",
  "./tests/computer-use-hardening.test.ts",
  "./tests/computer-use-recovery.test.ts",
  "./tests/computer-use-approval.test.ts",
  "./tests/computer-use-approval-window.test.ts",
  "./tests/computer-use-session-lifecycle.test.ts",
  "./tests/computer-use-control-hooks.test.ts",
  "./tests/computer-use-control-bundle.test.ts",
  "./tests/computer-use-signing-profile.test.ts",
  "./tests/computer-use-control-native.test.ts",
  "./tests/computer-use-main-link.test.ts",
  "./tests/computer-use-runtime.test.ts",
  "./tests/computer-use-panel-status.test.ts",
  "./tests/computer-use-build-output.test.ts",
  "./tests/agentstoz-use-mcp-stdio.test.ts",
  "./tests/agentstoz-use-mcp-version.test.ts",
  "./tests/agentstoz-use-control.test.ts",
  "./tests/helpdesk.test.ts",
  "./tests/sidecar-build-plan.test.ts",
  "./tests/macos-base-app.test.ts",
  "./tests/macos-developer-id-build.test.ts"
];
async function run(args:string[]){
 const child=Bun.spawn(args,{cwd:import.meta.dir+'/..',stdout:'inherit',stderr:'inherit'});
 const status=await child.exited;if(status!==0)process.exit(status);
}
await run([process.execPath,'test','--max-concurrency=1',...tests]);
// Compile the actual AX collector with deterministic drivers, and the v2 OS guard's target resolution against a
// real-shaped window list (Dock sheet, own floating panel, protected app beneath); no TCC prompt, window or grant.
if(process.platform==='darwin')await run(['swift','test','--package-path','native/computer-use',
  '--disable-automatic-resolution','--filter','ExactAXTreeTests|ScopedOSGuardTests']);
await run([process.execPath,'scripts/check-maintainer-web.ts','computer-use']);
