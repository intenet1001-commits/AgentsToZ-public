import {fingerprintBenchmarkProtocol, parseBenchmarkManifest, type BenchmarkManifest, type BenchmarkProtocol, type BenchmarkTrial} from './voiceRemoteBenchmark';
import type {CaptureTiming} from './voiceBenchmarkTiming';

/**
 * Raw capture records + a scoring sheet → BenchmarkTrial rows, with proof tags derived honestly:
 *  - latency for voice metrics comes only from the acoustic analysis (voiceBenchmarkTiming); a missing onset,
 *    an overlap or an unmeasurable stop stays null — never 0, never typed in by hand;
 *  - physicalMicrophone is derived from the recorded input route and is false for any virtual or injected input;
 *  - authenticated / taskStateObserved are true only when the operator explicitly attested them;
 *  - semantics come from the sheet: 'human', or 'deterministic' only when the sheet row names the scorer the
 *    caller pinned (VOICE_EVAL_SCORER_HASH); no row means unscored.
 * The result is validated with the evaluator's own parser before it is returned. Pure: no I/O.
 */
type Side = 'candidate'|'reference';
type Violation = BenchmarkTrial['violations'][number];
export type InputRoute =
  |{kind:'built-in-microphone'|'external-microphone';deviceName?:string}
  |{kind:'virtual'|'file-injection'|'none'|'unknown';deviceName?:string};
export interface CaptureRecord {
  attemptId:string;pairId:string;side:Side;startedAt:number;elapsedMs:number;outcome:BenchmarkTrial['outcome'];
  /** Acoustic analysis of the capture (voice metrics). */
  timing:CaptureTiming|null;
  /** Remote metrics only: latency measured by the remote harness. Must be null for voice metrics. */
  latencyMs:number|null;
  effortCount:number;retryCount:number;manualCommit:boolean;cleanup:BenchmarkTrial['cleanup'];violations:Violation[];
  inputRoute:InputRoute;device:{physical:boolean};
  /** What the operator saw and attested. Absent means not attested. */
  operator:{authenticated?:boolean;taskStateObserved?:boolean};
  captureHash:string|null;
}
export interface ScoreSheetRow {
  attemptId:string;verdict:'correct'|'incorrect';source:'human'|'deterministic';
  expectedFactsHash:string;evidenceHash:string;scorerHash?:string;
}
/** Names of virtual or aggregate audio devices; any match means the "microphone" was not a microphone. */
const VIRTUAL_DEVICE=/blackhole|loopback|soundflower|virtual|aggregate|multi-?output|zoom ?audio|teams audio|vb-?cable|ishowu|rogue amoeba|background music/i;
export function physicalMicrophoneFromRoute(route:InputRoute):boolean {
  return (route.kind==='built-in-microphone'||route.kind==='external-microphone')&&!VIRTUAL_DEVICE.test(route.deviceName??'');
}
const fail=(code:string):never=>{throw new Error(code);};
function voiceLatency(metric:string, timing:CaptureTiming|null):number|null {
  if(!timing)return null;
  if(metric==='response')return timing.response.kind==='response'?timing.response.latencyMs:null;
  if(metric==='interrupt')return timing.interrupt?.kind==='stopped'?timing.interrupt.latencyMs:null;
  if(metric==='resume')return timing.resume?.kind==='resumed'?timing.resume.latencyMs:null;
  return null;
}
export function assembleBenchmarkManifest(input:{protocol:BenchmarkProtocol;captures:CaptureRecord[];sheet:ScoreSheetRow[];
  deterministicScorerHash?:string}):BenchmarkManifest {
  const {protocol}=input,protocolHash=fingerprintBenchmarkProtocol(protocol);
  const pairs=new Map<string,{group:BenchmarkProtocol['groups'][number];caseId:string}>();
  for(const group of protocol.groups)for(const pair of group.pairs)pairs.set(pair.id,{group,caseId:pair.caseId});
  const cases=new Map(protocol.cases.map(c=>[c.id,c]));
  const attempts=new Set(input.captures.map(c=>c.attemptId)),rows=new Map<string,ScoreSheetRow>();
  for(const row of input.sheet){
    if(!attempts.has(row.attemptId))fail('ASSEMBLER_UNKNOWN_ATTEMPT');
    if(rows.has(row.attemptId))fail('ASSEMBLER_DUPLICATE_SCORE');
    if(row.source==='deterministic'&&(!input.deterministicScorerHash||row.scorerHash!==input.deterministicScorerHash))fail('ASSEMBLER_SCORER_NOT_PINNED');
    rows.set(row.attemptId,row);
  }
  const trials:BenchmarkTrial[]=input.captures.map(capture=>{
    const planned=pairs.get(capture.pairId)??fail('ASSEMBLER_UNKNOWN_PAIR');
    const {group,caseId}=planned,benchmarkCase=cases.get(caseId)!;
    let latencyMs:number|null;
    if(group.domain==='voice'){
      if(capture.latencyMs!==null)fail('ASSEMBLER_VOICE_LATENCY_NOT_MEASURED');
      if(capture.timing&&capture.timing.methodHash!==group.methodHash)fail('ASSEMBLER_TIMING_METHOD_MISMATCH');
      latencyMs=voiceLatency(group.metric,capture.timing);
    }else latencyMs=capture.latencyMs;
    const row=rows.get(capture.attemptId);
    const surface:BenchmarkTrial['proof']['surface']=protocol.comparison==='native-product'
      ?capture.side==='candidate'?'agentstoz-native':'codex-native'
      :capture.side==='candidate'?'agentstoz-installed-api':'codex-cli';
    return {
      attemptId:capture.attemptId,pairId:capture.pairId,groupId:group.id,caseId,side:capture.side,protocolHash,
      ...protocol.products[capture.side],inputHash:benchmarkCase.inputHash,
      workloadHash:group.workloadHash,contextHash:group.contextHash,environmentHash:group.environmentHash,
      methodHash:group.methodHash,clockHash:group.clockHash,transport:group.transport,condition:group.condition,
      startedAt:capture.startedAt,outcome:capture.outcome,latencyMs,elapsedMs:capture.elapsedMs,
      effortCount:capture.effortCount,retryCount:capture.retryCount,manualCommit:capture.manualCommit,cleanup:capture.cleanup,
      semantics:row?{verdict:row.verdict,source:row.source,expectedFactsHash:row.expectedFactsHash,evidenceHash:row.evidenceHash}
        :{verdict:'unscored',source:null,expectedFactsHash:null,evidenceHash:null},
      violations:[...capture.violations],
      proof:{surface,physicalDevice:capture.device.physical===true,physicalMicrophone:physicalMicrophoneFromRoute(capture.inputRoute),
        authenticated:capture.operator.authenticated===true,taskStateObserved:capture.operator.taskStateObserved===true,
        captureHash:capture.captureHash},
    };
  });
  return parseBenchmarkManifest({schemaVersion:1,protocol,trials});
}
