import {expect, test} from 'bun:test';
import {
  READ_TOOL_LIMITS, READ_TOOL_OPERATIONS, parseReadToolInput, parseReadToolPlan,
  freezeReadToolPlan, readToolPlanDigest, readToolDigest, readStepEligibility, resolveReadToolInput,
} from '../src/readToolBundle';

const status = {id:'status', input:{operation:'tester.status.read'}};
const report = {id:'report', dependsOn:['status'], condition:'on-report-present',
  input:{operation:'tester.report.read', runId:{stepId:'status', field:'latest.runId'}}};
const runId = '20261024T010203Z-1234abcd';
const good = () => ({steps:[status, report]});

test('T08 batch_allowlist_strict_no_code_or_mutation', () => {
  expect(READ_TOOL_OPERATIONS).toHaveLength(5);
  const inputs = [
    {operation:'project.git.read', pathsLimit:0},
    {operation:'workroom.status.read', sessionsLimit:8},
    {operation:'tester.status.read'},
    {operation:'tester.report.read', runId},
    {operation:'memory.reference.read', role:'dev', query:'current architecture', limit:3},
  ] as const;
  for (const input of inputs) expect(parseReadToolInput(input)).toEqual(input);
  for (const operation of ['tester.start','memory.remember','git.push','eval','shell','app.launch']) {
    expect(() => parseReadToolInput({operation})).toThrow();
  }
  for (const field of ['targetId','path','url','shell','code','eval','credentials','grant','profile','accountId']) {
    expect(() => parseReadToolInput({...inputs[0], [field]:'forbidden'})).toThrow();
    expect(() => parseReadToolPlan({...good(), [field]:'forbidden'})).toThrow();
  }
  for (const input of [
    {operation:'project.git.read',pathsLimit:21}, {operation:'project.git.read',pathsLimit:0.5},
    {operation:'workroom.status.read',sessionsLimit:0}, {operation:'tester.report.read',runId:'/tmp/report'},
    {operation:'memory.reference.read',role:'ops',query:'decision'},
    {operation:'memory.reference.read',role:'dev',query:' '},
    {operation:'memory.reference.read',role:'dev',query:'x'.repeat(701)},
    {operation:'memory.reference.read',role:'dev',query:'https://example.com'},
    {operation:'memory.reference.read',role:'dev',query:'$(curl evil)'},
    {operation:'memory.reference.read',role:'dev',query:'password=hidden'},
  ]) expect(() => parseReadToolInput(input)).toThrow();
});

test('T09 batch_dag_and_typed_refs_validate_before_admission', () => {
  expect(parseReadToolPlan(good()).steps[1]!.dependsOn).toEqual(['status']);
  for (const steps of [
    [], [status,status], [report,status],
    [{...status,dependsOn:['status']}], [{...status,dependsOn:['missing']}],
    [status,{...report,dependsOn:['status','status']}],
    [{id:'git',input:{operation:'project.git.read'}},{...report,dependsOn:['git'],input:{operation:'tester.report.read',runId:{stepId:'git',field:'latest.runId'}}}],
    [status,{...report,dependsOn:[]}],
    [status,{...report,input:{operation:'tester.report.read',runId:{stepId:'status',field:'$.latest.runId'}}}],
    [{...status,condition:'on-current'}],
    [{...status,condition:'eval(true)'}],
    [{...status,condition:null}], [{...status,dependsOn:null}],
    [status,{...report,required:true}],
  ]) expect(() => parseReadToolPlan({steps})).toThrow();
  const chain = Array.from({length:4}, (_,i) => ({id:`s${i}`,input:{operation:'project.git.read'},dependsOn:i?[`s${i-1}`]:[]}));
  expect(parseReadToolPlan({steps:chain.slice(0,3)}).steps).toHaveLength(3);
  expect(() => parseReadToolPlan({steps:chain})).toThrow();
  expect(parseReadToolPlan({steps:Array.from({length:8},(_,i)=>({id:`s${i}`,input:{operation:'project.git.read'}}))}).steps).toHaveLength(8);
  expect(() => parseReadToolPlan({steps:Array.from({length:9},(_,i)=>({id:`s${i}`,input:{operation:'project.git.read'}}))})).toThrow();
});

