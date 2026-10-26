import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { SCREEN_PUSH_SQL } from '../src/screenPushSql';
import { screenPushDatabase } from './screenPushTestKit';

// The screen push relay's tables and functions (DESIGN 「알림·원격 차단」), in PostgreSQL: service-role only, bounded,
// cleaned, replay- and rate-limited. The migration is written, not applied anywhere.
const tables = ['portmgr_screen_push_macs', 'portmgr_screen_push_tokens', 'portmgr_screen_push_commands', 'portmgr_screen_push_requests'];
const functions = [
  'portmgr_screen_push_admit(text,text,text,integer,integer)', 'portmgr_screen_push_register(text,text,text,text,text,text)',
  'portmgr_screen_push_unregister(text,text,text)', 'portmgr_screen_push_targets(text,text[])', 'portmgr_screen_push_drop_token(text,text,text)',
  'portmgr_screen_push_sync(text,text[],jsonb)', 'portmgr_screen_push_queue(text,text,text,text,text,timestamptz)', 'portmgr_screen_push_status(text)',
];
const id = (n: number) => n.toString(16).padStart(64, '0');
const key = (n: number) => '04' + n.toString(16).padStart(128, '0');
const nonce = (n: number) => n.toString(16).padStart(32, '0');
const array = (list: string[]) => `{${list.join(',')}}`;

test('the migration is the SQL the app carries, and it is not in the app table check while undeployed', () => {
  expect(readFileSync(new URL('../supabase/migrations/20261025010000_screen_push.sql', import.meta.url), 'utf8')).toBe(SCREEN_PUSH_SQL);
  const schema = readFileSync(new URL('../src/schemaSql.ts', import.meta.url), 'utf8');
  expect(schema).not.toContain('portmgr_screen_push');
  // The two unrelated public tables are not a pattern to copy: every table here turns RLS on and grants nothing to anon.
  expect(SCREEN_PUSH_SQL).not.toMatch(/_prisma_migrations|"Item"/);
  for (const table of tables) {
    expect(SCREEN_PUSH_SQL).toContain(`alter table public.${table} enable row level security;`);
  }
  const grantees = [...SCREEN_PUSH_SQL.matchAll(/\bgrant\b[^;]*\bto\s+([a-z_, ]+);/gi)].map(match => match[1]!.trim());
  expect(grantees.length).toBe(9);
  expect(new Set(grantees)).toEqual(new Set(['service_role']));
});

