// @ts-nocheck -- deployed in the Supabase Deno runtime.
// AgentsToZ Screen push relay (DESIGN 「알림·원격 차단」); protocol.ts holds the logic and its reasons. NOT deployed by
// this repository: a person deploys it, sets the secrets below and applies 20261025010000_screen_push.sql.
// Secrets (names only — values never live in the repository):
//   APNS_KEY_P8   the team's APNs auth key (.p8 PEM text)
//   APNS_KEY_ID   its 10-character Key ID
//   APNS_TEAM_ID  the 10-character Team ID
//   APNS_TOPICS   comma-separated app bundle IDs it may push to
// SUPABASE_URL and the service key come from the runtime.
import { createApnsSender, createScreenPushHandler } from './protocol.ts';

const host = Deno.env.get('SUPABASE_URL');
const service = Deno.env.get('PORTMGR_SERVICE_SECRET_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const keyP8 = Deno.env.get('APNS_KEY_P8'), keyID = Deno.env.get('APNS_KEY_ID'), teamID = Deno.env.get('APNS_TEAM_ID');
const allowedTopics = (Deno.env.get('APNS_TOPICS') ?? '').split(',').map(topic => topic.trim()).filter(Boolean);

async function rpc(name: string, args: Record<string, unknown>) {
  if (!host || !service) throw Error('not configured');
  const response = await fetch(`${host}/rest/v1/rpc/${name}`, {
    method: 'POST', signal: AbortSignal.timeout(10000),
    headers: { apikey: service, Authorization: `Bearer ${service}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!response.ok) throw Error(`rpc ${name} ${response.status}`);
  return await response.json();
}

Deno.serve(createScreenPushHandler({
  rpc,
  apns: keyP8 && keyID && teamID ? createApnsSender({ keyP8, keyID, teamID, fetch }) : null,
  allowedTopics,
}));
