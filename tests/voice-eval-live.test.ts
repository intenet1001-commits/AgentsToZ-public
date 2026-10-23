import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {connectVoiceRealtime} from '../src/voiceRealtimeProvider';
import {
  VOICE_EVAL_LIVE_ENV, confirmCondition, liveRunGate, providerEnvironment, runLiveTrials,
  type LiveClip, type LiveTrial, type MediaDriver,
} from '../src/voiceEvalLive';
import {main as liveCli} from '../scripts/voice-eval-live';

const clip = (id: string): LiveClip => ({clipId: id, sha256: id.padEnd(64, '0').replace(/[^a-f0-9]/g, 'a').slice(0, 64), bytes: new Uint8Array(4), durationMs: 1000});
const trial = (id: string, mode: LiveTrial['mode'], audio: LiveTrial['condition']['audio'], caseId = 'ko-num-01'): LiveTrial => ({
  trialId: id, caseId, condition: {id: 'c-' + id, audio}, voice: 'Yuna', variant: 'clean', mode, clip: clip(id),
});
interface Fake {forms: any[]; posts: number; hangups: number; sockets: any[]}
let fake: Fake, originalFetch: typeof fetch, OriginalSocket: typeof WebSocket;
beforeEach(() => {
  fake = {forms: [], posts: 0, hangups: 0, sockets: []};
  originalFetch = globalThis.fetch;OriginalSocket = globalThis.WebSocket;
  class Socket {
    static OPEN = 1;readyState = 1;onopen: any;onmessage: any;onclose: any;onerror: any;sent: string[] = [];
    constructor(public url: string) {fake.sockets.push(this);queueMicrotask(() => this.onopen?.({}));}
    send(data: string) {this.sent.push(data);const event=JSON.parse(data);if(event.type==='conversation.item.retrieve')queueMicrotask(()=>this.emit({type:'conversation.item.retrieved',item:{id:event.item_id,content:[{type:'input_audio'}]}}));}
    close() {}
    emit(event: Record<string, unknown>) {this.onmessage?.({data: JSON.stringify(event)});}
  }
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  globalThis.fetch = (async (url: any, options: any) => {
    if (String(url).endsWith('/hangup')) {fake.hangups++;return new Response(null, {status: 200});}
    fake.posts++;fake.forms.push(JSON.parse((options.body as FormData).get('session') as string));
    return new Response('v=0\r\nanswer', {status: 201, headers: {location: '/v1/realtime/calls/rtc_fixture' + fake.posts}});
  }) as typeof fetch;
});
afterEach(() => {globalThis.fetch = originalFetch;globalThis.WebSocket = OriginalSocket;});

/** A media driver that plays nothing: it scripts what the provider would emit for each clip. */
function scriptedMedia(script: {echo?: boolean; heard: string; answer?: string; tool?: boolean; failPlay?: boolean}, closed: {n: number}): () => MediaDriver {
  return () => ({
    async start(connect) {
      await connect('v=0\r\noffer');
      const socket = fake.sockets.at(-1)!;
      if (script.echo !== false) socket.emit({type: 'session.created', session: fake.forms.at(-1)});
    },
    async play() {
      if (script.failPlay) throw new Error('injected media failure');
      const socket = fake.sockets.at(-1)!;
      socket.emit({type: 'input_audio_buffer.speech_started'});
      socket.emit({type: 'input_audio_buffer.speech_stopped'});
      socket.emit({type: 'conversation.item.input_audio_transcription.completed', item_id: 'i1', transcript: script.heard});
      if (script.tool) socket.emit({type: 'response.function_call_arguments.done', name: 'read_workroom'});
      if (script.answer !== undefined) {
        socket.emit({type: 'response.output_audio.delta', delta: 'AAAA'});
        socket.emit({type: 'response.output_audio_transcript.done', transcript: script.answer});
      }
    },
    async close() {closed.n++;},
  });
}
const gate = (max = 5) => liveRunGate(['--live', '--max-sessions', String(max)], {[VOICE_EVAL_LIVE_ENV]: '1'});

