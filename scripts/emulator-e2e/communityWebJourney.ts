/** J4-COMMUNITY-WEB: an isolated WebKit phone drives B through A's relay and community mailbox. */
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {LaneContext, LaneDefinition} from '../emulator-e2e';
import type {LaneOutcome, PathLabels} from './evidence';
import type {RunningSupabaseShim} from './supabaseShimHost';
import {managementRequest, readSideEffectLog, forbiddenOpenFiles, writeFakeCli} from './isolatedSidecar';
import {communityMacSpecs, enterCommunity, judgeDialogueDump, newSharedProfileFixture, prepareSharedProfile, startCommunityMacs,
  summarizeHostSideEffects, type CommunityMac, type MacCommunityReceipts} from './controlProfileFixture';
import {PORTAL_ORIGIN, assertShimOrigin, buildPortalFixture, readVercelConfig, redactPairingText, summarizePairing, withPortalQuery} from './portalFixtureBuild';
import {Phone, PhoneBlockedError, launchPhoneBrowser, type PhoneBrowser} from './relayWebPhone';
import {auditRelaySequences, fakeAgentCliSource, judgePhones, judgeShimReport, phoneBrowserEnv} from './relayWebJourney';

export const LANE_ID = 'j4-web' as const;
const labels: PathLabels = {
  real: ['production portal in headless WebKit → encrypted internet relay → sandboxed A → community control mailbox → sandboxed B',
    'canonical relay and dialogue SQL with RLS in PGlite', 'real ControlProfileStore.sharedProfileId on both sandboxed hosts',
    'B AiTerminalService and PTY; actual phone UI controls the session'],
  standIn: ['Supabase, email and signing keys: per-run PGlite HTTPS shim and fixture CA',
    'both hosts, profiles, keychain values and AI CLI use disposable sandboxed fixtures',
    'Mac-side profile setup, community membership, SAS approval and phone grants are scripted management calls',
    'phone is desktop Playwright WebKit with ephemeral context; WebKit uses the real HOME and scratch TMPDIR',
    'portal.test is fulfilled from a production build; CSP permits only the fixture shim',
    'the rejection probes originate from A management rather than from an attacker-controlled phone'],
};

async function until<T>(label: string, fn: () => Promise<T | null>, timeout = 90_000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value !== null) return value; await Bun.sleep(500); }
  throw new Error(`timed out waiting for ${label}`);
}

/** The audit is independent of the UI: both kinds must be answered exactly once per inserted row. */
export function judgeCommunityAudit(dump: any, from: string, to: string): {problems: string[]; counts: Record<string, number>} {
  const rows: any[] = Array.isArray(dump?.audit?.dialogue_controls) ? dump.audit.dialogue_controls : [];
  const inserted = rows.filter(row => row.event === 'insert' && row.from_endpoint_id === from && row.to_endpoint_id === to);
  const counts: Record<string, number> = {};
  const problems: string[] = [];
  for (const row of inserted) {
    const kind = String(row.request_kind ?? ''); counts[kind] = (counts[kind] ?? 0) + 1;
    const states = rows.filter(event => event.control_id === row.control_id);
    if (states.filter(event => event.state === 'taken').length > 1 || states.filter(event => event.state === 'done').length > 1)
      problems.push(`control row was taken or answered more than once: ${kind}`);
  }
  for (const kind of ['projects', 'terminal']) {
    if (!inserted.some(row => row.request_kind === kind && rows.some(event => event.control_id === row.control_id && event.state === 'done')))
      problems.push(`no completed ${kind} control from A to B`);
  }
  return {problems, counts};
}

