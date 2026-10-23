import {expect,test} from 'bun:test';
import {parseProjectStatePreviewInput,parseProjectStateSelectionInput,projectSourceObservation,projectStateSelectionText,sourceFreshness,utf8Bytes,type SourceObservation,type ProjectStateBundle} from '../src/projectStateBundle';

const observation=(patch:Partial<SourceObservation>={}):SourceObservation=>({id:'git',availability:'ready',freshness:'current',observedAt:100,summary:['branch main'],limits:[],...patch});
const bundle=(observations:SourceObservation[]):ProjectStateBundle=>({id:'bundle-1',targetId:'project-1',collectedAt:100,expiresAt:300100,state:'ready',observations});

test('T01 source_observation_status_freshness_stay_independent',()=>{
  for(const availability of ['ready','unconfigured','partial','unknown','unavailable'] as const){
    for(const freshness of ['current','stale','unknown'] as const){
      const projected=projectSourceObservation(observation({availability,freshness,sourceProducedAt:40,sourceRevision:'revision-1',limits:['catalog not configured']}));
      expect(projected.availability).toBe(availability);expect(projected.freshness).toBe(freshness);
      expect(projected.observedAt).toBe(100);expect(projected.sourceProducedAt).toBe(40);expect(projected.limits).toEqual(['catalog not configured']);
    }
  }
  expect(sourceFreshness({commit:'a',fingerprint:'dirty-a'},{commit:'a',fingerprint:'dirty-b'})).toBe('stale');
  expect(sourceFreshness({commit:'a'},{commit:'a',fingerprint:'dirty-a'})).toBe('unknown');
  expect(sourceFreshness(undefined,{commit:'a',fingerprint:'dirty-a'})).toBe('unknown');
  expect(sourceFreshness({commit:'a',fingerprint:'dirty-a'},{commit:'a',fingerprint:'dirty-a'})).toBe('current');
});

test('T06 preview_selection_redacts_sensitive_sources',()=>{
  // Split so the public-snapshot secret scan does not read the fixture as a real key.
  const secret='sk-ant-'+'abcdefghijklmnopqrstuvwxyz123456',home='/Users/fixture/private/project';
  const projected=projectSourceObservation(observation({summary:['safe relative src/App.tsx',`api_key=${secret}`,`root ${home}`,`markdown \`${home}\``,'UNC \\\\private\\share\\secret','diff --git a/x b/x','\u001b[31mPTY transcript'],limits:['password=hunter2']}));
  const text=projectStateSelectionText(bundle([projected,observation({id:'memory',summary:['unselected confidential memory']})]),['git']);
  expect(text).toContain('safe relative src/App.tsx');expect(text).toContain('untrusted_project_state');
  for(const hidden of [secret,home,'hunter2','diff --git','PTY transcript','\\\\private','unselected confidential memory'])expect(text).not.toContain(hidden);
  const large=projectSourceObservation(observation({summary:['한글😀'.repeat(5000)]}));
  expect(utf8Bytes(JSON.stringify(large))).toBeLessThanOrEqual(4096);expect(large.limits.join(' ')).toContain('truncated');
  expect(JSON.stringify(large)).not.toContain('\ufffd');
  const escaped=projectSourceObservation(observation({summary:['"\\'.repeat(3000)]}));
  expect(utf8Bytes(JSON.stringify(escaped))).toBeLessThanOrEqual(4096);
  expect(()=>projectStateSelectionText(bundle([large,observation({id:'workroom',summary:['나'.repeat(1300)]})]),['git','workroom'])).toThrow();
});

test('preview and selection exact schemas reject authority, paths, duplicate selections and oversized queries',()=>{
  expect(parseProjectStatePreviewInput({targetId:'project-1',memoryQuery:'relevant decision'})).toEqual({targetId:'project-1',memoryQuery:'relevant decision'});
  for(const input of [{targetId:'project-1',path:'/tmp/x'},{targetId:'project-1',role:'ops'},{targetId:'project-1',excludeWorkroomSessionId:'client-session'},{targetId:'project-1',memoryQuery:''},{targetId:'project-1',memoryQuery:'x'.repeat(701)}])expect(()=>parseProjectStatePreviewInput(input)).toThrow();
  for(const sections of [[],['git','git'],['env'],['git','memory','tester','workroom','other']])expect(()=>parseProjectStateSelectionInput({targetId:'project-1',bundleId:'bundle-1',sections})).toThrow();
  expect(()=>parseProjectStateSelectionInput({targetId:'project-1',bundleId:'bundle-1',sections:['git'],code:'echo x'})).toThrow();
  expect(()=>parseProjectStateSelectionInput({targetId:'project-1',bundleId:'bundle-1',sections:['workroom'],excludeWorkroomSessionId:'client-session'})).toThrow();
});

test('preview and selected text withhold fine-grained GitHub and Slack credential formats',()=>{
  const tokens=[`github_pat_${'A'.repeat(80)}`,...['xoxb','xoxp','xoxa','xoxr','xoxs'].map(prefix=>`${prefix}-123456789012-123456789012-${'a'.repeat(24)}`)];
  for(const token of tokens){
    const source=projectSourceObservation(observation({id:'memory',summary:[`Credential ${token}`],limits:[`Reference ${token}`],sourceRevision:token}));
    const text=projectStateSelectionText(bundle([source]),['memory']);
    expect(JSON.stringify(source)).not.toContain(token);expect(text).not.toContain(token);expect(text).toContain('[redacted]');
  }
});
