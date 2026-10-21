import {describe, expect, test} from 'bun:test';
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  activeRmsDbfs, decodeWav, encodeWav, generateChirp, rmsDbfs, samplesForMs, sineWave,
} from '../src/voiceEvalAudio';
import {
  VOICE_EVAL_VARIANTS, assembleArgv, buildRenderSpec, caseInputHashes, clipManifestHash, diffClipManifests,
  levelGains, noiseArgv, renderSpecHash, segmentNormalizeArgv, segmentSayPlan, validateClipManifest, variantArgv,
  type ClipManifest,
} from '../src/voiceEvalSynth';
import {VOICE_EVAL_CORPUS, corpusHash} from '../src/voiceEvalCorpus';
import {renderVoiceEvalClip} from '../scripts/voice-eval-render';

const h = (n: number) => n.toString(16).padStart(64, '0');

describe('pure PCM helpers', () => {
  test('WAV round trip keeps rate, channels and samples', () => {
    const samples = sineWave(48000, 440, 50, 0.5);
    const wav = encodeWav([samples], 48000);
    const back = decodeWav(wav);
    expect(back.sampleRate).toBe(48000);
    expect(back.channels.length).toBe(1);
    expect(back.channels[0]!.length).toBe(samples.length);
    expect(Math.abs(back.channels[0]![100]! - samples[100]!)).toBeLessThan(1 / 32767 + 1e-9);
    expect(() => decodeWav(new Uint8Array(12))).toThrow();
    // ffmpeg writing WAV to a pipe leaves the data size unpatched (0xFFFFFFFF): read to the end of the stream.
    const streamed = wav.slice();new DataView(streamed.buffer).setUint32(40, 0xffffffff, true);
    expect(decodeWav(streamed).channels[0]!.length).toBe(samples.length);
  });
  test('RMS maths on synthetic arrays', () => {
    expect(rmsDbfs(sineWave(48000, 1000, 1000, 1))).toBeCloseTo(-3.0103, 2);
    expect(rmsDbfs(new Float32Array(480))).toBe(-Infinity);
    const square = new Float32Array(4800).map((_, i) => (i % 2 ? 0.5 : -0.5));
    expect(rmsDbfs(square)).toBeCloseTo(-6.0206, 3);
    // Active level ignores silence: a tone padded with long silence keeps the tone's level.
    const padded = new Float32Array(96000);padded.set(sineWave(48000, 1000, 500, 0.5));
    expect(activeRmsDbfs(padded, 48000)).toBeCloseTo(rmsDbfs(sineWave(48000, 1000, 500, 0.5)), 1);
    expect(rmsDbfs(padded)).toBeLessThan(activeRmsDbfs(padded, 48000) - 5);
  });
  test('silence in ms maps to exact samples; the chirp is deterministic', () => {
    expect(samplesForMs(2500, 48000)).toBe(120000);
    expect(samplesForMs(3000, 24000)).toBe(72000);
    const a = generateChirp(16000, {f0Hz: 1000, f1Hz: 4000, durationMs: 120, amplitude: 0.5});
    const b = generateChirp(16000, {f0Hz: 1000, f1Hz: 4000, durationMs: 120, amplitude: 0.5});
    expect(a.length).toBe(1920);
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});

describe('say + ffmpeg plans are pure argv (no shell, text never on the command line)', () => {
  test('segment say plan writes text to files and passes -f', () => {
    const item = VOICE_EVAL_CORPUS.items.find(i => i.id === 'ko-pause-01')!;
    const plan = segmentSayPlan(item.segments, 'Yuna', '/tmp/x', 'ko-pause-01_main');
    expect(plan.files).toHaveLength(2);
    expect(plan.files[0]!.content).toBe('팔 더하기 칠에서');
    for (const argv of plan.commands) {
      expect(argv[0]).toBe('/usr/bin/say');
      expect(argv).toContain('-f');
      expect(argv.join(' ')).not.toContain('더하기');
    }
    expect(plan.commands[0]).toEqual(['/usr/bin/say', '-v', 'Yuna', '-f', '/tmp/x/ko-pause-01_main-0.txt', '-o', '/tmp/x/ko-pause-01_main-0.aiff']);
    expect(() => segmentSayPlan(item.segments, '-o /etc/x', '/tmp/x', 'p')).toThrow();
    expect(() => segmentSayPlan(item.segments, 'Yuna', '/tmp/x', '../escape')).toThrow();
  });
  test('normalize, assemble, noise and variant argv', () => {
    expect(segmentNormalizeArgv('ffmpeg', '/d/a.aiff', '/d/a.wav', 48000))
      .toEqual(['ffmpeg', '-hide_banner', '-nostdin', '-loglevel', 'error', '-n', '-i', '/d/a.aiff',
        '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', '/d/a.wav']);
    const assemble = assembleArgv('ffmpeg', {inputs: ['/d/chirp.wav', '/d/s0.wav', '/d/s1.wav'], padAfterMs: [0, 2500, 0], sampleRate: 48000, out: '/d/clean.wav'});
    const graph = assemble[assemble.indexOf('-filter_complex') + 1]!;
    expect(graph).toContain('[1:a]aresample=48000,aformat=sample_fmts=s16:channel_layouts=mono,apad=pad_len=120000[a1]');
    expect(graph).toContain('[2:a]aresample=48000,aformat=sample_fmts=s16:channel_layouts=mono[a2]');
    expect(graph.endsWith('[a0][a1][a2]concat=n=3:v=0:a=1[out]')).toBe(true);
    expect(assemble.slice(-8)).toEqual(['-map', '[out]', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', '/d/clean.wav'].slice(-8));
    const noise = noiseArgv('ffmpeg', {variant: 'pink10', durationMs: 4000, sampleRate: 48000, out: '/d/n.wav'})!;
    expect(noise.join(' ')).toContain(`anoisesrc=color=pink:seed=${VOICE_EVAL_VARIANTS.pink10.noise!.seed}:sample_rate=48000:amplitude=0.5:duration=4.000`);
    expect(noiseArgv('ffmpeg', {variant: 'clean', durationMs: 4000, sampleRate: 48000, out: '/d/n.wav'})).toBeNull();
    const mixed = variantArgv('ffmpeg', {clean: '/d/c.wav', noise: '/d/n.wav', speechGainDb: 3.25, noiseGainDb: -12.5, sampleRate: 48000, out: '/d/v.wav'});
    expect(mixed[mixed.indexOf('-filter_complex') + 1]).toBe('[0:a]volume=3.250dB[s];[1:a]volume=-12.500dB[n];[s][n]amix=inputs=2:normalize=0:duration=first[out]');
    const plain = variantArgv('ffmpeg', {clean: '/d/c.wav', noise: null, speechGainDb: -22, noiseGainDb: null, sampleRate: 48000, out: '/d/v.wav'});
    expect(plain).toContain('volume=-22.000dB');
  });
  test('level gains: speech to the variant level, noise at the requested SNR', () => {
    expect(levelGains('clean', -30, null)).toEqual({speechGainDb: 7, noiseGainDb: null});
    expect(levelGains('quiet', -30, null)).toEqual({speechGainDb: -15, noiseGainDb: null});
    // Speech ends at -23; pink 10 dB SNR puts noise at -33 from a measured -10 → -23 dB.
    expect(levelGains('pink10', -30, -10)).toEqual({speechGainDb: 7, noiseGainDb: -23});
    expect(() => levelGains('pink10', -30, null)).toThrow();
    expect(() => levelGains('clean', -Infinity, null)).toThrow();
  });
});

describe('clip manifest', () => {
  const spec = buildRenderSpec({sampleRate: 48000, chirp: true, tools: {say: 'macOS 26.0', ffmpeg: '7.1.1'}});
  const manifest = (): ClipManifest => ({
    schemaVersion: 1, corpusVersion: VOICE_EVAL_CORPUS.version, corpusHash: corpusHash(VOICE_EVAL_CORPUS),
    renderSpec: spec, renderSpecHash: renderSpecHash(spec),
    clips: [
      {clipId: 'ko-num-01.Yuna.clean.main', caseId: 'ko-num-01', role: 'main', voice: 'Yuna', variant: 'clean', sha256: h(1),
        durationMs: 2100, sampleRate: 48000, speechStartMs: 520, peakDbfs: -4.2, clippedSamples: 0},
      {clipId: 'ko-num-02.Yuna.clean.main', caseId: 'ko-num-02', role: 'main', voice: 'Yuna', variant: 'clean', sha256: h(2),
        durationMs: 2400, sampleRate: 48000, speechStartMs: 520, peakDbfs: -3.9, clippedSamples: 0},
    ],
  });
  test('validates, hashes deterministically and carries no text or paths', () => {
    const m = manifest();
    expect(() => validateClipManifest(m)).not.toThrow();
    expect(clipManifestHash(m)).toBe(clipManifestHash(JSON.parse(JSON.stringify(m))));
    const json = JSON.stringify(m);
    expect(json).not.toContain('더하기');
    expect(json).not.toMatch(/\/Users\/|\/tmp\//);
    const dup = manifest();dup.clips[1]!.clipId = dup.clips[0]!.clipId;
    expect(() => validateClipManifest(dup)).toThrow();
    const unknown = manifest();(unknown.clips[0] as any).caseId = 'nope-01';
    expect(() => validateClipManifest(unknown)).toThrow();
    const extra = manifest();(extra.clips[0] as any).text = '칠 더하기 팔은?';
    expect(() => validateClipManifest(extra)).toThrow();
  });
  test('a regenerated clip with a different hash is reported, never silently reused', () => {
    const a = manifest(), b = manifest();
    b.clips[1]!.sha256 = h(9);
    expect(diffClipManifests(a, b)).toEqual({sameSpec: true, changed: ['ko-num-02.Yuna.clean.main'], added: [], removed: []});
    const c = manifest();c.renderSpec = buildRenderSpec({sampleRate: 24000, chirp: true, tools: {say: 'macOS 26.0', ffmpeg: '7.1.1'}});
    c.renderSpecHash = renderSpecHash(c.renderSpec);
    expect(diffClipManifests(a, c).sameSpec).toBe(false);
    expect(caseInputHashes(a, {voice: 'Yuna', variant: 'clean'}).get('ko-num-02')).toBe(h(2));
  });
});

const tools = existsSync('/usr/bin/say') && ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find(existsSync);
(tools ? test : test.skip)('integration: one two-segment item renders to exact length at 48 kHz mono', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-eval-synth-'));
  try {
    const item = VOICE_EVAL_CORPUS.items.find(i => i.id === 'ko-pause-02')!;
    const first = await renderVoiceEvalClip({item, voice: 'Yuna', variant: 'clean', dir, ffmpeg: tools as string, sampleRate: 48000, chirp: true});
    const wav = decodeWav(readFileSync(first.path));
    expect(wav.sampleRate).toBe(48000);
    expect(wav.channels.length).toBe(1);
    // chirp + gap + segment 0 + 3000 ms pause + segment 1, to the sample.
    expect(Math.abs(wav.channels[0]!.length - first.expectedSamples)).toBeLessThanOrEqual(1);
    expect(first.entry.speechStartMs).toBe(520);
    const second = await renderVoiceEvalClip({item, voice: 'Yuna', variant: 'clean', dir: join(dir, 'again'), ffmpeg: tools as string, sampleRate: 48000, chirp: true});
    // Reported, not assumed: `say` is not guaranteed byte-identical across runs.
    console.log(JSON.stringify({sayRenderIdenticalAcrossRuns: first.entry.sha256 === second.entry.sha256}));
  } finally {rmSync(dir, {recursive: true, force: true});}
}, 60_000);
