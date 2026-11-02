import {expect,test} from 'bun:test';
import {HARNESS_SOURCE_FILES,fixtureBoundaryNote,lanesForAll,planLane,runEntries,type LaneDefinition} from '../scripts/emulator-e2e';
import {summarize} from '../scripts/emulator-e2e/evidence';
import type {PreflightReport} from '../scripts/emulator-e2e/preflight';

test('all includes the three fixture lanes and fingerprints their implementations',()=>{
  for(const id of ['j2','j3a-process','j3b'] as const)expect(lanesForAll()).toContain(id);
  for(const source of ['scripts/emulator-e2e/computerUseProcessLane.ts','scripts/emulator-e2e/computerUseProcessFixture.ts','scripts/emulator-e2e/screenControllerLane.ts'])expect(HARNESS_SOURCE_FILES).toContain(source);
});
test('3a, 3b and J2 cannot report a pass when preflight blocks their execution',()=>{
  const blocked={status:'blocked',reasons:['outside isolation unavailable']} as unknown as PreflightReport;
  for(const id of ['j2','j3a-process','j3b'] as const){
    const lane:LaneDefinition={id,run:async()=>({status:'pass'})};
    expect(planLane(id,'all',lane,blocked)).toMatchObject({kind:'result',outcome:{status:'blocked'}});
    expect(planLane(id,'single',lane,blocked)).toMatchObject({kind:'result',outcome:{status:'blocked'}});
  }
  expect(summarize(runEntries('all','pass',[{status:'blocked'}],'unchanged'))).toMatchObject({overall:'blocked',passed:false});
  expect(summarize(runEntries('all','pass',[{status:'pass'}],'violated'))).toMatchObject({overall:'fail',passed:false});
});

test('a fixture pass explicitly leaves installed or human steps unverified',()=>{
  expect(fixtureBoundaryNote('j3a-process','pass')).toContain('installed sidecar');
  expect(fixtureBoundaryNote('j3b','pass')).toContain('remain blocked');
  expect(fixtureBoundaryNote('j2','pass')).toContain('physical device');
  expect(fixtureBoundaryNote('j3b','blocked')).toBeNull();
});
