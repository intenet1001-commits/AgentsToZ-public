import {expect, test} from 'bun:test';
import {
  parseWorkPackDefinition, workPackDefinitionDigest, reviewWorkPackDefinition,
  inspectWorkPackDefinition, prepareWorkPack, evaluateWorkPackCompletion,
} from '../src/workPack';

const source=()=>({sourceLibraryId:'local-library',accountId:'owner-1',libraryRevision:'library-r1',guideId:'command-1',commandBodyHash:'a'.repeat(64),sourceRevision:'incarnation-1'});
const current=()=>({...source(),kind:'command',presence:'present',virtual:false,provenance:'verified',supported:true});
const definition=()=>({schemaVersion:1,source:source(),definitionRevision:'definition-r1',
  inputs:[{name:'query',type:'string',required:true,maxLength:100},{name:'scope',type:'enum',required:false,options:['narrow','broad'],default:'narrow'},{name:'ack',type:'boolean',required:false,default:false}],
  plan:{steps:[{id:'memory',input:{operation:'memory.reference.read',role:'dev',query:'relevant decisions'}}]},
  inputBindings:[{inputName:'query',stepId:'memory',field:'query'}],
  conditions:[{kind:'step-completed',stepId:'memory'},{kind:'source-current',stepId:'memory'}],
  review:{state:'draft'}});

test('T21 workpack_schema_conditions_do_not_grant_or_assert_pass', () => {
  const parsed=parseWorkPackDefinition(definition());
  expect(inspectWorkPackDefinition(parsed,current()).state).toBe('draft');
  expect(()=>prepareWorkPack(parsed,current(),{query:'architecture'})).toThrow();
  const reviewed=reviewWorkPackDefinition(parsed,current());
  const prepared=prepareWorkPack(reviewed,current(),{query:'architecture'});
  expect(prepared.values).toEqual({query:'architecture',scope:'narrow',ack:false});
  expect(prepared.plan.steps[0]!.input).toEqual({operation:'memory.reference.read',role:'dev',query:'architecture'});
  expect(prepared.definitionDigest).toBe(workPackDefinitionDigest(parsed));
  expect(Object.isFrozen(prepared.plan.steps[0]!.input)).toBe(true);
  expect(Object.isFrozen(prepared.values)).toBe(true);
  const result=evaluateWorkPackCompletion(reviewed,[{stepId:'memory',operation:'memory.reference.read',state:'completed',availability:'ready',freshness:'current'}]);
  expect(result.complete).toBe(true);
  expect(result.meaning).toBe('read-completion-only');
  expect(JSON.stringify(result)).not.toContain('PASS');
  for (const freshness of ['unknown','stale'] as const) expect(evaluateWorkPackCompletion(reviewed,[{stepId:'memory',operation:'memory.reference.read',state:'completed',availability:'ready',freshness}]).complete).toBe(false);
  for(const values of [{},{query:null},{query:'x'.repeat(101)},{query:'ok',targetId:'other'},{query:'ok',ack:'true'},{query:'ok',scope:'all'},{query:'https://example.com'}])expect(()=>prepareWorkPack(reviewed,current(),values)).toThrow();
});

test('definition schema rejects code, copied body, authority, arbitrary conditions and bindings', () => {
  for(const key of ['body','command','targetId','role','grant','profile','credentials','path','url','runReceipt'])expect(()=>parseWorkPackDefinition({...definition(),[key]:'forbidden'})).toThrow();
  for(const patch of [
    {schemaVersion:2},
    {source:{...source(),accountId:'/Users/person'}},
    {conditions:[{kind:'tests-pass',stepId:'memory'}]},
    {conditions:[{kind:'step-completed',stepId:'missing'}]},
    {conditions:[]},
    {inputs:[{name:'targetId',type:'string',required:true,maxLength:100}]},
    {inputs:[{name:'query',type:'string',required:true,maxLength:701}]},
    {inputs:[{name:'query',type:'string',required:true,maxLength:2,default:'long'}]},
    {inputs:[{name:'query',type:'enum',required:true,options:['a','a']}]},
    {inputBindings:[{inputName:'query',stepId:'memory',field:'role'}]},
    {inputBindings:[{inputName:'ack',stepId:'memory',field:'query'}]},
    {inputBindings:[{inputName:'missing',stepId:'memory',field:'query'}]},
  ])expect(()=>parseWorkPackDefinition({...definition(),...patch})).toThrow();
});

