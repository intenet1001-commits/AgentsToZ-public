/** The 3b fixture exercises controller protocol 5 with synthetic capture and no human screen session. */
import type {LaneDefinition} from '../emulator-e2e';
import {runScreenFixtureLane} from './screenFixtureHost';
import type {LaneOutcome} from './evidence';

/** A fixture pass leaves the human Viewer explicitly blocked; preserve every failure and block. */
export function controllerFixtureOutcome(result: LaneOutcome): LaneOutcome {
  return {...result, labels: {
    real: ['ScreenViewer core with controller protocol 5, ScreenListener, HostStreamer and the copied production session-bar state-model prefix over fixture loopback.'],
    standIn: ['Software keys, synthetic frames, recorded-only input and scripted model actions; no operating-system screen, input or window.',
      'The human-gated Viewer application, actual ScreenService, biometric approval, and physical click remain untested and require a person.'],
  }, details: {...result.details, humanViewer: {status: 'blocked', reason: 'Human biometric approval and physical input are required.'}}};
}
export const lane: LaneDefinition = {
  id: 'j3b', title: 'J3B — controller protocol 5 and fixture session bar',
  async run(ctx) {
    return controllerFixtureOutcome(await runScreenFixtureLane(ctx, 'screen-host-j3b'));
  },
};
