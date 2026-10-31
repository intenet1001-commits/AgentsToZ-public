/** One existing tester check owns both voice-window entry and memory-failure recovery journeys. */
for(const script of ['tests/voice-popout-ui.mjs','scripts/check-memory-save-notice-recovery.ts']){
  const child=Bun.spawn([process.execPath,script],{stdout:'inherit',stderr:'inherit',stdin:'ignore'});
  const code=await child.exited;
  if(code!==0)process.exit(code);
}
