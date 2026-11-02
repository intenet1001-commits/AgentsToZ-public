/** Explicitly blocked placeholder: no capability probe or protected-key model journey exists yet. */
import type {LaneDefinition} from '../emulator-e2e';
export const lane: LaneDefinition = {
  id: 'j2-model', title: 'J2-VIEWER-MODEL — protected key required',
  preconditions: () => ['ScreenViewerModel probe is not implemented and Secure Enclave capability has not been measured.'],
  async run() { return {status: 'blocked', reason: 'The protected-key ScreenViewerModel probe is not implemented.'}; },
};
