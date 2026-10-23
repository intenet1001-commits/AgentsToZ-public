import {AiTerminalService, type AiTerminalDependencies} from './aiTerminalService';
import {createWorkroomEffortSetting} from './workroomEffortSetting';

/** Same host preference and legacy filename; no duplicated project or CLI defaults. */
export const createProjectAgentEffortSetting = createWorkroomEffortSetting;

/**
 * A registered-project CLI host without a Workroom UI. Embedding apps keep their
 * own terminal/IDE surface and use the existing request/input/read protocol.
 * The caller supplies its authorized AgentsToZ app-data directory and registered
 * target resolver. No model, account, approval or persistent CLI defaults change.
 */
export function createProjectAgentTerminal(input: {
  appDataDir: string;
  dependencies: Omit<AiTerminalDependencies, 'effortAuto'>;
}): AiTerminalService {
  return new AiTerminalService({
    ...input.dependencies,
    effortAuto: createProjectAgentEffortSetting(input.appDataDir),
  });
}
