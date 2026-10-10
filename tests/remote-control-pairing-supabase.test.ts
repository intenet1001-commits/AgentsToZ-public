import {expect,test} from 'bun:test';
import {buildRemoteControlRelayPairingUrl,parseRemoteControlRelayPairingUrl,REMOTE_CONTROL_RELAY_SCHEMA_VERSION} from '../src/remoteControlRelayContract';
import {pairingSupabaseConfig} from '../src/remoteControlPairingSupabase';

const b64=(v:object)=>Buffer.from(JSON.stringify(v)).toString('base64url');
const jwt=(role:string)=>`${b64({alg:'HS256',typ:'JWT'})}.${b64({iss:'supabase',ref:'abcdefghijklmnopqrst',role,iat:1,exp:4102444800})}.c2lnbmF0dXJlc2lnbmF0dXJl`;
const anon=jwt('anon'),service=jwt('service_role');
const key=new Uint8Array(65);key[0]=4;
const bootstrap={schemaVersion:REMOTE_CONTROL_RELAY_SCHEMA_VERSION,hostId:'host_abcdefghijklmnop',pairingId:'pair_abcdefghijklmnop',pairingSecret:Buffer.alloc(32,7).toString('base64url'),hostPublicKey:Buffer.from(key).toString('base64url'),expiresAt:'2026-10-26T00:00:00.000Z'};

test('a QR carries the public Supabase config and an old QR without it still parses', () => {
  const url=buildRemoteControlRelayPairingUrl('https://portal.example/remote/',{...bootstrap,supabase:{url:'https://example-ref.supabase.co',anonKey:anon}} as any);
  expect(parseRemoteControlRelayPairingUrl(url).bootstrap.supabase).toEqual({url:'https://example-ref.supabase.co',anonKey:anon});
  const old=buildRemoteControlRelayPairingUrl('https://portal.example/remote/',bootstrap as any);
  expect(parseRemoteControlRelayPairingUrl(old).bootstrap.supabase).toBeUndefined();
  // An old app's fragment check only allows base64url after "pair=": the new field must stay inside it.
  expect(url).toMatch(/#pair=[A-Za-z0-9_-]+$/);
});

test('rejects a Supabase config with a path, plain http, or a malformed key', () => {
  for(const supabase of [{url:'https://x.supabase.co/rest',anonKey:anon},{url:'http://x.supabase.co',anonKey:anon},{url:'https://x.supabase.co',anonKey:'not a key'},{url:'https://x.supabase.co',anonKey:anon,extra:1}]){
    expect(()=>buildRemoteControlRelayPairingUrl('https://portal.example/remote/',{...bootstrap,supabase} as any)).toThrow();
  }
});

test('the Mac never puts the service_role key in a QR', () => {
  const norm=(u:string)=>u.replace(/\/+$/,'');
  expect(pairingSupabaseConfig({supabaseUrl:'https://example-ref.supabase.co/',supabaseAnonKey:anon},service,norm)).toEqual({url:'https://example-ref.supabase.co',anonKey:anon});
  expect(pairingSupabaseConfig({supabaseUrl:'https://example-ref.supabase.co',supabaseAnonKey:service},null,norm)).toBeNull();
  expect(pairingSupabaseConfig({supabaseUrl:'https://example-ref.supabase.co',supabaseAnonKey:anon},anon,norm)).toBeNull();
  expect(pairingSupabaseConfig({supabaseUrl:'',supabaseAnonKey:anon},null,norm)).toBeNull();
  expect(pairingSupabaseConfig(null,null,norm)).toBeNull();
});
