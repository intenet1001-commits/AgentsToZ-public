import {describe,expect,test} from 'bun:test';
import {readdir,readFile} from 'node:fs/promises';

const directory=new URL('../src/',import.meta.url);
const files=(await readdir(directory)).filter(name=>/^WorkroomBrowserFrame.*\.css$/.test(name)).sort();
const styles=await Promise.all(files.map(async name=>({name,text:(await readFile(new URL(name,directory),'utf8')).replace(/\/\*[\s\S]*?\*\//g,'')})));
const combined=styles.map(file=>file.text).join('\n');

describe('Workroom browser appearance contracts',()=>{
 test('all browser frame styles use the shared colour tokens',()=>{
  expect(files.length).toBeGreaterThan(0);
  for(const file of styles)expect(file.text, file.name).not.toMatch(/#[\da-f]{3,8}\b|rgba\s*\(/i);
 });
 test('the selected view has an explicit visual treatment',()=>{
  expect(combined).toMatch(/\.workroom-browser-tabs[^{}]*\[aria-pressed\s*=\s*["']?true["']?\][^{]*\{[^}]*\bbackground\s*:[^;}]*var\(--raised\)/);
 });
 test('errors and destructive browser controls use the danger token',()=>{
  const dangerRules=[...combined.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([,selector])=>/\[role\s*=\s*["']?alert|\[data-(?:tone|variant)\s*=\s*["']?danger/.test(selector??''));
  expect(dangerRules.length).toBeGreaterThan(0);
  expect(dangerRules.some(([, ,declarations])=>/var\(--danger\)/.test(declarations??''))).toBe(true);
 });
 test('the native page stage never animates its rectangle and respects reduced motion',()=>{
  const stageRules=[...combined.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([,selector])=>/\.workroom-browser-stage\b/.test(selector??''));
  expect(stageRules.length).toBeGreaterThan(0);
  for(const [, ,declarations] of stageRules)expect(declarations).not.toMatch(/\btransition\s*:[^;}]*\b(?:all|width|height|top|left|right|bottom|padding|margin)\b/);
  expect(combined).toMatch(/prefers-reduced-motion\s*:\s*reduce/);
 });
});
