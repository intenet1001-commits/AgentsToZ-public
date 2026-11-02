import {expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {catalogEntry, resolveLane, unregisterLane} from '../scripts/emulator-e2e';
import {barModelWithoutPlacement, checkHostSourceList, hostSourceList, laneOutcomeFromReport, NM_GATE_EXTENDED, NM_GATE_REQUIRED} from '../scripts/emulator-e2e/screenFixtureHost';
import {controllerFixtureOutcome} from '../scripts/emulator-e2e/screenControllerLane';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
const root = resolve(import.meta.dir, '..');
test('j3b is registered, fixture only and retains the OS-effect gates', async () => {
  expect(catalogEntry('j3b').kind).toBe('unattended');
  const lane = await resolveLane('j3b'); expect(lane?.id).toBe('j3b'); unregisterLane('j3b');
  const list = checkHostSourceList(hostSourceList()); expect(list.passed).toBe(true);
  expect(list.fromScreenHost.sort()).toEqual(['HostStreamer.swift', 'ScreenSessionBarModel.swift', 'ScreenSessionInputHold.swift'].sort());
  expect(NM_GATE_REQUIRED).toContain('CGEventPost'); expect(NM_GATE_EXTENDED).toContain('SecItemAdd');
  const host = readFileSync(join(root, 'native/screen-control/Tests/Fixtures/ScreenFixtureHost/main.swift'), 'utf8');
  expect(host).toContain('accepting: options.mode == .controller ? [.controller] : [.phone]');
  expect(host).toContain('ScreenControlProtocol.phoneVersion');
  const viewer = readFileSync(join(root, 'native/screen-control/Tests/Fixtures/ScreenFixtureHost/Viewer/main.swift'), 'utf8');
  expect(viewer).toContain('peerClass: peer');
});
test('fixture copies the exact production state-model prefix and refuses an altered excluded suffix', () => {
  const source = readFileSync(join(root, 'native/screen-control/Sources/ScreenHost/ScreenSessionBarModel.swift'), 'utf8');
  const prefix = barModelWithoutPlacement(source);
  expect(source.startsWith(prefix)).toBe(true); expect(prefix).toContain('public enum ScreenSessionBarText');
  expect(prefix).not.toContain('public enum ScreenSessionBarPlacement');
  expect(() => barModelWithoutPlacement(source + '\n// changed')).toThrow();
});

test('J3B retains fixture failures and reports the human Viewer as blocked even when fixtures pass',()=>{
  for(const status of ['pass','fail','blocked'] as const){
    const outcome=controllerFixtureOutcome({status,...(status==='pass'?{}:{reason:'fixture unavailable'}),details:{fixture:'only'}});
    expect(outcome.status).toBe(status);expect(outcome.details?.humanViewer).toMatchObject({status:'blocked'});
    expect(outcome.labels?.standIn.join(' ')).toContain('actual ScreenService');
  }
});
test('separate selfcheck and J3B evidence keeps controller receipts under the right lane',()=>{
  const root=mkdtempSync(join(tmpdir(),'wp13-evidence-'));
  try{
    for(const dir of ['screen-host','screen-host-j3b']){
      mkdirSync(join(root,dir,'controller'),{recursive:true});
      writeFileSync(join(root,dir,'selfcheck-report.json'),'{}');
      writeFileSync(join(root,dir,'controller','host-receipts.jsonl'),'{}');
      const report={status:'pass',checks:[],evidenceDir:join(root,dir),seconds:1} as any;
      const result=laneOutcomeFromReport(report,root);
      expect(result.artifacts).toContain(join(dir,'controller','host-receipts.jsonl'));
      expect(result.artifacts).toContain(join(dir,'selfcheck-report.json'));
    }
  }finally{rmSync(root,{recursive:true,force:true});}
});