describe('live runner gating (never runs live in tests)', () => {
  test('requires both --live and the environment opt-in, plus a session cap', () => {
    expect(liveRunGate(['--max-sessions', '3'], {[VOICE_EVAL_LIVE_ENV]: '1'})).toEqual({ok: false, reason: 'LIVE_FLAG_MISSING'});
    expect(liveRunGate(['--live', '--max-sessions', '3'], {})).toEqual({ok: false, reason: 'LIVE_ENV_OPT_IN_MISSING'});
    expect(liveRunGate(['--live', '--max-sessions', '3'], {[VOICE_EVAL_LIVE_ENV]: 'true'})).toEqual({ok: false, reason: 'LIVE_ENV_OPT_IN_MISSING'});
    expect(liveRunGate(['--live'], {[VOICE_EVAL_LIVE_ENV]: '1'})).toEqual({ok: false, reason: 'MAX_SESSIONS_MISSING'});
    expect(liveRunGate(['--live', '--max-sessions', '0'], {[VOICE_EVAL_LIVE_ENV]: '1'})).toEqual({ok: false, reason: 'MAX_SESSIONS_MISSING'});
    expect(gate(3)).toEqual({ok: true, maxSessions: 3});
  });
  test('the script refuses before touching credentials, network or the browser', async () => {
    const lines: string[] = [];
    expect(await liveCli(['--max-sessions', '1'], {}, l => lines.push(l))).toBe(77);
    expect(await liveCli(['--live', '--max-sessions', '1'], {}, l => lines.push(l))).toBe(77);
    expect(fake.posts).toBe(0);
    expect(lines.join('\n')).toContain('LIVE_FLAG_MISSING');
  });
  test('runLiveTrials refuses a closed gate and opens nothing', async () => {
    let opened = 0;
    const result = await runLiveTrials({gate: liveRunGate([], {}), trials: [trial('t1', 'ops-answer', {})],
      environment: {open: async () => {opened++;throw Error();}, shutdown: async () => {}}, write: () => {}, log: () => {}});
    expect(result).toMatchObject({refused: 'LIVE_FLAG_MISSING', ran: 0});
    expect(opened).toBe(0);
  });
});

