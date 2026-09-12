import {mkdtempSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir, networkInterfaces} from 'node:os';
import {resolve, join} from 'node:path';
import {RemoteControlLanServer, isPrivateRemoteControlIpv4} from '../../../src/remoteControlLanServer';
import type {RemoteControlRegisteredTarget} from '../../../src/remoteControlProcessGateway';

const root = resolve(import.meta.dir, '../../..');
const packagePath = join(root, 'mobile/ios/AgentsToZCore');
const temporary = mkdtempSync(join(tmpdir(), 'agentstoz-native-check-'));
async function command(args: string[], input?: string, timeoutMs = 120_000) {
  const child = Bun.spawn(args, {cwd: root, stdin:'pipe', stdout:'pipe', stderr:'pipe'});
  if (input !== undefined) child.stdin.write(input);
  child.stdin.end();
  const timer = setTimeout(() => child.kill(), timeoutMs);
  try {
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return {code, out, err};
  } finally { clearTimeout(timer); }
}
function check(value: unknown, label: string): asserts value { if (!value) throw Error(label); }
try {
  const sourceDir = join(packagePath, 'Sources/AgentsToZCore');
  const compiled = await command(['swiftc', '-D', 'CORE_CHECKS', '-parse-as-library',
    ...readdirSync(sourceDir).filter(n => n.endsWith('.swift')).sort().map(n => join(sourceDir, n)),
    join(packagePath, 'Tests/AgentsToZCoreTests/RemoteTests.swift'), '-o', join(temporary, 'checks')]);
  check(compiled.code === 0, 'Swift compilation failed: ' + compiled.err);
  const checks = await command([join(temporary, 'checks')]);
  check(checks.code === 0, 'Native contract regression failed');
  console.log(checks.out.trim());
  const build = await command(['swift', 'build', '--package-path', packagePath, '--product', 'RemoteProbe']);
  check(build.code === 0, 'Native transport build failed: ' + build.err);
  const bin = await command(['swift', 'build', '--package-path', packagePath, '--show-bin-path']);
  check(bin.code === 0, 'Native executable path unavailable');
  const probe = join(bin.out.trim(), 'RemoteProbe');
  const address = Object.values(networkInterfaces()).flat().find(row => row && !row.internal && row.family === 'IPv4' && isPrivateRemoteControlIpv4(row.address))?.address;
  check(address, 'Native network check needs a private IPv4 interface; no public/wildcard fallback');
  let starts = 0, running = false;
  const target = (): RemoteControlRegisteredTarget => ({internalId:'native-fixture-project', name:'Native fixture', port:19000,
    kind:'main', status:running?'running':'stopped', command:null, actions:['start','stop','restart']});
  const server = new RemoteControlLanServer({bindAddress:address, hostName:'Native fixture host', gateway:{
    listRegisteredProjects:()=>[target()], executeRegisteredProjectAction:request=>{
      check(request.action === 'start', 'Unexpected fixture mutation'); starts++; running = true;
    },
  }});
  try {
    const issued = await server.start();
    const result = await command([probe, '--fixture-action'], issued.pairing.pairingUrl + '\n', 25_000);
    check(!result.out.includes('#pair=') && !result.err.includes('#pair='), 'QR leaked to output');
    check(result.code === 0, 'Real native-to-Bun pairing/list/action failed: ' + result.err);
    check(starts === 1 && running, 'Fixture action was not executed exactly once');
    const replay = await command([probe], issued.pairing.pairingUrl + '\n', 25_000);
    check(replay.code !== 0 && starts === 1, 'Consumed QR was reused');
    // A dropped socket no longer ends a session — the host keeps it so a locked phone can resume.
    // An explicit disconnect still has to end it, and now says so with session.end instead of
    // relying on the close, which the host can no longer tell apart from backgrounding.
    for(let n=0;n<40&&server.status().sessions.length;n++) await Bun.sleep(25);
    check(server.status().sessions.length === 0, 'Explicit native disconnect left a host session');
    console.log('Real native/Bun pairing, listing, confirmed action, one-use QR and explicit end passed');
  } finally { await server.stop(); }

  // The morning case, against a real host: pair, drop the socket the way backgrounding does, then
  // come back with the stored session token on a new socket. Before this the native app stored
  // nothing and never sent session.restore, so a screen lock cost a walk to the Mac for a new QR.
  const resumeServer = new RemoteControlLanServer({bindAddress:address, hostName:'Native resume host', gateway:{
    listRegisteredProjects:()=>[target()], executeRegisteredProjectAction:()=>{},
  }});
  try {
    const issued = await resumeServer.start();
    const resumed = await command([probe, '--fixture-resume'], issued.pairing.pairingUrl + '\n', 25_000);
    check(!resumed.out.includes('#pair=') && !resumed.err.includes('#pair='), 'QR leaked to output');
    check(resumed.code === 0, 'Native resume without a new QR failed: ' + resumed.err);
    check(resumed.out.includes('"resumed":true'), 'Native resume did not report success');
    // disconnect() is an explicit end, so the host must not be left holding the session either.
    for(let n=0;n<40&&resumeServer.status().sessions.length;n++) await Bun.sleep(25);
    check(resumeServer.status().sessions.length === 0, 'Explicit native disconnect left a host session');
    console.log('Native session resume without a new QR passed');
  } finally { await resumeServer.stop(); }

  // A scanned private address must not redirect the native transport elsewhere.
  let redirectedRequests = 0;
  const destination = Bun.serve({hostname:address, port:0, fetch(){redirectedRequests++;return new Response('unexpected');}});
  const redirector = Bun.serve({hostname:address, port:0, fetch(){return Response.redirect(`http://${address}:${destination.port}/remote/ws`,302);}});
  try {
    const result = await command([probe], `http://${address}:${redirector.port}/remote/#pair=${'a'.repeat(43)}\n`,25_000);
    check(result.code !== 0 && redirectedRequests === 0, 'Native transport followed a redirect');
    console.log('Native redirect rejection passed');
  } finally { await redirector.stop(true); await destination.stop(true); }
  const silent = Bun.serve({hostname:address,port:0,
    fetch(request, server) { if(server.upgrade(request))return;return new Response('closed',{status:400}); },
    websocket:{message(){}},
  });
  try {
    const started = Date.now();
    const result = await command([probe,'--fixture-cancel'],`http://${address}:${silent.port}/remote/#pair=${'a'.repeat(43)}\n`,5_000);
    check(result.code===0 && Date.now()-started<4_000,'Cancelling an unanswered native request did not release I/O');
    console.log('Native unanswered-request cancellation passed');
  } finally { await silent.stop(true); }
} finally { rmSync(temporary,{recursive:true,force:true}); }
