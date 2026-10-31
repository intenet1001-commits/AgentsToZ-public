import {afterEach,expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readOrcaWorkspaceSessionState} from '../src/orcaProfileState';
import {inspectOrcaContextSessionPresence} from '../src/contextSessionPresence';

const sessionId='0bbbc3c7-9ae3-4878-856d-4097479f1a3f',tabId='f42d2fba-9f79-450f-99d3-3feca4f10d0e',leafId='6cd2b928-a539-4db9-b015-4f5303a39486';
const paneKey=`${tabId}:${leafId}`,worktreeId='bdfe4122-e699-4912-9ebb-a463f8074b00::/Users/fixture/project';
const dirs:string[]=[];afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function profile(options:{database?:'current'|'broken';json?:boolean}){
  const dir=mkdtempSync(join(tmpdir(),'orca-profile-'));dirs.push(dir);
  // The frozen JSON predates this pane: it knows the tab, not the provider session opened after the migration.
  if(options.json)writeFileSync(join(dir,'orca-data.json'),JSON.stringify({workspaceSession:{sleepingAgentSessionsByPaneKey:{}}}));
  if(options.database==='current'){
    const db=new Database(join(dir,'profile-state.db'));
    db.run('CREATE TABLE profile_state_documents(domain TEXT PRIMARY KEY,payload TEXT NOT NULL,updated_at INTEGER)');
    db.query('INSERT INTO profile_state_documents VALUES(?,?,?)').run('workspaceSession',JSON.stringify({sleepingAgentSessionsByPaneKey:{
      [paneKey]:{paneKey,tabId,worktreeId,agent:'claude',state:'working',providerSession:{id:sessionId}}}}),Date.now());
    db.close();
  }
  if(options.database==='broken')writeFileSync(join(dir,'profile-state.db'),'not a database');
  return dir;
}
const terminals={terminals:[{handle:'term_live',tabId,leafId,worktreeId,connected:true,orphaned:false}]};
const targets=[{sessionId,launchContext:{orcaPaneKey:paneKey,orcaWorktreeId:worktreeId}}];

test('Orca 1.4 profile database is the only answer once it exists: a live terminal is live, not gone',()=>{
  const dir=profile({database:'current',json:true}),state=readOrcaWorkspaceSessionState(dir);
  expect(state).toMatchObject({kind:'ok',source:'sqlite'});
  expect(inspectOrcaContextSessionPresence(targets,{kind:'running',sessionState:state.kind==='ok'?state.state:null,terminals}).get(sessionId)).toBe('live');
  // Root cause (2026-10-29): the frozen JSON alone called the same live terminal `gone`.
  const legacy=readOrcaWorkspaceSessionState(profile({json:true}));
  expect(legacy).toMatchObject({kind:'ok',source:'json'});
  expect(inspectOrcaContextSessionPresence(targets,{kind:'running',sessionState:legacy.kind==='ok'?legacy.state:null,terminals}).get(sessionId)).toBe('gone');
});

test('an unreadable database never falls back to the frozen JSON; no profile at all is unavailable',()=>{
  expect(readOrcaWorkspaceSessionState(profile({database:'broken',json:true}))).toEqual({kind:'unavailable'});
  expect(readOrcaWorkspaceSessionState(profile({}))).toEqual({kind:'unavailable'});
});

test('the other pane of a split tab is not this session terminal',()=>{
  const dir=profile({database:'current'}),state=readOrcaWorkspaceSessionState(dir);
  const sessionState=state.kind==='ok'?state.state:null;
  const split={terminals:[{handle:'term_other',tabId,leafId:'another-leaf',worktreeId,connected:true}]};
  expect(inspectOrcaContextSessionPresence(targets,{kind:'running',sessionState,terminals:split}).get(sessionId)).toBe('gone');
  const both={terminals:[...split.terminals,...terminals.terminals]};
  expect(inspectOrcaContextSessionPresence(targets,{kind:'running',sessionState,terminals:both}).get(sessionId)).toBe('live');
});