test('only the service role reaches the tables and functions; RLS is on everywhere', async () => {
  const db = await screenPushDatabase();
  try {
    await db.exec(SCREEN_PUSH_SQL); // applying twice repairs, never fails
    for (const table of tables) {
      const row = (await db.query<any>(`select c.relrowsecurity as rls,
          has_table_privilege('anon', 'public.${table}', 'select,insert,update,delete') as anon,
          has_table_privilege('authenticated', 'public.${table}', 'select,insert,update,delete') as authed,
          has_table_privilege('service_role', 'public.${table}', 'select') as service
        from pg_class c where c.relname = '${table}'`)).rows[0];
      expect(row).toEqual({ rls: true, anon: false, authed: false, service: true });
    }
    for (const fn of functions) {
      const row = (await db.query<any>(`select has_function_privilege('anon', 'public.${fn}', 'execute') as anon,
          has_function_privilege('authenticated', 'public.${fn}', 'execute') as authed,
          has_function_privilege('service_role', 'public.${fn}', 'execute') as service,
          (select prosecdef from pg_proc where oid = 'public.${fn}'::regprocedure) as definer,
          (select array_to_string(proconfig, ',') from pg_proc where oid = 'public.${fn}'::regprocedure) as config`)).rows[0];
      expect(row).toEqual({ anon: false, authed: false, service: true, definer: true, config: 'search_path=pg_catalog, public, pg_temp' });
    }
    // Even reached some other way, each function refuses anyone but the service role (the test runs as the owner, so
    // only the function's own check stands in the way).
    const calls = [
      `select public.portmgr_screen_push_admit('${id(1)}', 'fetch', '${nonce(1)}', 600, 40)`,
      `select public.portmgr_screen_push_register('${id(1)}', '${id(2)}', '${key(2)}', '${id(9)}', 'sandbox', 'a.b')`,
      `select public.portmgr_screen_push_unregister('${id(1)}', '${id(2)}', '${id(9)}')`,
      `select public.portmgr_screen_push_targets('${id(1)}', '{}')`,
      `select public.portmgr_screen_push_drop_token('${id(1)}', '${id(2)}', '${id(9)}')`,
      `select public.portmgr_screen_push_sync('${id(1)}', '{}', '[]')`,
      `select public.portmgr_screen_push_queue('${id(3)}', '${id(1)}', '${id(2)}', 'm', 's', now())`,
      `select public.portmgr_screen_push_status('${id(1)}')`,
    ];
    expect(calls.map(call => call.match(/public\.(\w+)\(/)![1])).toEqual(functions.map(fn => fn.split('(')[0]));
    for (const role of ['anon', 'authenticated', '']) {
      await db.exec(`set test.role = '${role}'`);
      for (const call of calls) await expect(db.query(call)).rejects.toThrow('SCREEN_PUSH_FORBIDDEN');
    }
  } finally { await db.close(); }
}, 30_000);

test('replay, rate limits and the relay-wide brake', async () => {
  const db = await screenPushDatabase();
  try {
    await db.exec(`set test.role = 'service_role'`);
    const admit = async (k: string, n: number, limit = 3) =>
      (await db.query<any>(`select public.portmgr_screen_push_admit($1, 'notify', $2, 600, $3) as v`, [k, nonce(n), limit])).rows[0].v;
    expect(await admit(id(1), 1)).toBe('ok');
    expect(await admit(id(1), 1)).toBe('replayed');
    expect(await admit(id(1), 2)).toBe('ok');
    expect(await admit(id(1), 3)).toBe('ok');
    expect(await admit(id(1), 4)).toBe('rate_limited');
    expect(await admit(id(2), 1)).toBe('ok'); // another key has its own budget
    // Old requests leave the window, but a nonce stays remembered at least 20 minutes.
    await db.exec(`update portmgr_screen_push_requests set created_at = now() - interval '11 minutes' where rate_key = '${id(1)}'`);
    expect(await admit(id(1), 1)).toBe('replayed');
    expect(await admit(id(1), 5)).toBe('ok');
    await db.exec(`update portmgr_screen_push_requests set created_at = now() - interval '21 minutes' where rate_key = '${id(1)}' and nonce = '${nonce(1)}'`);
    expect(await admit(id(1), 1)).toBe('ok');
    // Bad windows and limits are refused, not trusted.
    await expect(db.query(`select public.portmgr_screen_push_admit($1, 'notify', $2, 0, 3)`, [id(3), nonce(1)])).rejects.toThrow('SCREEN_PUSH_INVALID');
    await expect(db.query(`select public.portmgr_screen_push_admit($1, 'other', $2, 60, 3)`, [id(3), nonce(1)])).rejects.toThrow();
    // Too many new requests across the relay in a minute: everyone waits.
    await db.exec(`insert into portmgr_screen_push_requests(rate_key, kind, nonce)
      select '${id(9)}', 'result', lpad(to_hex(g), 32, '0') from generate_series(1, 120) g`);
    expect(await admit(id(4), 1)).toBe('busy');
  } finally { await db.close(); }
}, 30_000);

test('tokens follow the Mac\'s own list; commands are bounded and answered once', async () => {
  const db = await screenPushDatabase();
  try {
    await db.exec(`set test.role = 'service_role'`);
    const one = async (sql: string, params: unknown[] = []) => (await db.query<any>(sql, params)).rows[0]?.v;
    const mac = id(0xaa), d1 = id(1), d2 = id(2);
    const register = (device: string, token = 'ab'.repeat(32), m = mac) =>
      one(`select public.portmgr_screen_push_register($1, $2, $3, $4, 'production', 'com.intenet.agentstoz.mobile.testflight') as v`, [m, device, key(1), token]);
    const sync = (devices: string[], results: unknown[] = []) =>
      one(`select public.portmgr_screen_push_sync($1, $2::text[], $3::jsonb) as v`, [mac, array(devices), JSON.stringify(results)]);
    const queue = (command: string, device: string, expires = "now() + interval '10 minutes'") =>
      one(`select public.portmgr_screen_push_queue($1, $2, $3, 'bWVzc2FnZQ==', 'c2lnbmF0dXJl', ${expires}) as v`, [command, mac, device]);

    expect(await register(d1)).toBe('not_ready'); // a Mac that never polled has no tokens
    expect(await sync([d1, d2])).toEqual([]);
    expect(await register(d1)).toBe('ok');
    expect(await register(d2, 'cd'.repeat(32))).toBe('ok');
    // Devices the Mac does not list may wait in at most 4 places.
    for (let n = 10; n < 14; n++) expect(await register(id(n))).toBe('ok');
    expect(await register(id(14))).toBe('not_registered');
    expect(await register(id(10), 'ef'.repeat(32))).toBe('ok'); // renewing a waiting one is fine
    const targets = await one(`select public.portmgr_screen_push_targets($1, $2::text[]) as v`, [mac, array([d2, id(10)])]);
    expect(targets.map((t: any) => t.deviceID).sort()).toEqual([d2, id(10)]);
    expect(targets.find((t: any) => t.deviceID === id(10)).token).toBe('ef'.repeat(32));
    await expect(db.query(`select public.portmgr_screen_push_targets($1, $2::text[])`, [mac, array(Array.from({ length: 17 }, (_, n) => id(n)))])).rejects.toThrow();

    // Commands: only from listed devices, at most 4 waiting per device.
    expect(await queue(id(100), id(10))).toBe('unknown_device');
    for (let n = 0; n < 4; n++) expect(await queue(id(200 + n), d1)).toBe('ok');
    expect(await queue(id(204), d1)).toBe('queue_full');
    expect(await queue(id(200), d1)).toBe('queue_full'); // full stays full, also for a repeat
    await expect(db.query(`select public.portmgr_screen_push_queue($1, $2, $3, 'bQ==', 'cw==', now() + interval '9 days')`, [id(205), mac, d1])).rejects.toThrow('SCREEN_PUSH_INVALID');
    const waiting = await sync([d1, d2]);
    expect(waiting).toHaveLength(4);
    expect(waiting[0]).toEqual({ message: 'bWVzc2FnZQ==', signature: 'c2lnbmF0dXJl' });

    // The first answer stands; a later one for the same command changes nothing.
    await sync([d1, d2], [{ command_id: id(200), result: 'Zmlyc3Q=' }]);
    await sync([d1, d2], [{ command_id: id(200), result: 'c2Vjb25k' }]);
    expect(await one(`select public.portmgr_screen_push_status($1) as v`, [id(200)])).toBe('Zmlyc3Q=');
    expect(await one(`select public.portmgr_screen_push_status($1) as v`, [id(201)])).toBeNull();
    expect(await sync([d1, d2])).toHaveLength(3);
    // Another Mac cannot answer this Mac's command.
    await db.query(`select public.portmgr_screen_push_sync($1, '{}', $2::jsonb)`, [id(0xbb), JSON.stringify([{ command_id: id(201), result: 'b3RoZXI=' }])]);
    expect(await one(`select public.portmgr_screen_push_status($1) as v`, [id(201)])).toBeNull();
    // A device the Mac stops listing gets no commands handed over.
    expect(await sync([d2])).toHaveLength(0);

    // Dropped from the Mac's list: its tokens go, except ones registered moments ago.
    await db.exec(`update portmgr_screen_push_tokens set registered_at = now() - interval '3 minutes' where device_id <> '${id(13)}'`);
    await sync([d2]);
    const left = (await db.query<any>(`select device_id from portmgr_screen_push_tokens order by device_id`)).rows.map(r => r.device_id);
    expect(left).toEqual([d2, id(13)]);

    // Holding the token stops it; a wrong token does nothing.
    expect(await one(`select public.portmgr_screen_push_unregister($1, $2, $3) as v`, [mac, d2, 'ab'.repeat(32)])).toBe(false);
    expect(await one(`select public.portmgr_screen_push_unregister($1, $2, $3) as v`, [mac, d2, 'cd'.repeat(32)])).toBe(true);

    // Cleanup on each poll: old requests, finished or expired commands, tokens and Macs unheard of for 180 days.
    await register(d2);
    await db.exec(`insert into portmgr_screen_push_requests(rate_key, kind, nonce, created_at) values
      ('${id(5)}', 'fetch', '${nonce(1)}', now() - interval '11 minutes'), ('${id(5)}', 'notify', '${nonce(2)}', now() - interval '2 days'),
      ('${id(5)}', 'notify', '${nonce(3)}', now() - interval '1 hour')`);
    await db.exec(`update portmgr_screen_push_commands set answered_at = now() - interval '2 days' where command_id = '${id(200)}';
      update portmgr_screen_push_commands set expires_at = now() - interval '2 days' where command_id = '${id(201)}';
      insert into portmgr_screen_push_macs(mac_fingerprint, synced_at) values ('${id(0xcc)}', now() - interval '181 days');`);
    await db.exec(`update portmgr_screen_push_tokens set listed_at = now() - interval '181 days', registered_at = now() - interval '181 days' where device_id = '${id(13)}'`);
    await sync([d2]);
    expect((await db.query<any>(`select nonce from portmgr_screen_push_requests where rate_key = '${id(5)}'`)).rows.map(r => r.nonce)).toEqual([nonce(3)]);
    expect((await db.query<any>(`select command_id from portmgr_screen_push_commands where command_id in ('${id(200)}', '${id(201)}')`)).rows).toEqual([]);
    expect((await db.query<any>(`select count(*)::int as n from portmgr_screen_push_macs where mac_fingerprint = '${id(0xcc)}'`)).rows[0].n).toBe(0);
    expect((await db.query<any>(`select device_id from portmgr_screen_push_tokens`)).rows.map(r => r.device_id)).toEqual([d2]);

    // Shapes are bounded by the table itself.
    await expect(db.exec(`insert into portmgr_screen_push_tokens(mac_fingerprint, device_id, device_key, token, environment, topic)
      values ('${mac}', '${id(7)}', '${key(7)}', 'not hex', 'production', 'x')`)).rejects.toThrow();
    await expect(db.query(`select public.portmgr_screen_push_sync($1, $2::text[], '[]')`, [mac, array(Array.from({ length: 17 }, (_, n) => id(n)))])).rejects.toThrow();
    await expect(db.query(`select public.portmgr_screen_push_sync($1, '{}', $2::jsonb)`, [mac, JSON.stringify(Array.from({ length: 17 }, () => ({})))])).rejects.toThrow();
  } finally { await db.close(); }
}, 30_000);
