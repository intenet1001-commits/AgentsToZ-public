import {expect,test} from 'bun:test';
import {sourceDevProcessEnvironment} from '../src/devProcessEnvironment';

test('source dev children discard installed sidecar authority and keep only the API test marker',()=>{
  const inherited={
    PORT:'9002',API_PORT:'3002',PORTMGR_PARENT_PID:'123',PORTMGR_BUNDLED_SIDECAR:'1',
    PORTMGR_REMOTE_CONTROL_CAPABILITY:'remote-secret',PORTMGR_AGENT_RUNTIME_CAPABILITY:'runtime-secret',
    PORTMGR_ONBOARDING_CAPABILITY:'onboarding-secret',PORTMGR_WHAT_I_SAID_CAPABILITY:'record-secret',
    PORTMGR_ORCHESTRATION_MISSION_TEST_KEY:'mission-secret',PORTMGR_WHAT_I_SAID_TEST_KEY:'feed-secret',
    AGENTSTOZ_LOCAL_RUNTIME_TEST_MODE:'inherited',
  };
  for(const apiServer of [true,false]){
    const child=sourceDevProcessEnvironment(inherited,apiServer);
    expect(child.PORT).toBe('9002');expect(child.API_PORT).toBe('3002');
    expect(child.PORTMGR_PARENT_PID).toBeUndefined();expect(child.PORTMGR_BUNDLED_SIDECAR).toBeUndefined();
    expect(Object.keys(child).filter(key=>key.startsWith('PORTMGR_')&&/CAPABILITY|TEST_KEY/.test(key))).toEqual([]);
    expect(child.AGENTSTOZ_LOCAL_RUNTIME_TEST_MODE).toBe(apiServer?'1':undefined);
  }
  expect(inherited.PORTMGR_REMOTE_CONTROL_CAPABILITY).toBe('remote-secret');
});
