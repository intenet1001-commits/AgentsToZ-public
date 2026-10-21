import {describe, expect, test} from 'bun:test';
import {concatSamples, dbToLinear, generateChirp, samplesForMs, sineWave} from '../src/voiceEvalAudio';
import {
  DEFAULT_TIMING_PARAMS, analyzeCapture, findChirps, speechSegments, timingClockHash, timingMethodHash,
} from '../src/voiceBenchmarkTiming';
import {decodeCaptureArgv} from '../scripts/analyze-voice-benchmark-capture';

const SR = 16000, FRAME = DEFAULT_TIMING_PARAMS.frameMs;
const silence = (ms: number) => new Float32Array(samplesForMs(ms, SR));
const tone = (ms: number, hz = 440, amplitude = 0.3) => sineWave(SR, hz, ms, amplitude);
const chirp = () => generateChirp(SR, DEFAULT_TIMING_PARAMS.chirp);
/** Deterministic white noise at a given RMS. */
function noise(ms: number, rmsDb: number, seed = 7) {
  const out = new Float32Array(samplesForMs(ms, SR));let s = seed;
  const rand = () => {s = (s * 1664525 + 1013904223) >>> 0;return s / 2 ** 32 * 2 - 1;};
  const scale = dbToLinear(rmsDb) * Math.sqrt(3);
  for (let i = 0; i < out.length; i++) out[i] = rand() * scale;
  return out;
}
const mix = (a: Float32Array, b: Float32Array) => {const out = new Float32Array(Math.max(a.length, b.length));
  for (let i = 0; i < out.length; i++) out[i] = (a[i] ?? 0) + (b[i] ?? 0);return out;};
/** Stimulus clip as rendered: chirp, 400 ms gap, speech. */
const stimulusClip = (speechMs: number) => concatSamples([chirp(), silence(400), tone(speechMs, 300, 0.25)]);
const clipMs = (speechMs: number) => DEFAULT_TIMING_PARAMS.chirp.durationMs + 400 + speechMs;

