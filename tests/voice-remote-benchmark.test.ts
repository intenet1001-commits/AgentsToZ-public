import {describe, expect, test} from 'bun:test';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  BENCHMARK_MAX_BYTES, evaluateBenchmark, fingerprintBenchmarkProtocol, parseBenchmarkManifest,
  type BenchmarkManifest, type BenchmarkProtocol, type BenchmarkTrial,
} from '../src/voiceRemoteBenchmark';

const h = (n: number) => n.toString(16).padStart(64, '0');
const epoch = 1792011000000;
/** Invented evidence for contract tests only; never a product measurement. */
function fixture(): BenchmarkManifest {
  const cases = Array.from({length:61}, (_,i) => ({
    id:'case_' + i, domain:i < 60 ? 'voice' : 'remote',
    language:i < 20 ? 'ko' : i < 40 ? 'en' : i < 60 ? 'mixed' : 'none',
    inputHash:h(100+i), expectedFactsHash:h(200+i),
  }));
  const metrics = ['response','interrupt','resume','workflow','wifi-change','lock-return','host-restart','sustained-1h'];
    const groups = metrics.map((metric,index) => ({
    id:'group_' + index, domain:index < 3 ? 'voice' : 'remote', metric, condition:'normal',
    workloadHash:h(400), contextHash:h(401), environmentHash:h(402), methodHash:h(403),
    clockHash:h(404), transport:index < 3 ? 'webrtc' as const : 'relay' as const,
    pairs:Array.from({length:index === 0 ? 60 : index === 7 ? 1 : 30}, (_,i) => ({
      id:'pair_' + index + '_' + i, caseId:'case_' + (index < 3 ? i % 60 : 60),
    })),
  }));
  const binding = {version:'785.0.0',artifactHash:h(500),sourceHash:h(501),settingsHash:h(502)};
  const protocol = {id:'protocol_fixture',sealedAt:epoch,comparison:'native-product',
    products:{candidate:binding,reference:{...binding,version:'0.162.1'}},cases,groups} as BenchmarkProtocol;
  const protocolHash = fingerprintBenchmarkProtocol(protocol);
  const trials: BenchmarkTrial[] = [];
  for (const [groupIndex,g] of groups.entries()) for (const [i,p] of g.pairs.entries()) {
    for (const side of ['candidate','reference'] as const) {
      const c = cases.find(c => c.id === p.caseId)!;
      const first = i % 2 === 0 ? 'candidate' : 'reference';
      trials.push({
        attemptId:p.id + '_' + side,pairId:p.id,groupId:g.id,caseId:p.caseId,side,protocolHash,
        ...protocol.products[side],inputHash:c.inputHash,
        workloadHash:g.workloadHash,contextHash:g.contextHash,environmentHash:g.environmentHash,
        methodHash:g.methodHash,clockHash:g.clockHash,transport:g.transport,condition:g.condition,
        startedAt:epoch+1000+groupIndex*1000000+i*10000+(side===first ? 0 : g.metric==='sustained-1h' ? 3601000 : 5000),
        outcome:'ok',latencyMs:g.metric==='sustained-1h' ? null : side==='candidate' ? 700 : 1000,
        elapsedMs:g.metric==='sustained-1h' ? 3600000 : 2000,
        effortCount:side==='candidate' ? 2 : 3,retryCount:0,manualCommit:false,cleanup:'confirmed',
        semantics:{verdict:'correct',source:'deterministic',expectedFactsHash:c.expectedFactsHash,evidenceHash:h(600)},
        violations:[],
        proof:{surface:side==='candidate' ? 'agentstoz-native' : 'codex-native',physicalDevice:true,
          physicalMicrophone:g.domain==='voice',authenticated:true,taskStateObserved:true,captureHash:h(700)},
      });
    }
  }
  return {schemaVersion:1,protocol,trials};
}
// Deliberately malformed inputs below must reach the runtime validator.
const first = (m:BenchmarkManifest):any => m.trials[0]!;
const group = (e:ReturnType<typeof evaluateBenchmark>, metric:string) => e.groups.find((g:any) => g.metric===metric)!;
function reseal(m:BenchmarkManifest) {
  const hash=fingerprintBenchmarkProtocol(m.protocol);
  for (const t of m.trials) t.protocolHash=hash;
}
function cli(raw:string, extra:string[] = []) {
  const root=mkdtempSync(join(tmpdir(),'agentstoz-benchmark-contract-'));
  try {
    const path=join(root,'input.json');writeFileSync(path,raw,{mode:0o600});
    const before=readFileSync(path);
    const result=Bun.spawnSync([process.execPath,...extra,join(import.meta.dir,'../benchmark-voice-remote.ts'),path],
      {cwd:root,stdout:'pipe',stderr:'pipe',timeout:10000});
    return {code:result.exitCode,out:result.stdout.toString(),err:result.stderr.toString(),
      unchanged:before.equals(readFileSync(path))};
  } finally {rmSync(root,{recursive:true,force:true});}
}