test('T16 source scope, body hash and definition revision are bound to review digest', () => {
  const reviewed=reviewWorkPackDefinition(definition(),current());
  expect(inspectWorkPackDefinition(reviewed,current()).state).toBe('reviewed');
  for(const key of ['accountId','sourceLibraryId','guideId','commandBodyHash','sourceRevision'] as const){
    const next={...current(),[key]:key==='commandBodyHash'?'b'.repeat(64):'different'};
    expect(inspectWorkPackDefinition(reviewed,next).state).toBe('stale');
    expect(()=>prepareWorkPack(reviewed,next,{query:'architecture'})).toThrow();
  }
  for(const patch of [{definitionRevision:'definition-r2'},{conditions:[{kind:'step-completed',stepId:'memory'}]}])expect(()=>parseWorkPackDefinition({...reviewed,...patch})).toThrow();
  expect(workPackDefinitionDigest(definition())).not.toBe(workPackDefinitionDigest({...definition(),definitionRevision:'definition-r2'}));
  // Library-wide pin/reorder/title revisions do not alter the referenced command's meaning.
  expect(inspectWorkPackDefinition(reviewed,{...current(),libraryRevision:'library-r2'}).state).toBe('reviewed');
});

test('T18 source edits, deletions, reimports and unavailable provenance cannot revive a pack', () => {
  const reviewed=reviewWorkPackDefinition(definition(),current());
  expect(inspectWorkPackDefinition(reviewed,{...current(),presence:'deleted'}).state).toBe('orphan');
  expect(inspectWorkPackDefinition(reviewed,{...current(),provenance:'reimported'}).state).toBe('stale');
  for(const patch of [{provenance:'unknown'},{supported:false},{virtual:true}])expect(inspectWorkPackDefinition(reviewed,{...current(),...patch}).state).toBe('unsupported');
  expect(inspectWorkPackDefinition(reviewed,{...current(),kind:'simple'}).state).toBe('stale');
  expect(()=>reviewWorkPackDefinition(definition(),{...current(),virtual:true})).toThrow();
  expect(()=>reviewWorkPackDefinition(definition(),{...current(),presence:'deleted'})).toThrow();
});

test('typed report evidence is separate from successful read and actual test verdict', () => {
  const input={...definition(),inputs:[],inputBindings:[],plan:{steps:[{id:'tester',input:{operation:'tester.status.read'}}]},conditions:[{kind:'report-present',stepId:'tester'}]};
  const pack=reviewWorkPackDefinition(input,current());
  expect(evaluateWorkPackCompletion(pack,[]).complete).toBe(false);
  expect(evaluateWorkPackCompletion(pack,[{stepId:'tester',operation:'tester.status.read',state:'completed',availability:'ready',freshness:'current'}]).complete).toBe(false);
  expect(evaluateWorkPackCompletion(pack,[{stepId:'tester',operation:'tester.status.read',state:'completed',availability:'ready',freshness:'stale',latestRunId:'20261024T010203Z-1234abcd'}]).complete).toBe(true);
  expect(()=>evaluateWorkPackCompletion(pack,[{stepId:'other',operation:'tester.status.read',state:'completed',availability:'ready',freshness:'current'}])).toThrow();
});

test('preparation remains target independent and preserves input guide reference', () => {
  const input=definition(), before=JSON.stringify(input);
  const reviewed=reviewWorkPackDefinition(input,current());
  const a=prepareWorkPack(reviewed,current(),{query:'project A decisions'});
  const b=prepareWorkPack(reviewed,current(),{query:'project B decisions'});
  expect(a.definitionDigest).toBe(b.definitionDigest);
  expect(a.planDigest).not.toBe(b.planDigest);
  expect(a.source).toEqual(source());
  expect(JSON.stringify(input)).toBe(before);
  expect(JSON.stringify(a)).not.toContain('body"');
});

test('persisted orphan, stale and disabled definitions require explicit review; orphan cannot auto-revive',()=>{
  for(const state of ['draft','stale','disabled','orphan']){
    const pack={...definition(),review:{state}};
    expect(()=>prepareWorkPack(pack,current(),{query:'decision'})).toThrow();
    expect(evaluateWorkPackCompletion(pack,[{stepId:'memory',operation:'memory.reference.read',state:'completed',availability:'ready',freshness:'current'}]).complete).toBe(false);
  }
  expect(()=>reviewWorkPackDefinition({...definition(),review:{state:'orphan'}},current())).toThrow();
  expect(()=>reviewWorkPackDefinition(definition(),{...current(),provenance:'reimported'})).toThrow();
  expect(inspectWorkPackDefinition(reviewWorkPackDefinition({...definition(),review:{state:'stale'}},current()),current()).state).toBe('reviewed');
});