describe('live runner against a mocked provider', () => {
  const env = (media: () => MediaDriver, shutdown = async () => {}) => providerEnvironment({connect: connectVoiceRealtime, key: 'fixture-key',
    model: 'gpt-realtime-2.1', voice: 'marin', media, relay: async text => 'GOT:' + text, shutdown});
  test('the session form carries the requested override and a confirmed echo makes the trial valid', async () => {
    const records: any[] = [], closed = {n: 0};
    const result = await runLiveTrials({gate: gate(), trials: [trial('t1', 'ops-answer', {noiseReduction: 'far_field', transcription: {languages: ['ko', 'en']}})],
      environment: env(scriptedMedia({heard: '칠 더하기 팔은?', answer: '정답은 15입니다.'}, closed)), write: r => records.push(r), log: () => {}, timeoutMs: 300});
    expect(fake.forms[0].audio.input.noise_reduction).toEqual({type: 'far_field'});
    expect(fake.forms[0].audio.input.transcription.languages).toEqual(['ko', 'en']);
    expect(records[0]).toMatchObject({trialId: 't1', conditionConfirmed: 'confirmed', verdict: 'correct', clipSha256: clip('t1').sha256});
    expect(records[0].configHash).toMatch(/^[a-f0-9]{64}$/);
    expect(records[0].speechStoppedToFirstAudioMs).toBeGreaterThanOrEqual(0);
    expect(result.ran).toBe(1);
    expect(closed.n).toBe(1);
    expect(fake.hangups).toBe(1);
  });
  test('without the session echo the trial is invalid and still counted', async () => {
    const records: any[] = [];
    const result = await runLiveTrials({gate: gate(), trials: [trial('t1', 'ops-answer', {noiseReduction: null})],
      environment: env(scriptedMedia({echo: false, heard: '칠 더하기 팔은?', answer: '15'}, {n: 0})), write: r => records.push(r), log: () => {}, timeoutMs: 300});
    expect(records[0]).toMatchObject({conditionConfirmed: 'unconfirmed', verdict: 'invalid', invalidReason: 'CONDITION_UNCONFIRMED'});
    expect(result.verdicts).toEqual({invalid: 1});
    expect(confirmCondition([{type: 'session.updated', session: {audio: {input: {noise_reduction: {type: 'near_field'}, transcription: {}}}}}], {noiseReduction: null}))
      .toBe('mismatch');
  });
  test('relay mode captures the echoed GOT: line and scores the delivered text', async () => {
    const records: any[] = [];
    await runLiveTrials({gate: gate(), trials: [trial('t1', 'relay-delivery', {}, 'ko-neg-01')],
      environment: env(scriptedMedia({heard: '팔 더하기 칠 말고 팔 빼기 칠은?'}, {n: 0})), write: r => records.push(r), log: () => {}, timeoutMs: 300});
    expect(fake.forms[0].audio.input.turn_detection.create_response).toBe(false);
    expect(fake.sockets[0].sent.some((raw:string)=>JSON.parse(raw).type==='conversation.item.retrieve')).toBe(true);
    expect(records[0]).toMatchObject({delivered: 'GOT:팔 더하기 칠 말고 팔 빼기 칠은?', verdict: 'exact'});
    const dropped: any[] = [];
    await runLiveTrials({gate: gate(), trials: [trial('t2', 'relay-delivery', {}, 'ko-neg-01')],
      environment: env(scriptedMedia({heard: '팔 더하기 칠 팔 빼기 칠은?'}, {n: 0})), write: r => dropped.push(r), log: () => {}, timeoutMs: 300});
    expect(dropped[0].verdict).toBe('missing-term');
  });
  test('a tool call is its own verdict; stdout carries counts only, never transcripts', async () => {
    const records: any[] = [], lines: string[] = [];
    await runLiveTrials({gate: gate(), trials: [trial('t1', 'ops-answer', {}), trial('t2', 'ops-answer', {})],
      environment: env(scriptedMedia({heard: '칠 더하기 팔은? 비밀문장', answer: '열다섯입니다 비밀답', tool: true}, {n: 0})),
      write: r => records.push(r), log: l => lines.push(l), timeoutMs: 300});
    expect(records.map(r => r.verdict)).toEqual(['tool-called', 'tool-called']);
    const out = lines.join('\n');
    expect(out).toContain('tool-called');
    for (const secret of ['비밀', '칠 더하기', '열다섯', 'fixture-key']) expect(out).not.toContain(secret);
  });
  test('stops at --max-sessions', async () => {
    const records: any[] = [];
    const result = await runLiveTrials({gate: gate(2), trials: ['a', 'b', 'c'].map(id => trial(id, 'ops-answer', {})),
      environment: env(scriptedMedia({heard: '칠 더하기 팔은?', answer: '15'}, {n: 0})), write: r => records.push(r), log: () => {}, timeoutMs: 300});
    expect(fake.posts).toBe(2);
    expect(result).toMatchObject({ran: 2, stoppedAtCap: true});
    expect(records).toHaveLength(2);
  });
  test('a barge-in interrupts the first response while it is still speaking', async () => {
    // The provider keeps talking until it is interrupted: the first response emits audio but no transcript.done.
    const plays: number[] = [], records: any[] = [];
    const media = (): MediaDriver => ({
      async start(connect) {await connect('v=0\r\noffer');fake.sockets.at(-1)!.emit({type: 'session.created', session: fake.forms.at(-1)});},
      async play() {
        plays.push(performance.now());
        const socket = fake.sockets.at(-1)!;
        socket.emit({type: 'input_audio_buffer.speech_started'});
        if (plays.length === 1) {
          socket.emit({type: 'input_audio_buffer.speech_stopped'});
          socket.emit({type: 'conversation.item.input_audio_transcription.completed', item_id: 'i1', transcript: '일부터 열까지 천천히 세어 줘'});
          socket.emit({type: 'response.output_audio.delta', delta: 'AAAA'});
          return;
        }
        // Interrupted: the counting response ends cut off, then the second question is answered.
        socket.emit({type: 'response.output_audio_transcript.done', transcript: '하나, 둘'});
        socket.emit({type: 'input_audio_buffer.speech_stopped'});
        socket.emit({type: 'conversation.item.input_audio_transcription.completed', item_id: 'i2', transcript: '멈추고, 이 더하기 이는?'});
        socket.emit({type: 'response.output_audio.delta', delta: 'BBBB'});
        socket.emit({type: 'response.output_audio_transcript.done', transcript: '4입니다.'});
      },
      async close() {},
    });
    const t: LiveTrial = {...trial('t1', 'ops-answer', {}, 'ko-int-01'), bargeIn: {clip: clip('t1-barge'), afterResponseOnsetMs: 50}};
    await runLiveTrials({gate: gate(), trials: [t], environment: env(media), write: r => records.push(r), log: () => {}, timeoutMs: 1500});
    expect(plays).toHaveLength(2);
    // The barge-in starts while the first response is still playing, not after the wait for its end times out.
    expect(plays[1]! - plays[0]!).toBeLessThan(700);
    expect(records[0]).toMatchObject({verdict: 'correct', outputTranscripts: ['하나, 둘', '4입니다.']});
  });
  test('shutdown and media close run in finally after an injected error', async () => {
    const closed = {n: 0};let shutdowns = 0;
    const records: any[] = [];
    await runLiveTrials({gate: gate(), trials: [trial('t1', 'ops-answer', {})],
      environment: env(scriptedMedia({heard: 'x', failPlay: true}, closed), async () => {shutdowns++;}), write: r => records.push(r), log: () => {}, timeoutMs: 300});
    expect(records[0]).toMatchObject({verdict: 'invalid', invalidReason: 'TRIAL_ERROR'});
    expect(closed.n).toBe(1);expect(shutdowns).toBe(1);expect(fake.hangups).toBe(1);
    shutdowns = 0;
    await expect(runLiveTrials({gate: gate(), trials: [trial('t2', 'ops-answer', {})],
      environment: env(scriptedMedia({heard: '칠 더하기 팔은?', answer: '15'}, closed), async () => {shutdowns++;}),
      write: () => {throw new Error('disk full');}, log: () => {}, timeoutMs: 300})).rejects.toThrow('disk full');
    expect(shutdowns).toBe(1);
  });
});