describe('acoustic timing from one recording', () => {
  test('chirp + 1.2 s tone + 800 ms silence + response → latency 800 ms ± 1 frame', () => {
    const capture = concatSamples([silence(250), stimulusClip(1200), silence(800), tone(1000, 700, 0.3), silence(500)]);
    const result = analyzeCapture({sampleRate: SR, stimulus: capture, product: null, stimulusDurationMs: clipMs(1200)});
    expect(result.anchorMs).toBeCloseTo(250, 0);
    expect(result.response.kind).toBe('response');
    if (result.response.kind !== 'response') throw Error();
    expect(Math.abs(result.response.latencyMs - 800)).toBeLessThanOrEqual(FRAME);
    expect(findChirps(capture, SR, DEFAULT_TIMING_PARAMS.chirp, DEFAULT_TIMING_PARAMS.chirpThreshold)).toHaveLength(1);
  });
  test('no response segment gives null latency, never 0', () => {
    const capture = concatSamples([silence(250), stimulusClip(1200), silence(3000)]);
    const result = analyzeCapture({sampleRate: SR, stimulus: capture, product: null, stimulusDurationMs: clipMs(1200)});
    expect(result.response).toEqual({kind: 'no-response', latencyMs: null});
  });
  test('a response overlapping the stimulus is an overlap, not a negative latency', () => {
    const stimulus = concatSamples([silence(250), stimulusClip(1200), silence(2000)]);
    const productTalk = concatSamples([silence(250 + clipMs(1200) - 400), tone(1500, 700, 0.3)]);
    const single = analyzeCapture({sampleRate: SR, stimulus: mix(stimulus, productTalk), product: null, stimulusDurationMs: clipMs(1200)});
    expect(single.response.kind).toBe('overlap');
    expect((single.response as any).latencyMs).toBeNull();
    const separate = analyzeCapture({sampleRate: SR, stimulus, product: productTalk, stimulusDurationMs: clipMs(1200)});
    expect(separate.response.kind).toBe('overlap');
  });
  test('a -50 dBFS noise floor with a -40 dBFS threshold produces no false segment', () => {
    const floor = noise(3000, -50);
    expect(speechSegments(floor, SR, DEFAULT_TIMING_PARAMS)).toEqual([]);
    const capture = mix(concatSamples([silence(250), stimulusClip(1200), silence(2000)]), noise(250 + clipMs(1200) + 2000, -50));
    const result = analyzeCapture({sampleRate: SR, stimulus: capture, product: null, stimulusDurationMs: clipMs(1200)});
    expect(result.response.kind).toBe('no-response');
    // The chirp is still found under the noise floor.
    expect(result.anchorMs).toBeCloseTo(250, 0);
  });
  test('no chirp means no clock: nothing is measured', () => {
    const capture = concatSamples([silence(300), tone(1200), silence(800), tone(800, 700)]);
    const result = analyzeCapture({sampleRate: SR, stimulus: capture, product: null, stimulusDurationMs: 1720});
    expect(result).toMatchObject({anchorMs: null, response: {kind: 'no-anchor', latencyMs: null}});
  });
  test('the same input always gives the same output', () => {
    const capture = mix(concatSamples([silence(250), stimulusClip(900), silence(600), tone(700, 700, 0.3)]), noise(3200, -55, 11));
    const a = analyzeCapture({sampleRate: SR, stimulus: capture, product: null, stimulusDurationMs: clipMs(900)});
    const b = analyzeCapture({sampleRate: SR, stimulus: capture.slice(), product: null, stimulusDurationMs: clipMs(900)});
    expect(b).toEqual(a);
  });
  test('interrupt: barge-in onset → product stop, and resume after the barge-in ends (separate tracks)', () => {
    // Product answers 700 ms after the stimulus, is interrupted 1.0 s later, stops 450 ms after the barge-in
    // began, then resumes 600 ms after the barge-in ends.
    const stimEnd = 250 + clipMs(1000), respond = stimEnd + 700, barge = respond + 1000;
    const stimulus = concatSamples([silence(250), stimulusClip(1000), silence(barge - stimEnd), tone(800, 300, 0.25), silence(3000)]);
    const product = concatSamples([silence(respond), tone(barge + 450 - respond, 700), silence(800 - 450 + 600), tone(900, 700), silence(1000)]);
    const result = analyzeCapture({sampleRate: SR, stimulus, product, stimulusDurationMs: clipMs(1000), bargeIn: {durationMs: 800}});
    expect(result.separation).toBe('separate-tracks');
    expect(result.response.kind).toBe('response');
    expect(Math.abs((result.response as any).latencyMs - 700)).toBeLessThanOrEqual(FRAME);
    expect(result.interrupt?.kind).toBe('stopped');
    expect(Math.abs((result.interrupt as any).latencyMs - 450)).toBeLessThanOrEqual(FRAME);
    expect(result.resume?.kind).toBe('resumed');
    expect(Math.abs((result.resume as any).latencyMs - 600)).toBeLessThanOrEqual(FRAME);
  });
  test('single track cannot separate voices: a stop inside the barge-in is only an upper bound', () => {
    const stimEnd = 250 + clipMs(1000), respond = stimEnd + 700, barge = respond + 1000;
    const stimulus = concatSamples([silence(250), stimulusClip(1000), silence(barge - stimEnd), tone(800, 300, 0.25), silence(3000)]);
    const product = concatSamples([silence(respond), tone(barge + 450 - respond, 700), silence(4000)]);
    const result = analyzeCapture({sampleRate: SR, stimulus: mix(stimulus, product), product: null, stimulusDurationMs: clipMs(1000),
      bargeIn: {durationMs: 800, atMs: barge}});
    expect(result.separation).toBe('single-track');
    expect(result.interrupt?.kind).toBe('bounded');
    expect((result.interrupt as any).latencyMs).toBeNull();
    expect(Math.abs((result.interrupt as any).atMostMs - 800)).toBeLessThanOrEqual(FRAME);
    // Without the barge-in time a single track cannot be read at all.
    const blind = analyzeCapture({sampleRate: SR, stimulus: mix(stimulus, product), product: null, stimulusDurationMs: clipMs(1000), bargeIn: {durationMs: 800}});
    expect(blind.interrupt).toEqual({kind: 'unmeasurable', latencyMs: null});
  });
  test('method and clock definitions are hashed', () => {
    expect(timingMethodHash(DEFAULT_TIMING_PARAMS)).toMatch(/^[a-f0-9]{64}$/);
    expect(timingMethodHash({...DEFAULT_TIMING_PARAMS, onDbfs: -35})).not.toBe(timingMethodHash(DEFAULT_TIMING_PARAMS));
    expect(timingClockHash('response')).not.toBe(timingClockHash('interrupt'));
    expect(decodeCaptureArgv('ffmpeg', '/d/cap.m4a', 16000)).toEqual(['ffmpeg', '-hide_banner', '-nostdin', '-loglevel', 'error',
      '-i', '/d/cap.m4a', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1']);
  });
});
