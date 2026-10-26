import {test,expect} from 'bun:test';
import {readFileSync,readdirSync} from 'node:fs';
import {BROWSER_ERROR_CODES,WorkroomBrowserError,classifyWorkroomBrowserError} from '../src/workroomBrowserErrorCodes';

test('the stable code vocabulary is bounded, unique and typed errors take precedence over messages',()=>{
 expect(BROWSER_ERROR_CODES.length).toBeLessThanOrEqual(30);expect(new Set(BROWSER_ERROR_CODES).size).toBe(BROWSER_ERROR_CODES.length);
 for(const code of BROWSER_ERROR_CODES){const error=new WorkroomBrowserError(code,'Take control before navigating.');expect(error).toBeInstanceOf(Error);expect(error.message).toBe('Take control before navigating.');expect(classifyWorkroomBrowserError(error)).toBe(code);}
});
test('every native Err literal and Tauri browser command rejection has an exact non-generic classification',()=>{
 for(const file of ['../native/workroom-browser/src/lib.rs','../src-tauri/src/workroom_browser.rs']){
  const source=readFileSync(new URL(file,import.meta.url),'utf8');
  const literals=[...source.matchAll(/\bErr\(\s*("(?:\\.|[^"\\])*")/g)].map(m=>JSON.parse(m[1]!));
  expect(literals.length).toBeGreaterThan(0);
  // Include ok_or literals too: the same Tauri invoke rejects with those strings.
  literals.push(...[...source.matchAll(/\.ok_or\(\s*("(?:\\.|[^"\\])*")/g)].map(m=>JSON.parse(m[1]!)));
  for(const message of literals){const code=classifyWorkroomBrowserError(message);expect(code,message).not.toBe('generic');expect(BROWSER_ERROR_CODES).toContain(code);expect(classifyWorkroomBrowserError(new Error(message))).toBe(code);}
 }
});
test('classifications are exact and arbitrary objects, prefixes and inherited keys stay generic',()=>{
 for(const error of [undefined,null,{}, {code:'popup-open'}, {message:'Take control before navigating.'},'Error: Take control before navigating.','Take control before navigating. extra','constructor','toString',new Error('unrecognized')])expect(classifyWorkroomBrowserError(error)).toBe('generic');
 for(const [message,code] of [['Browser is still closing.','still-closing'],['Chromium profile initialization timed out.','profile-timeout'],['This app was built without embedded Chromium.','embedded-unavailable'],['이 창에서는 해당 런타임 요청을 사용할 수 없습니다.','other-window']] as const)expect(classifyWorkroomBrowserError(message)).toBe(code);
});
test('each host refusal explicitly supplies a stable code',()=>{
 const source=readFileSync(new URL('../src/workroomBrowserHost.ts',import.meta.url),'utf8');
 const calls=[...source.matchAll(/\bfail\((?!code:)([^,]*),/g)];
 expect(calls.length).toBeGreaterThan(60);
 for(const call of calls){const code=/^'([^']+)'$/.exec(call[1]!)?.[1];expect(BROWSER_ERROR_CODES as readonly string[]).toContain(code!);}
});
test('the contracts wrapper discovers only sorted workroom-browser test files',()=>{
 const source=readFileSync(new URL('./workroom-browser-contracts.mjs',import.meta.url),'utf8');
 expect(source).toContain('await readdir(');expect(source).toContain('.sort()');
 const tests=readdirSync(new URL('.',import.meta.url)).filter(name=>/^workroom-browser.*\.test\.ts$/.test(name)).sort();
 for(const original of ['workroom-browser.test.ts','workroom-browser-client.test.ts','workroom-browser-recovery.test.ts','workroom-browser-bundle.test.ts','workroom-browser-navigation.test.ts','workroom-browser-frames.test.ts','workroom-browser-tabs.test.ts','workroom-browser-error-codes.test.ts'])expect(tests).toContain(original);
 expect(tests.some(name=>name.endsWith('.mjs')||!name.startsWith('workroom-browser'))).toBe(false);
});
