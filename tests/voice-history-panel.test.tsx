import {expect,test} from 'bun:test';
import {renderToStaticMarkup} from 'react-dom/server';
import {VoiceHistoryPanel,voiceHistoryTitle} from '../src/VoiceHistoryPanel';
import type {VoiceHistoryPage} from '../src/voiceHistoryProtocol';

test('아젠투지 voice is titled 아젠투지 and project voice by the registered project name',()=>{
  const names=new Map([['hermes_target','헤르메스']]);
  expect(voiceHistoryTitle({kind:'ops',label:'AgentsToZ OPS',targetId:null},names)).toBe('아젠투지');
  // The Control workroom shares the OPS memory: its voice is 아젠투지 too.
  expect(voiceHistoryTitle({kind:'ops',label:'AgentsToZ-Control · agy',targetId:'control_target'},names)).toBe('아젠투지');
  // Older sessions were labelled with the aiName-first runtime label.
  expect(voiceHistoryTitle({kind:'workroom',label:'Claude Agent Config · claude',targetId:'hermes_target'},names)).toBe('헤르메스');
  // Without the project (removed, or no list passed) the recorded label speaks, minus the AI suffix.
  expect(voiceHistoryTitle({kind:'workroom',label:'vibe2 · claude',targetId:'gone'},names)).toBe('vibe2');
  expect(voiceHistoryTitle({kind:'workroom',label:'vibe2 · claude'},new Map())).toBe('vibe2');
});

// Replaces a render with zero sessions: server rendering runs no effects, so that panel never listed a
// session and «never prints AgentsToZ OPS» could not fail (review 2026-09-29). This one renders an OPS
// session and the OPS scope chip, the places the runtime label would leak.
test('an OPS session and its scope chip render as 아젠투지, never the raw runtime label',()=>{
  const at='2026-09-29T00:00:00Z';
  const page:VoiceHistoryPage={sessions:[
    {id:'voice_ops',kind:'ops',label:'AgentsToZ OPS',targetId:null,createdAt:at,endedAt:at,mode:'conversation',model:'gpt-realtime-2.1',turnCount:2,reviewed:false,complete:true},
    {id:'voice_vibe',kind:'workroom',label:'Vibe Coding Guide v2 · claude',targetId:'vibe2_target',createdAt:at,endedAt:at,mode:'conversation',model:'gpt-realtime-2.1',turnCount:1,reviewed:false,complete:true},
  ],nextBefore:null,scopes:[{key:'ops',kind:'ops',label:'AgentsToZ OPS'},{key:'vibe2_target',kind:'workroom',label:'Vibe Coding Guide v2'}]};
  const html=renderToStaticMarkup(<VoiceHistoryPanel transport={async()=>({history:page})} projects={[{id:'vibe2_target',name:'vibe2'}]} initialPage={page}/>);
  expect(html).toContain('음성 세션');expect(html).toContain('아젠투지 호출은 아젠투지에');
  // Both sessions are listed; the OPS one is titled 아젠투지 without the runtime label beside it.
  expect(html.match(/data-testid="voice-history-session"/g)).toHaveLength(2);
  expect(html).toContain('<strong class="block">아젠투지</strong>');
  expect(html).not.toContain('AgentsToZ OPS');
  // Chips: 전체 · 아젠투지 · the registered project name.
  expect(html).toMatch(/data-scope="ops"[^>]*>아젠투지<\/button>/);
  expect(html).toMatch(/data-scope="vibe2_target"[^>]*>vibe2<\/button>/);
  // Project voice is titled by the registered name; the recorded aiName-first label stays as a subtitle.
  expect(html).toContain('<strong class="block">vibe2</strong>');
  expect(html).toContain('Vibe Coding Guide v2 · claude');
});