test('frozen plan is a detached, canonical digest of bounded complete inputs', () => {
  const input = good();
  const frozen = freezeReadToolPlan(input);
  expect(frozen.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(Object.isFrozen(frozen.plan.steps[1]!.input)).toBe(true);
  expect(Object.isFrozen(frozen.plan.steps[1]!.dependsOn)).toBe(true);
  input.steps.reverse();
  expect(frozen.plan.steps[0]!.id).toBe('status');
  expect(readToolPlanDigest(good())).toBe(frozen.digest);
  expect(readToolPlanDigest({steps:[{input:{operation:'tester.status.read'},id:'status',condition:'always',dependsOn:[]},report]})).toBe(frozen.digest);
  expect(readToolPlanDigest({steps:[{id:'git',input:{operation:'project.git.read',pathsLimit:1}}]}))
    .not.toBe(readToolPlanDigest({steps:[{id:'git',input:{operation:'project.git.read',pathsLimit:2}}]}));
  const large={steps:Array.from({length:8},(_,i)=>({id:`m${i}`,input:{operation:'memory.reference.read',role:'dev',query:'한'.repeat(600)}}))};
  expect(() => parseReadToolPlan(large)).toThrow();
  expect(READ_TOOL_LIMITS.controlBytes).toBe(4096);
  expect(READ_TOOL_LIMITS.sourceReadBytes).toBe(1024*1024);
});

test('untrusted object graphs never invoke accessors or serializers', () => {
  let calls=0;
  const accessor=Object.defineProperty({},'steps',{enumerable:true,get(){calls++;return [status];}});
  const serializer={steps:[status],toJSON(){calls++;return good();}};
  expect(()=>readToolDigest(serializer)).toThrow();
  const cycle:any={steps:[]}; cycle.steps.push(cycle);
  const sparse:any[]=[]; sparse.length=1;
  for (const value of [accessor,serializer,cycle,{steps:sparse},new Date(),{steps:[status],extra:undefined},JSON.parse('{"steps":[],"__proto__":{}}')]) {
    expect(() => parseReadToolPlan(value)).toThrow();
  }
  expect(calls).toBe(0);
});

test('operation inputs enforce both ends, integer types, UTF-8 and exact typed reference fields',()=>{
  for(const pathsLimit of [-1,20.1,NaN,Infinity,'1',null])expect(()=>parseReadToolInput({operation:'project.git.read',pathsLimit})).toThrow();
  for(const sessionsLimit of [0,9,-1,1.5])expect(()=>parseReadToolInput({operation:'workroom.status.read',sessionsLimit})).toThrow();
  for(const limit of [0,4,1.5,null])expect(()=>parseReadToolInput({operation:'memory.reference.read',role:'dev',query:'decision',limit})).toThrow();
  for(const query of ['line\ncommand','\ud800','\udfff','/Users/private/project','C:\\secret','eval(1)','api_key=hidden'])expect(()=>parseReadToolInput({operation:'memory.reference.read',role:'dev',query})).toThrow();
  expect(parseReadToolInput({operation:'memory.reference.read',role:'dev',query:'한글😀 decision'})).toEqual({operation:'memory.reference.read',role:'dev',query:'한글😀 decision'});
  for(const runId of [{stepId:'status',field:'latest.runId',path:'other'}, {stepId:'status',field:'runId'}, {stepId:'status'}, {field:'latest.runId'}, 'run-from-other-source'])expect(()=>parseReadToolInput({operation:'tester.report.read',runId})).toThrow();
});

test('evidence may carry tester run IDs only for its declared operation',()=>{
  const step=parseReadToolPlan(good()).steps[1]!;
  for(const evidence of [
    {stepId:'status',operation:'project.git.read',state:'completed',availability:'ready',freshness:'current',latestRunId:runId},
    {stepId:'status',operation:'tester.status.read',state:'completed',availability:'ready',freshness:'current',reportRunId:runId},
    {stepId:'status',operation:'tester.status.read',state:'completed',availability:'ready',freshness:'current',latestRunId:'/tmp/report'},
    {stepId:'status',operation:'tester.start',state:'completed',availability:'ready',freshness:'current'},
  ])expect(()=>readStepEligibility(step,[evidence])).toThrow();
});

test('typed dependency gates skip absent, stale and failed evidence without fabricating results', () => {
  const plan=parseReadToolPlan(good()), step=plan.steps[1]!;
  expect(readStepEligibility(step,[]).state).toBe('wait');
  for (const availability of ['unconfigured','partial','unknown','unavailable'] as const) {
    expect(readStepEligibility(step,[{stepId:'status',operation:'tester.status.read',state:'completed',availability,freshness:'current'}]).state).toBe('skip');
  }
  const evidence={stepId:'status',operation:'tester.status.read' as const,state:'completed' as const,availability:'ready' as const,freshness:'current' as const,latestRunId:runId};
  expect(readStepEligibility(step,[evidence]).state).toBe('run');
  expect(resolveReadToolInput(step,[evidence])).toEqual({operation:'tester.report.read',runId});
  expect(resolveReadToolInput(step,[{stepId:'status',operation:'tester.status.read',state:'completed',availability:'ready',freshness:'current'}])).toBeNull();
  const currentStep=parseReadToolPlan({steps:[status,{id:'git',dependsOn:['status'],condition:'on-current',input:{operation:'project.git.read'}}]}).steps[1]!;
  expect(readStepEligibility(currentStep,[{...evidence,freshness:'stale'}]).state).toBe('skip');
  expect(readStepEligibility(step,[{...evidence,state:'failed'}]).state).toBe('skip');
  expect(() => readStepEligibility(step,[evidence,evidence])).toThrow();
});
