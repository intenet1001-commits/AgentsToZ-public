import {test,expect} from 'bun:test';
import {terminalRequestTimeoutMs,MEMORY_PROVIDER_PROBE_UNCONFIRMED} from '../src/aiTerminalRequestPolicy';
test('only exact explicit probes and recovery operations receive their bounded response budgets',()=>{
 const path='/api/agent-runtime/terminals/memory';
 for(const operation of ['prepare-provider','revalidate-provider','review-recovery','execute-recovery','review-recovery-provider','verify-recovery-provider']){
  const body={automaticOperation:operation};expect(terminalRequestTimeoutMs(path,body)).toBe(operation==='execute-recovery'?380_000:80_000);
  for(const other of ['/api/agent-runtime/terminals',path+'/',path+'?probe=1','/api/agent-runtime/tasks/start'])expect(terminalRequestTimeoutMs(other,body)).toBe(15_000);
 }
 for(const body of [null,[],[{automaticOperation:'prepare-provider'}],{keyOperation:'prepare'},{automaticOperation:'status'},{automaticOperation:'enable'},{automaticOperation:'disable'}])expect(terminalRequestTimeoutMs(path,body)).toBe(15_000);
 expect(MEMORY_PROVIDER_PROBE_UNCONFIRMED).toContain('상태를 다시 확인');
 expect(MEMORY_PROVIDER_PROBE_UNCONFIRMED).toContain('껐다 켜거나 바로 재실행하지 말고');
});
