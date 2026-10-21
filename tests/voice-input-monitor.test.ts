import {expect,test} from 'bun:test';
import {VoiceInputMonitor} from '../src/voiceInputMonitor';
test('local microphone meter reports signal and releases context and interval on close',async()=>{
 const original=globalThis.AudioContext;let closed=0,disconnected=0,sampled=0;
 class Context {state='running';resume(){return Promise.resolve();}close(){closed++;return Promise.resolve();}createMediaStreamSource(){return {connect(){},disconnect(){disconnected++;}}}createAnalyser(){return {fftSize:512,getFloatTimeDomainData(data:Float32Array){sampled++;data.fill(.05);},disconnect(){disconnected++;}}}}
 globalThis.AudioContext=Context as any;
 try{const values:(number|null)[]=[];const monitor=new VoiceInputMonitor();monitor.attach({} as MediaStream,v=>values.push(v));await Bun.sleep(230);expect(values[0]).toBeCloseTo(.25);monitor.close();monitor.close();const count=sampled;await Bun.sleep(220);expect(sampled).toBe(count);expect(closed).toBe(1);expect(disconnected).toBe(2);}finally{globalThis.AudioContext=original;}
});
test('unavailable input meter stays unknown rather than reporting false silence',()=>{
 const original=globalThis.AudioContext;globalThis.AudioContext=undefined as any;
 try{const monitor=new VoiceInputMonitor();let value:unknown='unset';monitor.attach({} as MediaStream,v=>value=v);expect(value).toBeNull();monitor.close();}finally{globalThis.AudioContext=original;}
});