test('optional missing input uses static reviewed fallback while false remains a real input value',()=>{
  const input=definition();
  input.inputs[0]={name:'query',type:'string',required:false,maxLength:100};
  const pack=reviewWorkPackDefinition(input,current());
  const result=prepareWorkPack(pack,current(),{ack:false});
  expect(result.plan.steps[0]!.input).toEqual({operation:'memory.reference.read',role:'dev',query:'relevant decisions'});
  expect(result.values.ack).toBe(false);
  expect(Object.hasOwn(result.values,'query')).toBe(false);
  expect(()=>prepareWorkPack(pack,current(),{ack:null})).toThrow();
});

test('conditions require exact step operation and distinguish a report from its verdict',()=>{
  const input={...definition(),inputs:[],inputBindings:[],plan:{steps:[{id:'report',input:{operation:'tester.report.read',runId:'20261024T010203Z-1234abcd'}}]},conditions:[{kind:'report-present',stepId:'report'}]};
  const pack=reviewWorkPackDefinition(input,current());
  const evidence={stepId:'report',operation:'tester.report.read',state:'completed',availability:'ready',freshness:'unknown',reportRunId:'20261024T010203Z-1234abcd'};
  expect(evaluateWorkPackCompletion(pack,[evidence]).complete).toBe(true);
  expect(()=>evaluateWorkPackCompletion(pack,[{...evidence,reportRunId:'20261024T010203Z-9999abcd'}])).toThrow();
  expect(()=>evaluateWorkPackCompletion(pack,[{...evidence,operation:'tester.status.read',reportRunId:undefined}])).toThrow();
  expect(()=>evaluateWorkPackCompletion(pack,[evidence,evidence])).toThrow();
  for(const state of ['partial','failed','unknown','skipped','cancelled'])expect(evaluateWorkPackCompletion(pack,[{...evidence,state}]).complete).toBe(false);
});

test('definition and runtime inputs have independent byte limits, immutable references and exact schemas',()=>{
  const input=definition();
  const pack=reviewWorkPackDefinition(input,current());
  expect(Object.isFrozen(pack.source)).toBe(true);
  const enumInput=pack.inputs[1]!;
  if(enumInput.type!=='enum')throw Error('expected enum fixture');
  expect(Object.isFrozen(enumInput.options)).toBe(true);
  input.source.guideId='later-change';
  expect(pack.source.guideId).toBe('command-1');
  for(const name of ['target_id','account_id','device_id','grant','profile'])expect(()=>parseWorkPackDefinition({...definition(),inputs:[{name,type:'boolean',required:true}],inputBindings:[]})).toThrow();
  expect(()=>parseWorkPackDefinition({...definition(),inputs:[{name:'query',type:'enum',required:true,options:Array.from({length:17},(_,i)=>`option-${i}`)}]})).toThrow();
  expect(()=>parseWorkPackDefinition({...definition(),inputs:Array.from({length:9},(_,i)=>({name:`input${i}`,type:'boolean',required:false})),inputBindings:[]})).toThrow();
  expect(()=>prepareWorkPack(pack,current(),{query:'\"\\'.repeat(3000)})).toThrow();
  expect(()=>parseWorkPackDefinition({...definition(),review:{state:'reviewed',definitionDigest:'0'.repeat(64)}})).toThrow();
});

test('completion binds a report to the exact preceding tester status run instead of another report',()=>{
  const input={...definition(),inputs:[],inputBindings:[],plan:{steps:[
    {id:'status',input:{operation:'tester.status.read'}},
    {id:'report',dependsOn:['status'],input:{operation:'tester.report.read',runId:{stepId:'status',field:'latest.runId'}}},
  ]},conditions:[{kind:'report-present',stepId:'report'}]};
  const pack=reviewWorkPackDefinition(input,current());
  const status={stepId:'status',operation:'tester.status.read',state:'completed',availability:'ready',freshness:'current',latestRunId:'20261024T010203Z-1234abcd'};
  const report={stepId:'report',operation:'tester.report.read',state:'completed',availability:'ready',freshness:'current',reportRunId:status.latestRunId};
  expect(evaluateWorkPackCompletion(pack,[status,report]).complete).toBe(true);
  expect(()=>evaluateWorkPackCompletion(pack,[report])).toThrow();
  expect(()=>evaluateWorkPackCompletion(pack,[status,{...report,reportRunId:'20261024T010203Z-9999abcd'}])).toThrow();
});
