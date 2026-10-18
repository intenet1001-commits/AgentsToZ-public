/** 작성 내용 보관함의 실제 IndexedDB 저장소 (review S3-8, 2026-10-16).
 * Checks in Chromium and WebKit that the real storage's keys() returns the same keys as entries() without values, that
 * counting (save's limit check, count()) still holds the 32-draft limit, and measures how long a direct send's seal
 * takes with a nearly full vault — the new keys-only count against the old count that read every draft's ciphertext.
 * Timings are reported, never asserted (they move with machine load; see CLAUDE.md 「성능 기준선」).
 * Usage: bun tests/workroom-draft-vault-idb.e2e.mjs [samples]
 * Self-contained: bundles src/workroomDraftVault.ts with Bun.build and serves it on 127.0.0.1 (a secure context).
 * No app, no sidecar, no 3001; each engine gets a fresh browser context, so nothing persists.
 */
import {chromium, webkit} from 'playwright';
import assert from 'node:assert/strict';
import {join} from 'node:path';

const samples = Math.max(1, Number(process.argv[2]) || 5);
const built = await Bun.build({entrypoints: [join(import.meta.dir, '..', 'src', 'workroomDraftVault.ts')], target: 'browser', format: 'esm'});
if (!built.success) throw Error('bundle failed: ' + built.logs.map(log => log.message).join('; '));
const bundle = await built.outputs[0].text();
const server = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  fetch(request) {
    if (new URL(request.url).pathname === '/vault.js') return new Response(bundle, {headers: {'content-type': 'text/javascript'}});
    return new Response('<!doctype html><meta charset="utf-8"><title>draft vault</title>', {headers: {'content-type': 'text/html'}});
  },
});

async function run(engine, name) {
  const browser = await engine.launch({headless: true});
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.port}/`);
    const result = await page.evaluate(async ({samples}) => {
      const m = await import('/vault.js');
      const storage = m.createIndexedDbWorkroomDraftStorage();
      await storage.clear();
      const scope = 'local', sessionId = 'session-aaaa-1111', limit = m.WORKROOM_DRAFT_VAULT_LIMIT;
      const vault = new m.WorkroomDraftVault({storage});
      // The old count read every record's value; this storage gives the same vault that cost back for comparison.
      const oldVault = new m.WorkroomDraftVault({storage: {...storage, keys: async () => (await storage.entries()).map(entry => entry.recordKey)}});
      const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
      const time = async fn => {const start = performance.now(); await fn(); return performance.now() - start;};

      await vault.save({scope, sessionId, submissionId: 'idb-draft-small-1', text: 'a\r', references: []});
      const keys = (await storage.keys()).sort();
      const entryKeys = (await storage.entries()).map(entry => entry.recordKey).sort();
      // Close to the 1 MiB plaintext bound: the worst case the old count had to read, per draft.
      const big = 'x'.repeat(1_000_000);
      for (let i = 0; i < limit - 2; i++) await vault.save({scope, sessionId, submissionId: 'idb-draft-full-' + i, text: big, references: []});
      const fullCount = await vault.count();
      const entriesMs = [], keysMs = [], sealNewMs = [], sealOldMs = [];
      for (let i = 0; i < samples; i++) {
        entriesMs.push(await time(() => storage.entries()));
        keysMs.push(await time(() => storage.keys()));
        sealNewMs.push(await time(() => vault.save({scope, sessionId, submissionId: 'idb-seal-new-' + i, text: 'make check\r', references: [], attempted: true})));
        await vault.delete('idb-seal-new-' + i);
        sealOldMs.push(await time(() => oldVault.save({scope, sessionId, submissionId: 'idb-seal-old-' + i, text: 'make check\r', references: [], attempted: true})));
        await vault.delete('idb-seal-old-' + i);
      }
      // The limit is still the limit: one more fills it, the next new one is refused, re-sealing a kept one is not.
      await vault.save({scope, sessionId, submissionId: 'idb-draft-last', text: 'z\r', references: []});
      let refused = '';
      try {await vault.save({scope, sessionId, submissionId: 'idb-draft-over', text: 'z\r', references: []});} catch (error) {refused = error.code;}
      await vault.save({scope, sessionId, submissionId: 'idb-draft-small-1', text: 'again\r', references: []});
      const finalCount = await vault.count();
      const listed = (await vault.list(scope, sessionId)).drafts.length;
      await storage.clear();
      return {
        secure: isSecureContext, keys, entryKeys, fullCount, finalCount, listed, refused, limit,
        medianMs: {entries: median(entriesMs), keys: median(keysMs), sealNew: median(sealNewMs), sealOld: median(sealOldMs)},
        samplesMs: {entries: entriesMs, keys: keysMs, sealNew: sealNewMs, sealOld: sealOldMs},
      };
    }, {samples});
    assert.deepEqual(errors, [], name + ': page errors');
    assert.equal(result.secure, true, name + ': 127.0.0.1 is a secure context');
    assert.deepEqual(result.keys, result.entryKeys, name + ': keys() lists exactly the keys entries() lists');
    assert.deepEqual(result.keys, ['draft:idb-draft-small-1', 'key'], name + ': one draft and the key record');
    assert.equal(result.fullCount, result.limit - 1, name + ': count() by keys');
    assert.equal(result.refused, 'DRAFT_LIMIT', name + ': a new draft over the limit is refused');
    assert.equal(result.finalCount, result.limit, name + ': re-sealing a kept draft is not refused');
    assert.equal(result.listed, result.limit, name + ': every kept draft still opens');
    return {engine: name, ...result, keys: undefined, entryKeys: undefined};
  } finally {
    await browser.close();
  }
}

try {
  const report = [];
  for (const [engine, name] of [[chromium, 'chromium'], [webkit, 'webkit']]) report.push(await run(engine, name));
  const load = (await Bun.$`sysctl -n vm.loadavg`.quiet().nothrow().text()).trim();
  console.log(JSON.stringify({samples, load, report}, null, 1));
  console.log('workroom-draft-vault-idb: ok');
} finally {
  server.stop(true);
}