describe('bounded voice and remote reported-evidence gate', () => {
  test('parse_validBoundedManifest_returnsTypedEvidence', () => {
    const m=fixture(),before=JSON.stringify(m),parsed=parseBenchmarkManifest(m);
    expect(parsed.protocol.id).toBe('protocol_fixture');expect(parsed.trials).toHaveLength(482);
    expect(JSON.stringify(m)).toBe(before);
    const reordered=JSON.parse(JSON.stringify(m.protocol));
    reordered.products.candidate={settingsHash:h(502),sourceHash:h(501),artifactHash:h(500),version:'785.0.0'};
    expect(fingerprintBenchmarkProtocol(reordered)).toBe(fingerprintBenchmarkProtocol(m.protocol));
  });
  test('parse_unknownOrSensitiveFields_rejectsWithoutEcho', () => {
    for(const mutate of [
      (m:any)=>m.transcript='fixture-sensitive-do-not-echo',
      (m:any)=>m.protocol.apiKey='fixture-sensitive-do-not-echo',
      (m:any)=>m.protocol.cases[0].path='fixture-sensitive-do-not-echo',
      (m:any)=>m.trials[0].proof.sdp='fixture-sensitive-do-not-echo',
      (m:any)=>m.trials[0].semantics.reason='fixture-sensitive-do-not-echo',
      (m:any)=>m.protocol.groups[0].pairs[0].text='fixture-sensitive-do-not-echo',
      (m:any)=>Object.defineProperty(m,'toJSON',{value:()=>({schemaVersion:1})}),
      (m:any)=>Object.defineProperty(m.trials[0].proof,'captureHash',{get:()=>h(700),enumerable:true}),
      (m:any)=>Object.defineProperty(m.trials,'toJSON',{value:()=>[]}),
    ]) {
      const m=fixture();mutate(m);
      try {parseBenchmarkManifest(m);throw Error('accepted-sensitive-field');}
      catch(error) {expect(String(error)).not.toContain('fixture-sensitive-do-not-echo');expect(String(error)).toContain('INVALID_BENCHMARK_INPUT');}
    }
  });
  test('parse_budgetBoundaryAndOverflow_enforcesLimits', () => {
    const m=fixture();
    for(let i=61;i<512;i++)m.protocol.cases.push({...m.protocol.cases[60]!,id:'case_'+i,inputHash:h(1000+i)});
    const g=m.protocol.groups[0]!;g.pairs=Array.from({length:2048},(_,i)=>({id:'limit_'+i,caseId:'case_0'}));
    const template=first(m);m.protocol.groups=[g];m.trials=Array.from({length:4096},(_,i)=>({...template,attemptId:'attempt_'+i,
      pairId:'limit_'+Math.floor(i/2),side:i%2===0?'candidate':'reference',caseId:'case_0'}));
    expect(parseBenchmarkManifest(m).trials).toHaveLength(4096);
    m.protocol.cases.push({...m.protocol.cases[0]!,id:'overflow'});
    expect(()=>parseBenchmarkManifest(m)).toThrow('INVALID_BENCHMARK_INPUT');
    m.protocol.cases.pop();m.trials.push({...m.trials[0]!,attemptId:'overflow'});
    expect(()=>parseBenchmarkManifest(m)).toThrow('INVALID_BENCHMARK_INPUT');
  });
  test('parse_nonFiniteNegativeOrFractionalCounts_rejects', () => {
    for(const [field,values] of [['latencyMs',[NaN,Infinity,-1]],['effortCount',[0.5,-1,Infinity]],['retryCount',[0.5,-1]],
      ['elapsedMs',[-1,NaN]],['startedAt',[0.5,NaN]]] as const) for(const value of values) {
      const m=fixture();(first(m) as any)[field]=value;
      expect(()=>parseBenchmarkManifest(m)).toThrow('INVALID_BENCHMARK_INPUT');
    }
  });
  test('parse_invalidEnumsIdsOrHashes_rejects', () => {
    for(const mutate of [(m:any)=>m.protocol.comparison='provider-pilot',(m:any)=>first(m).outcome='passed',
      (m:any)=>first(m).semantics.source='provider',(m:any)=>first(m).attemptId='한글 id',
      (m:any)=>first(m).inputHash='not-a-digest',(m:any)=>first(m).cleanup=true,
      (m:any)=>m.protocol.groups[0].metric='unchecked',(m:any)=>m.protocol.groups[0].domain='remote',
      (m:any)=>first(m).proof.physicalMicrophone=1]) {
      const m=fixture();mutate(m);expect(()=>parseBenchmarkManifest(m)).toThrow('INVALID_BENCHMARK_INPUT');
    }
  });
  test('parse_duplicateAttemptOrConflictingPairCase_rejects', () => {
    const m=fixture();m.trials.push({...m.trials[0]!});expect(()=>parseBenchmarkManifest(m)).toThrow('INVALID_BENCHMARK_INPUT');
    const conflicting=fixture();conflicting.trials[1]!.caseId='case_1';expect(()=>parseBenchmarkManifest(conflicting)).toThrow('INVALID_BENCHMARK_INPUT');
    const side=fixture();side.trials.push({...side.trials[0]!,attemptId:'different_attempt'});
    expect(()=>parseBenchmarkManifest(side)).toThrow('INVALID_BENCHMARK_INPUT');
    const repeated=fixture();repeated.protocol.cases[1]!.inputHash=repeated.protocol.cases[0]!.inputHash;
    expect(()=>parseBenchmarkManifest(repeated)).toThrow('INVALID_BENCHMARK_INPUT');
  });
  test('evaluate_emptyRequiredTrack_returnsNotRun', () => {
    const m=fixture();m.trials=[];const e=evaluateBenchmark(m);
    expect(e.tracks).toEqual({voice:'NOT_RUN',remote:'NOT_RUN',learning:'NOT_RUN'});
    expect(e.productGoalVerified).toBe(false);
  });
  test('evaluate_missingMetricCondition_returnsNotRun', () => {
    const m=fixture();m.trials=m.trials.filter((t:BenchmarkTrial)=>t.groupId!=='group_1');
    expect(group(evaluateBenchmark(m),'interrupt').status).toBe('NOT_RUN');
    m.protocol.groups=m.protocol.groups.filter((g:any)=>g.id!=='group_1');reseal(m);
    expect(group(evaluateBenchmark(m),'interrupt').status).toBe('NOT_RUN');
  });
  test('evaluate_protocolOrSourceBindingMismatch_blocksComparison', () => {
    for(const field of ['protocolHash','version','artifactHash','sourceHash','settingsHash'] as const) {
      const m=fixture();first(m)[field]=field==='version'?'781.0.0':h(888);
      expect(group(evaluateBenchmark(m),'response').status).toBe('BLOCKED');
    }
  });
  test('evaluate_pairConditionMismatch_blocksComparison', () => {
    for(const field of ['workloadHash','contextHash','environmentHash','methodHash','clockHash','transport','condition','inputHash'] as const) {
      const m=fixture();first(m)[field]=field==='transport'?'websocket':field==='condition'?'different':h(888);
      const e=group(evaluateBenchmark(m),'response');expect(e.status).toBe('BLOCKED');expect(e.latency).toBeNull();
    }
    const m=fixture();m.trials[1]!.startedAt=m.trials[0]!.startedAt-1;
    expect(group(evaluateBenchmark(m),'response').status).toBe('BLOCKED');
  });
  test('evaluate_missingOrSelfScoredSemantics_blocksWithoutLatencyStats', () => {
    for(const mutate of [(m:any)=>first(m).semantics={verdict:'unscored',source:null,expectedFactsHash:null,evidenceHash:null},
      (m:any)=>first(m).semantics.source='self',(m:any)=>first(m).semantics.evidenceHash=null]) {
      const m=fixture();mutate(m);const e=group(evaluateBenchmark(m),'response');
      expect(e.status).toBe('BLOCKED');expect(e.latency).toBeNull();
    }
  });
  test('evaluate_semanticDigestMismatch_blocksWithoutLatencyStats', () => {
    const m=fixture();first(m).semantics.expectedFactsHash=h(888);
    const e=group(evaluateBenchmark(m),'response');expect(e.status).toBe('BLOCKED');expect(e.latency).toBeNull();
  });
  test('evaluate_timeoutAndError_retainsFailedAttemptDenominator', () => {
    const m=fixture();first(m).outcome='timeout';first(m).latencyMs=null;first(m).semantics={verdict:'unscored',source:null,expectedFactsHash:null,evidenceHash:null};
    m.trials[2]!.outcome='error';m.trials[2]!.latencyMs=null;
    const e=group(evaluateBenchmark(m),'response');
    expect(e.attempts).toEqual({candidate:60,reference:60});expect(e.failures).toEqual({candidate:2,reference:0});
    expect(e.admittedPairs).toBe(58);expect(e.status).toBe('FAIL');
    expect(e.latency!.candidate.p95).toBe(700);
  });
  test('evaluate_missingCounterpart_retainsAttemptAndBlocks', () => {
    const m=fixture();m.trials.splice(1,1);let e=group(evaluateBenchmark(m),'response');
    expect(e.status).toBe('BLOCKED');expect(e.attempts).toEqual({candidate:60,reference:59});expect(e.missingAttempts).toBe(1);
    m.trials.splice(0,1);e=group(evaluateBenchmark(m),'response');
    expect(e.status).toBe('BLOCKED');expect(e.missingAttempts).toBe(2);expect(e.latency).toBeNull();
  });
  test('evaluate_unsafeOutcome_overridesMissingEvidenceWithFail', () => {
    for(const violation of ['wrong-target','negation-reversed','forbidden-action','duplicate-action','draft-lost','grant-bypass','cleanup-failed']) {
      const m=fixture();m.trials=[first(m)];first(m).semantics={verdict:'unscored',source:null,expectedFactsHash:null,evidenceHash:null};
      if(violation==='cleanup-failed')first(m).cleanup='failed';else first(m).violations=[violation];
      expect(group(evaluateBenchmark(m),'response').status).toBe('FAIL');expect(evaluateBenchmark(m).status).toBe('FAIL');
    }
    const m=fixture();first(m).cleanup='unknown';expect(group(evaluateBenchmark(m),'response').status).toBe('BLOCKED');
  });
  test('evaluate_cliProxyEvidence_neverPassesNativeProductGate', () => {
    const m=fixture();m.protocol.comparison='cli-proxy';
    for(const t of m.trials){t.proof.surface=t.side==='candidate'?'agentstoz-installed-api':'codex-cli';t.proof.physicalMicrophone=false;}
    reseal(m);const e=evaluateBenchmark(m);
    expect(e.tracks.voice).toBe('PASS');expect(e.nativeProductGate.status).toBe('BLOCKED');
    expect(e.status).toBe('BLOCKED');expect(e.productGoalVerified).toBe(false);
    m.protocol.comparison='native-product';reseal(m);
    expect(group(evaluateBenchmark(m),'response').status).toBe('BLOCKED');
  });
  test('evaluate_nativeWithoutPhysicalAuthenticatedProof_blocks', () => {
    for(const field of ['physicalDevice','physicalMicrophone','authenticated','taskStateObserved'] as const) {
      const m=fixture();first(m).proof[field]=false;
      expect(group(evaluateBenchmark(m),'response').status).toBe('BLOCKED');
    }
    const m=fixture();first(m).proof.surface='fixture';expect(group(evaluateBenchmark(m),'response').status).toBe('BLOCKED');
  });
  test('evaluate_insufficientLanguageCorpusOrPairs_blocks', () => {
    for(const language of ['ko','en','mixed']) {
      const m=fixture();const c=m.protocol.cases.find((c:any)=>c.language===language)!;c.language=language==='ko'?'en':'ko';reseal(m);
      expect(evaluateBenchmark(m).tracks.voice).toBe('BLOCKED');
    }
    const m=fixture(),g=m.protocol.groups[1]!;const removed=g.pairs.pop()!;m.trials=m.trials.filter((t:BenchmarkTrial)=>t.pairId!==removed.id);reseal(m);
    expect(group(evaluateBenchmark(m),'interrupt').status).toBe('BLOCKED');
  });
  test('evaluate_admittedPairs_appliesNearestRankAndNoninferiority', () => {
    let m=fixture();expect(evaluateBenchmark(m).tracks.voice).toBe('PASS');
    expect(evaluateBenchmark(m).evaluatedScope).toBe('reported-evidence');
    const candidate=m.trials.filter((t:BenchmarkTrial)=>t.groupId==='group_1'&&t.side==='candidate');
    candidate.forEach((t:BenchmarkTrial,i:number)=>t.latencyMs=i===0?1900:i===1?1400:700);
    let e=group(evaluateBenchmark(m),'interrupt');expect(e.latency!.candidate.p95).toBe(1400);expect(e.status).toBe('FAIL');
    m=fixture();first(m).latencyMs=701;
    // A single outlier is below nearest-rank p95 for 60 pairs; all values above it fail.
    m.trials.filter((t:BenchmarkTrial)=>t.groupId==='group_0'&&t.side==='candidate').forEach((t:BenchmarkTrial)=>t.latencyMs=701);
    expect(group(evaluateBenchmark(m),'response').status).toBe('FAIL');
    m=fixture();first(m).semantics.verdict='incorrect';expect(group(evaluateBenchmark(m),'response').status).toBe('FAIL');
    m=fixture();m.trials.filter((t:BenchmarkTrial)=>t.groupId==='group_0').forEach((t:BenchmarkTrial)=>t.latencyMs=0);
    expect(group(evaluateBenchmark(m),'response').status).toBe('BLOCKED');
    // Equal total failures must not let wrong answers trade against silence.
    m=fixture();const g=m.protocol.groups[1]!;
    for(let i=30;i<40;i++){
      const pairId='semantic_mask_'+i;g.pairs.push({id:pairId,caseId:'case_0'});
      for(const side of ['candidate','reference'] as const){
        const template=m.trials.find(t=>t.groupId===g.id&&t.side===side)!;
        const firstSide=i%2===0?'candidate':'reference';
        m.trials.push({...template,attemptId:pairId+'_'+side,pairId,caseId:'case_0',
          startedAt:epoch+1001000+i*10000+(side===firstSide?0:5000),
          outcome:side==='candidate'?'ok':'timeout',latencyMs:side==='candidate'?700:null,
          semantics:side==='candidate'?{...template.semantics,verdict:'incorrect'}:
            {verdict:'unscored',source:null,expectedFactsHash:null,evidenceHash:null}});
      }
    }
    reseal(m);const masked=group(evaluateBenchmark(m),'interrupt');
    expect(masked.failures).toEqual({candidate:10,reference:10});expect(masked.admittedPairs).toBe(30);
    expect(masked.status).toBe('FAIL');
    expect(masked.semanticErrors).toEqual({candidate:10,reference:0});
    expect(masked.reasons).toContain('SEMANTIC_ERROR_REGRESSION');
    for(const t of m.trials.filter(t=>t.pairId.startsWith('semantic_mask_'))){
      t.outcome=t.side==='candidate'?'timeout':'ok';t.latencyMs=t.side==='candidate'?null:1000;
      t.semantics=t.side==='candidate'?{verdict:'unscored',source:null,expectedFactsHash:null,evidenceHash:null}:
        {verdict:'incorrect',source:'deterministic',expectedFactsHash:h(200),evidenceHash:h(600)};
    }
    const reverse=group(evaluateBenchmark(m),'interrupt');
    expect(reverse.status).toBe('FAIL');expect(reverse.transportErrors).toEqual({candidate:10,reference:0});
    expect(reverse.reasons).toContain('TRANSPORT_ERROR_REGRESSION');
    // A later channel failure must not erase an independently observed wrong answer.
    for(const t of m.trials.filter(t=>t.pairId.startsWith('semantic_mask_'))){
      t.outcome='error';t.latencyMs=null;
      t.semantics={verdict:t.side==='candidate'?'incorrect':'correct',source:'deterministic',
        expectedFactsHash:h(200),evidenceHash:h(600)};
    }
    expect(group(evaluateBenchmark(m),'interrupt').status).toBe('FAIL');
  });
  test('evaluate_remoteJourneyAndLearning_preservesStrictImprovementAndNotRun', () => {
    const m=fixture();let e=evaluateBenchmark(m);expect(e.tracks.remote).toBe('PASS');expect(e.tracks.learning).toBe('NOT_RUN');
    for(const t of m.trials.filter((t:BenchmarkTrial)=>t.groupId==='group_3'&&t.side==='candidate'))t.effortCount=3;
    expect(group(evaluateBenchmark(m),'workflow').status).toBe('FAIL');
    for(const t of m.trials.filter((t:BenchmarkTrial)=>t.groupId==='group_3'&&t.side==='candidate')){t.effortCount=2;t.latencyMs=1000;}
    expect(group(evaluateBenchmark(m),'workflow').status).toBe('FAIL');
    const short=fixture();short.trials.find((t:BenchmarkTrial)=>t.groupId==='group_7')!.elapsedMs=3599999;
    expect(group(evaluateBenchmark(short),'sustained-1h').status).toBe('FAIL');
    const retry=fixture();retry.trials.find((t:BenchmarkTrial)=>t.groupId==='group_3')!.retryCount=1;
    expect(group(evaluateBenchmark(retry),'workflow').status).toBe('FAIL');
  });
});
describe('readonly benchmark file CLI', () => {
  test('cli_validManifest_returnsReportedEvidenceJson', () => {
    const r=cli(JSON.stringify(fixture()));expect(r.code).toBe(0);const e=JSON.parse(r.out);
    expect(e.evaluatedScope).toBe('reported-evidence');expect(e.productGoalVerified).toBe(false);expect(e.tracks.learning).toBe('NOT_RUN');
  });
  test('cli_invalidOrUnreadableManifest_exitsNonzeroWithoutEcho', () => {
    for(const raw of ['{"apiKey":"fixture-sensitive-do-not-echo"}','fixture-sensitive-do-not-echo']) {
      const r=cli(raw);expect(r.code).toBe(65);expect(r.out+r.err).not.toContain('fixture-sensitive-do-not-echo');
    }
    const r=Bun.spawnSync([process.execPath,join(import.meta.dir,'../benchmark-voice-remote.ts'),'/missing/fixture-sensitive-do-not-echo'],
      {stdout:'pipe',stderr:'pipe',timeout:10000});
    expect(r.exitCode).toBe(65);expect(r.stdout.toString()+r.stderr.toString()).not.toContain('fixture-sensitive-do-not-echo');
    const root=mkdtempSync(join(tmpdir(),'agentstoz-benchmark-bytes-'));
    try {
      const m=fixture();m.trials=[];const raw=JSON.stringify(m);
      const r=cli(raw+' '.repeat(BENCHMARK_MAX_BYTES-Buffer.byteLength(raw)));expect(r.code).toBe(3);
      const tooBig=cli(raw+' '.repeat(BENCHMARK_MAX_BYTES-Buffer.byteLength(raw)+1));expect(tooBig.code).toBe(65);
    }finally{rmSync(root,{recursive:true,force:true});}
  });
  test('cli_readonlyInvocation_preservesInputsAndAvoidsRuntimeIo', () => {
    const root=mkdtempSync(join(tmpdir(),'agentstoz-benchmark-guard-'));
    try {
      const preload=join(root,'guard.ts');
      writeFileSync(preload,"globalThis.fetch=(()=>{throw Error('unexpected-network')}) as any;Bun.spawn=(()=>{throw Error('unexpected-runtime')}) as any;Bun.spawnSync=(()=>{throw Error('unexpected-runtime')}) as any;");
      const r=cli(JSON.stringify(fixture()),['--preload',preload]);expect(r.code).toBe(0);expect(r.unchanged).toBe(true);
      expect(r.err).toBe('');expect(r.out).not.toContain('unexpected-');
    } finally {rmSync(root,{recursive:true,force:true});}
  });
});
