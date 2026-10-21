import {expect, test} from 'bun:test';
import {portAiLabelExpected, mergePortAiLabelReceipt, readPortAiLabelReceipt} from '../src/portAiLabelView';

const row = {id:'existing-project',name:'Original name',folderPath:'/tmp/project',aiName:'original alias',category:'original',description:'description',favorite:false,futureField:{kept:true}};
const patch = {id:row.id,expected:portAiLabelExpected(row),desired:{aiName:'new alias',category:'new'}};
const saved = {...row,...patch.desired};
const receipt = {success:true,ports:[saved],appliedIds:[row.id],unchangedIds:[],skipped:[]};

test('label snapshots retain complete original values and explicit nulls', () => {
  const name='long original '.repeat(40);
  expect(portAiLabelExpected({name}).name).toBe(name);
  expect(portAiLabelExpected({name})).toEqual({name,folderPath:null,aiName:null,category:null,description:null});
});

test('acknowledged label refresh preserves other fields, new rows and concurrent edits', () => {
  const newRow={...row,id:'added-after-request',name:'new row'};
  const result=readPortAiLabelReceipt(receipt,[patch]);
  const merged=mergePortAiLabelReceipt([row,newRow],[patch],result);
  expect(merged).toEqual([saved,newRow]);
  expect(merged[1]).toBe(newRow);
  for(const field of ['name','folderPath','aiName','category','description'] as const) {
    const edited={...row,[field]:'user edit'};
    expect(mergePortAiLabelReceipt([edited],[patch],result)[0]).toBe(edited);
  }
  expect(mergePortAiLabelReceipt([newRow],[patch],result)).toEqual([newRow]);
  const baseline=mergePortAiLabelReceipt([row],[patch],result);
  expect(mergePortAiLabelReceipt(baseline,[patch],result)).toEqual(baseline);
});

test('partial receipts retain skipped proposals while only accepted labels reach the view', () => {
  const other={...row,id:'conflicting-project'};
  const otherPatch={...patch,id:other.id};
  const partial=readPortAiLabelReceipt({...receipt,ports:[saved,other],skipped:[{id:other.id,reason:'changed',fields:['category']}]},[patch,otherPatch]);
  expect(mergePortAiLabelReceipt([row,other],[patch,otherPatch],partial)).toEqual([saved,other]);
});

test('missing, duplicate or contradictory write receipts require confirmation instead of fallback', () => {
  for(const invalid of [null,{}, {...receipt,success:false}, {...receipt,ports:[row]},
    {...receipt,ports:[]}, {...receipt,ports:[saved,saved]}, {...receipt,appliedIds:[]},
    {...receipt,unchangedIds:[row.id]}, {...receipt,appliedIds:['foreign-project']},
    {...receipt,appliedIds:[],skipped:[{id:row.id,reason:'changed',fields:['password']}]}]) {
    expect(()=>readPortAiLabelReceipt(invalid,[patch])).toThrow('적용 결과를 확인하지 못했습니다');
  }
});
