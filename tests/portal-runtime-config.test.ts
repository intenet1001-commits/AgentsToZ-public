import {expect,test} from 'bun:test';
import {readPortalRuntimeConfig} from '../src/portalRuntimeConfig';

const anon='eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.c2lnbmF0dXJlc2lnbg';
const ok={portalOrigin:'https://portal.example',supabaseUrl:'https://abc.supabase.co',supabaseAnonKey:anon};

test('the bundled app config is read only when complete and well-formed', () => {
  expect(readPortalRuntimeConfig({agentstozBundledPortal:ok})).toEqual(ok);
  expect(readPortalRuntimeConfig({})).toBeNull();
  expect(readPortalRuntimeConfig(undefined)).toBeNull();
  for(const bad of [
    {...ok,portalOrigin:'http://portal.example'},
    {...ok,portalOrigin:'https://portal.example/remote/'},
    {...ok,supabaseUrl:'https://user:pw@abc.supabase.co'},
    {...ok,supabaseAnonKey:'short'},
    {...ok,supabaseAnonKey:'has spaces in it and is long enough'},
    {...ok,extra:true},
  ])expect(readPortalRuntimeConfig({agentstozBundledPortal:bad})).toBeNull();
});
