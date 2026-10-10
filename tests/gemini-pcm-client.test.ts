import {expect,test} from 'bun:test';
import {float32ToPcm16Base64} from '../src/geminiPcmClient';

test('browser PCM conversion downsamples to signed 16-bit little endian',()=>{
  const source=new Float32Array(48);source.fill(1,0,16);source.fill(-1,16,32);source.fill(.5,32);
  const raw=Buffer.from(float32ToPcm16Base64(source,48_000,16_000),'base64');expect(raw.length).toBe(32);
  expect(raw.readInt16LE(0)).toBe(32767);expect(raw.readInt16LE(12)).toBe(-32768);expect(raw.readInt16LE(24)).toBeGreaterThan(16000);
});

test('PCM conversion rejects unsupported microphone sample rates',()=>{
  expect(()=>float32ToPcm16Base64(new Float32Array([.1]),8_000)).toThrow('샘플 속도');
});
