import {describe, expect, test} from 'bun:test';
import {workroomBackgroundResponse as answer} from './fixtures/workroom-runtime-background-mocks.mjs';

const hermes='/api/agent-runtime/hermes-variants',teams='/api/agent-runtime/workroom-teams';
describe('isolated Workroom background API fixtures',()=>{
 test('answers project suggestions with an empty local list and no real project lookup',()=>{
  for(const body of [null,undefined])expect(answer('/api/ports','GET',body)).toEqual([]);
 });
 test('models an ungated synthetic Hermes host without launching or probing a provider',()=>{
  const result=answer(hermes,'POST',{});
  if(Array.isArray(result))throw new Error('Hermes availability must return an object, not a project list');
  expect(result).toMatchObject({checked:false,sessions:[]});
  expect(result?.items?.map(item=>[item.variant,item.provider,item.available])).toEqual([['claude','anthropic',true],['codex','openai-codex',true]]);
 });
 test('answers both ledger-only and Git status reads with no team',()=>{
  for(const git of [false,true])expect(answer(teams,'POST',{sessionId:'fixture-session-alpha',git})).toEqual({teams:[]});
 });
 test('leaves unknown endpoints to the original deny list',()=>{
  for(const path of ['/api/agent-runtime/terminals','/api/agent-runtime/workroom-teams/attach','/api/unexpected'])expect(answer(path,'POST',{})).toBeNull();
 });
 test('rejects methods, launch/management payloads and malformed session reads',()=>{
  for(const method of ['POST','PUT','DELETE'])expect(()=>answer('/api/ports',method,null)).toThrow();
  for(const body of [{},[],{folderPath:'/fixture/project'}])expect(()=>answer('/api/ports','GET',body)).toThrow();
  for(const method of ['GET','PUT','DELETE'])expect(()=>answer(hermes,method,{})).toThrow();
  for(const body of [{operation:'start'}, {token:'fixture'}, null, []])expect(()=>answer(hermes,'POST',body)).toThrow();
  for(const body of [{sessionId:'fixture-session-alpha',git:true,operation:'attach'},{sessionId:'../outside',git:true},{sessionId:'fixture-session-alpha',git:'true'},{}])expect(()=>answer(teams,'POST',body)).toThrow();
 });
});