export async function runCommunityWebJourney(ctx: LaneContext): Promise<LaneOutcome> {
  const shared = newSharedProfileFixture(), specs = communityMacSpecs(), problems: string[] = [], details: Record<string, unknown> = {};
  const receipts: string[] = [];
  let shim: RunningSupabaseShim | null = null, macs: CommunityMac[] = [], browser: PhoneBrowser | null = null, phone: Phone | null = null;
  let joined: MacCommunityReceipts[] = [], result: LaneOutcome = {status: 'fail', reason: 'journey did not finish'};
  const step = async <T>(name: string, action: () => Promise<T>): Promise<T> => {
    ctx.log(`j4-web: ${name}`);
    try { const value = await action(); receipts.push(name); return value; }
    catch (error) {
      const message = `${name}: ${redactPairingText((error as Error)?.message ?? String(error)).slice(0, 500)}`;
      if (error instanceof PhoneBlockedError) throw new PhoneBlockedError(message);
      throw new Error(message);
    }
  };
  const request = async (mac: CommunityMac, path: string, body: unknown, method: 'POST' | 'GET' = 'POST') => {
    const value = await managementRequest(mac.sidecar, path, body, method);
    if (value.status !== 200) throw new Error(`${path}: HTTP ${value.status} ${String(value.json.code ?? '')} ${String(value.json.error ?? '')}`);
    return value.json;
  };
  try {
    shim = await step('start isolated HTTPS Supabase shim', () => ctx.startSupabaseShim({label: LANE_ID}));
    const credentials = shim.credentials();
    if (!credentials.https || !shim.ready.caCertPath) throw new PhoneBlockedError('fixture HTTPS shim unavailable');
    const origin = assertShimOrigin(new URL(credentials.https.url).origin), member = credentials.users.find(user => user.member);
    if (!member) throw new Error('fixture member missing');
    const build = await step('build production portal for fixture shim', () => buildPortalFixture({repoRoot: ctx.repoRoot,
      outDir: join(ctx.scratchRoot, 'j4-portal'), workDir: join(ctx.scratchRoot, 'j4-portal-work'), variant: 'web', supabaseUrl: origin, anonKey: credentials.anonKey}));
    if (!build.supabaseConfigAsExpected) throw new Error('portal fixture configuration mismatch');
    macs = await step('start both sandboxed Macs', () => startCommunityMacs(ctx, {shim: shim!, supabaseUrl: origin, extraCaCerts: shim!.ready.caCertPath!, shared, specs}));
    const [a, b] = macs;
    if (!a || !b) throw new Error('two isolated Macs required');
    for (const mac of macs) {
      await step(`prepare and verify shared profile ${mac.spec.label}`, () => prepareSharedProfile(ctx, mac, shared, problems));
      joined.push(await step(`join community ${mac.spec.label}`, () => enterCommunity(ctx, mac, problems)));
    }
    if (problems.length || joined.some(value => !value.joined || !value.endpointId) || joined[0]!.roomId !== joined[1]!.roomId)
      throw new Error(`community preparation: ${problems.join('; ') || 'not joined to the same room'}`);
    const target = joined[1]!.endpointId!;
    const transcript = join(b.root.root, 'j4-cli.log');
    writeFakeCli(b.root, 'claude', fakeAgentCliSource(transcript, 'claude'));

    const pair = await step('enable internet relay on A', () => request(a, '/api/remote-control/internet/enable', {controllerOrigin: PORTAL_ORIGIN}));
    const pairing = pair.pairing?.pairingUrl;
    if (typeof pairing !== 'string') throw new Error('pairing URL missing');
    const pairingSummary = summarizePairing(pairing, {url: origin, anonKey: credentials.anonKey});
    if (!pairingSummary.hasSupabase || !pairingSummary.supabaseUrlMatchesShim || !pairingSummary.anonKeyMatchesShim)
      throw new Error('QR does not contain the fixture Supabase origin and key');
    const profile = ctx.isolatedProfile('j4-web-phone');
    browser = await step('launch headless WebKit', () => launchPhoneBrowser(phoneBrowserEnv(ctx.home, profile.tmp)));
    phone = await Phone.open(browser, {label: 'j4', dist: build.outDir, shimOrigin: origin, vercel: readVercelConfig(ctx.repoRoot)});
    await step('phone signs in', async () => { await phone!.goto(withPortalQuery(pairing, '?tab=workroom')); await phone!.login(member.email, credentials.otpCode); });
    const sas = await step('phone reads SAS', () => phone!.waitForSas(90_000));
    const session = await step('A sees pending SAS', () => until('pending SAS', async () => {
      const status = await request(a, '/api/remote-control/internet/status', {});
      return (status.status?.sessions ?? []).find((s: any) => s.approvalState === 'pending' && s.sasCode) ?? null;
    }));
    if (!/^\d{6}$/.test(sas) || sas !== session.sasCode) throw new Error('phone and A SAS do not match');
    await step('fixture A approves matched SAS', async () => { await request(a, '/api/remote-control/internet/sessions/approve', {sessionId: session.sessionId, expectedSasCode: sas}); });
    ctx.evidence.appendJsonl('j4-web/receipts.jsonl', {step:'sas-approval', scriptedApproval:true, sasMatched:true});
    await step('phone connects', () => phone!.waitForPill('연결됨', 90_000));
    const targets = await request(a, '/api/agent-runtime/targets', {}, 'GET');
    const targetIds = Array.isArray(targets.targets) ? targets.targets.map((t: any) => String(t.targetId)).filter(Boolean) : [];
    if (!targetIds.includes(a.spec.opsProjectId)) throw new Error('A OPS target missing from phone grant candidates');
    await step('fixture A grants phone workspace', async () => { await request(a, '/api/agent-runtime/terminals/access',
      {owner:`internet:${session.sessionId}`, enabled:true, rememberDevice:true, workspaceScopes:[], targetIds}); });
    ctx.evidence.appendJsonl('j4-web/receipts.jsonl', {step:'workspace-grant', scriptedApproval:true, targets:targetIds.length});

    await step('phone selects B from community', async () => {
      await phone!.openWorkroom();
      const tab = phone!.page.getByTestId('remote-workroom-device-switch').getByRole('button', {name: /Fixture Mac B/});
      await tab.waitFor({timeout:90_000}); await tab.click();
      await phone!.page.getByTestId('remote-workroom-device-note').waitFor({timeout:90_000});
    });
    const token = `j4-${ctx.runId.slice(-6).toLowerCase()}`;
    await step('phone opens B project and starts one fake CLI', async () => {
      await phone!.startWorkroomTask(b.spec.projectName, 'claude', 90_000, true);
      await phone!.waitForWorkroomText('REMOTE_READY', 90_000);
    });
    await step('phone sends one command and receives B output', async () => {
      await phone!.sendWorkroomInput(token); await phone!.waitForWorkroomText(`RESULT:${token}`, 90_000);
    });
    const transcriptText = existsSync(transcript) ? readFileSync(transcript, 'utf8') : '';
    const starts = transcriptText.split('\n').filter(line => line.startsWith('START ')).length;
    const inputs = transcriptText.split('\n').filter(line => line === `INPUT:${token}`).length;
    if (starts !== 1 || inputs !== 1) throw new Error(`B fake CLI starts=${starts}, token inputs=${inputs}; expected exactly one each`);
    if (await phone.page.getByTestId('workroom-restart').count()) throw new Error('remote workroom exposes restart');
    details.cli = {starts, inputs, outputObserved:true};

    // These two unique requests are never retried: B must refuse both before terminal dispatch.
    for (const [name, extra] of [['bypass', {bypassPermissions:true}], ['resume', {resumeFrom:'fixture-prior-session'}]] as const) {
      const response = await step(`B refuses ${name} escalation`, () => request(a, '/api/agent-dialogue/control', {operation:'call', targetEndpointId:target,
        request:{kind:'terminal', body:{operation:'start', requestId:randomUUID(), targetId:b.spec.projectId, agent:'claude', cols:80, rows:24, ...extra}}}));
      if (response.response?.ok !== false || !String(response.response?.error ?? '').includes('권한 우회')) throw new Error(`${name} was not refused by B`);
    }
    const after = readFileSync(transcript, 'utf8');
    if (after.split('\n').filter(line => line.startsWith('START ')).length !== 1) throw new Error('escalation probe started another CLI');
    result = {status:'pass'};
  } catch (error) {
    const message = redactPairingText((error as Error)?.message ?? String(error)).slice(0, 1200);
    result = error instanceof PhoneBlockedError ? {status:'blocked', reason:message} : {status:'fail', reason:message};
  }
  const phoneSummary = phone ? {label:phone.label, aborted:phone.aborted(), csp:{...phone.csp}, pageErrors:phone.pageErrors,
    dialogs:phone.dialogs, loadedRemote:phone.ledger.some(entry => entry.kind === 'portal' && (entry.target === '/remote/' || entry.target === '/remote'))} : null;
  if (phone) await phone.close();
  if (browser) await browser.close().catch(() => {});
  for (const mac of macs) {
    if (mac.sidecar.child.exitCode === null && forbiddenOpenFiles(mac.sidecar.pid).length) problems.push(`Mac ${mac.spec.label} opened forbidden user files`);
    const effects = summarizeHostSideEffects(readSideEffectLog(mac.sidecar));
    if (effects.refusedByWrapper.length) problems.push(`Mac ${mac.spec.label} attempted forbidden desktop side effects`);
    await mac.sidecar.stop();
  }
  if (shim) {
    await shim.stop(); problems.push(...shim.problems());
    const load = (name: string) => {const file=join(shim!.evidenceDir,name); return existsSync(file) ? JSON.parse(readFileSync(file,'utf8')) : null;};
    const report=load('supabase-shim-report.json'), dialogue=load('dialogue-db.json'), relay=load('relay-db.json');
    if (!report || !dialogue || !relay) problems.push('shim report or database evidence missing');
    else if (result.status === 'pass') {
      problems.push(...judgeShimReport(report,1).problems);
      const expected=macs.map((mac,index)=>({label:mac.spec.label,deviceId:mac.spec.deviceId,endpointId:joined[index]!.endpointId!}));
      problems.push(...judgeDialogueDump(dialogue,{profileId:shared.profileId,macs:expected}).problems);
      const audit=judgeCommunityAudit(dialogue,joined[0]!.endpointId!,joined[1]!.endpointId!); problems.push(...audit.problems); details.communityAudit=audit.counts;
      const sequences=auditRelaySequences(relay.audit?.relay_messages ?? []);
      if (!sequences.rows || sequences.reused || sequences.nonMonotonic || sequences.relaySeqDuplicates) problems.push('relay audit missing or out of order');
      details.relaySequences=sequences;
    }
  }
  if (phoneSummary) problems.push(...judgePhones([phoneSummary]));
  if (result.status === 'pass' && problems.length) result={status:'fail',reason:problems.join('; ').slice(0,1200)};
  details.steps=receipts; details.postProblems=problems; details.phone=phoneSummary;
  ctx.evidence.writeJson('j4-web/summary.json',{...result,labels,details});
  return {...result, labels, details, artifacts:['j4-web/summary.json','j4-web/receipts.jsonl','supabase-shim/j4-web/dialogue-db.json','supabase-shim/j4-web/relay-db.json','supabase-shim/j4-web/supabase-shim-report.json']};
}
export const lane: LaneDefinition = {id:LANE_ID,title:'J4-COMMUNITY-WEB — phone → A → community → B',run:runCommunityWebJourney};
