import {expect, test} from 'bun:test';
import {readVoiceConsent, readVoiceProvider, writeVoiceConsent, writeVoiceProvider} from '../src/voicePreferences';

const memory = () => { const m = new Map<string, string>(); return {getItem:(k:string)=>m.get(k)??null, setItem:(k:string,v:string)=>{m.set(k,v);}}; };

test('one provider choice serves OPS and every Workroom voice (VOC 2026-09-25)', () => {
  const s = memory();
  expect(readVoiceProvider(s)).toBeNull();
  writeVoiceProvider(s, 'gemini');
  expect(readVoiceProvider(s)).toBe('gemini');
  s.setItem('portmanager-voice-preferences', JSON.stringify({provider: 'other'}));
  expect(readVoiceProvider(s)).toBeNull();
});

test('consent is remembered per provider and can be withdrawn', () => {
  const s = memory();
  expect(readVoiceConsent(s, 'openai')).toBe(false);
  writeVoiceConsent(s, 'openai', true);
  expect(readVoiceConsent(s, 'openai')).toBe(true);
  expect(readVoiceConsent(s, 'gemini')).toBe(false);
  writeVoiceProvider(s, 'gemini');
  expect(readVoiceConsent(s, 'openai')).toBe(true);
  writeVoiceConsent(s, 'openai', false);
  expect(readVoiceConsent(s, 'openai')).toBe(false);
  const broken = {getItem(){throw Error('denied');}, setItem(){throw Error('denied');}};
  expect(readVoiceConsent(broken, 'openai')).toBe(false);
  expect(() => writeVoiceConsent(broken, 'openai', true)).not.toThrow();
});
