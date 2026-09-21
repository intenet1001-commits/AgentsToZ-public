import {test,expect} from 'bun:test';
import {dutyReadIsComplete} from '../src/csDutyChatFreshness';
test('accepts the real foreground read and rejects the dropped newer row pattern',()=>{
    expect(dutyReadIsComplete('[trace-ax] read: transcript rows raw=60, unique=30, filtered=30, recent=30')).toBe(true);
    expect(dutyReadIsComplete('[trace-ax] read: transcript rows raw=60, unique=30, filtered=23, recent=23')).toBe(false);
    expect(dutyReadIsComplete('read: transcript rows raw=900, unique=450, filtered=450, recent=300')).toBe(true);
});
test('missing, ambiguous, inconsistent or unsupported diagnostics never report a fresh read',()=>{
    const valid='read: transcript rows raw=60, unique=30, filtered=30, recent=30';
    for(const trace of ['',valid+'\n'+valid,valid.replace('raw=60','raw=20'),valid.replace('recent=30','recent=29'),valid.replace('unique=30','unique=10001')])expect(dutyReadIsComplete(trace)).toBe(false);
});

test('September 10 inactive-window append: reject missing rows, accept complete AX order',()=>{
    expect(dutyReadIsComplete('[trace-ax] read: transcript rows raw=66, unique=33, filtered=31, recent=31')).toBe(false);
    expect(dutyReadIsComplete('[trace-ax] read: transcript rows raw=33, unique=33, filtered=33, recent=33')).toBe(true);
});
