/** A source development server must never inherit an installed sidecar's authority. */
export function sourceDevProcessEnvironment(
  inherited: NodeJS.ProcessEnv,
  apiServer: boolean,
): NodeJS.ProcessEnv {
  const env = {...inherited};
  delete env.PORTMGR_BUNDLED_SIDECAR;
  delete env.PORTMGR_PARENT_PID;
  delete env.PORTMGR_ORCHESTRATION_MISSION_TEST_KEY;
  delete env.PORTMGR_WHAT_I_SAID_TEST_KEY;
  for (const key of Object.keys(env)) {
    if (/^PORTMGR_[A-Z0-9_]*CAPABILITY$/.test(key)) delete env[key];
  }
  if (apiServer) env.AGENTSTOZ_LOCAL_RUNTIME_TEST_MODE = '1';
  else delete env.AGENTSTOZ_LOCAL_RUNTIME_TEST_MODE;
  return env;
}
