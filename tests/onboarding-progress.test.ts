import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { OnboardingProgressStore } from '../src/onboardingProgressStore';
import { handleOnboardingProgress } from '../src/onboardingProgressHttp';

const folders: string[] = [];
const stores: OnboardingProgressStore[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'onboarding-progress-')); folders.push(dir);
  const open = () => { const s = new OnboardingProgressStore(dir); stores.push(s); return s; };
  return {dir, open};
}
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const d of folders.splice(0)) rmSync(d, {recursive:true,force:true}); });

test('saved selection resumes; stale windows cannot replace it', () => {
  const {open} = fixture(); const a = open(), b = open();
  const p = a.plan('0','mac',['codex','github']);
  expect(b.read()).toEqual(p);
  const next = b.defer(p.revision,'github',true);
  expect(() => a.plan(p.revision,'mac',['claude'])).toThrow('REVISION_CONFLICT');
  expect(open().read()).toEqual(next);
});

test('only host evidence advances state; version alone is not authenticated', () => {
  const {open} = fixture(); const s = open();
  let p = s.plan('0','mac',['codex','github','vercel']);
  p = s.defer(p.revision,'vercel',true);
  const started = s.beginCheck(p.revision);
  expect(open().read()?.operation).toEqual(started.operation);
  expect(() => s.beginCheck(started.revision)).toThrow('CHECK_RUNNING');
  const done = s.finishCheck(started,[
    {id:'codex',state:'ready',installed:true},
    {id:'github',state:'ready',installed:true,authenticated:true,detail:'private account'},
    {id:'vercel',state:'ready',installed:true,authenticated:true},
  ]);
  expect(done.steps.map(x=>x.state)).toEqual(['installed','ready','deferred']);
  expect(JSON.stringify(done)).not.toContain('private account');
  expect(() => s.finishCheck(started,[])).toThrow('REVISION_CONFLICT');
  expect(s.defer(done.revision,'vercel',false).steps.at(-1)?.state).toBe('pending');
});

test('future schema is preserved, not reset to a fresh installation', () => {
  const {dir,open} = fixture(); open();
  const file = join(dir,'onboarding','progress-v1.sqlite');
  const db = new Database(file); db.exec('PRAGMA user_version=99'); db.close();
  const before = readFileSync(file);
  expect(() => open()).toThrow('SCHEMA_UNSUPPORTED');
  expect(readFileSync(file)).toEqual(before);
});

test('interrupted read-only checks need explicit retry and late results cannot overwrite it', () => {
  const {dir,open} = fixture(); const s = open();
  const p = s.plan('0','mac',['github']);
  const interrupted = s.beginCheck(p.revision);
  const file = join(dir,'onboarding','progress-v1.sqlite');
  const db = new Database(file);
  const old = {...interrupted,operation:{...interrupted.operation!,startedAt:new Date(Date.now()-60000).toISOString()}};
  db.query('UPDATE progress SET body=? WHERE id=1').run(JSON.stringify(old)); db.close();
  const resumed = open();
  expect(resumed.read()?.steps[0]?.state).toBe('pending');
  expect(resumed.read()?.operation?.id).toBe(interrupted.operation?.id);
  const retry = resumed.beginCheck(old.revision);
  expect(retry.operation?.id).not.toBe(interrupted.operation?.id);
  expect(() => s.finishCheck(interrupted,[{id:'github',state:'ready',installed:true,authenticated:true}]))
    .toThrow('REVISION_CONFLICT');
  expect(resumed.finishCheck(retry,[]).steps[0]?.state).toBe('unknown');
});

test('unreadable saved progress stays intact and cannot be replaced by a fresh plan', () => {
  const {dir,open} = fixture(); const s = open();
  s.plan('0','mac',['github']);
  const db = new Database(join(dir,'onboarding','progress-v1.sqlite'));
  db.query('UPDATE progress SET body=? WHERE id=1').run('{broken');
  expect(() => s.read()).toThrow();
  expect(() => s.plan('0','mac',['codex'])).toThrow();
  expect(db.query('SELECT body FROM progress').get()).toEqual({body:'{broken'});
  db.close();
});

test('HTTP rejects caller completion, commands and oversized bodies; failed checks stay unknown', async () => {
  const {open} = fixture(); const s = open(); let calls = 0;
  const options = {store:()=>s,platform:'mac' as const,diagnose:async()=>{ calls++; throw new Error('private credential'); }};
  const request = (body: unknown) => handleOnboardingProgress(new Request('http://localhost/api/onboarding/progress',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),
  }),options);
  expect((await request({operation:'plan',expectedRevision:'0',tools:['codex'],state:'ready'})).status).toBe(400);
  expect((await request({operation:'plan',expectedRevision:'0',tools:['shell']})).status).toBe(400);
  expect((await request({operation:'plan',expectedRevision:'0',tools:['codex'],command:'x'.repeat(5000)})).status).toBe(413);
  expect(s.read()).toBeNull(); expect(calls).toBe(0);
  const p = (await (await request({operation:'plan',expectedRevision:'0',tools:['codex']})).json()).progress;
  const response = await request({operation:'check',expectedRevision:p.revision});
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.progress.steps[0].state).toBe('unknown');
  expect(JSON.stringify(body)).not.toContain('credential'); expect(calls).toBe(1);
});
