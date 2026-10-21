import {expect,test} from 'bun:test';
import {renderToStaticMarkup} from 'react-dom/server';
import {AiTerminalPanel} from '../src/AiTerminalPanel';

const transport=async()=>({ok:true,sessions:[]}) as any;
const projects=[{targetId:'p-mcp',label:'mcp-series'},{targetId:'p-ops',label:'AgentsToZ-OPS'},{targetId:'p-blog',label:'블로그'}];
const projectSelect=(html:string)=>html.slice(html.indexOf('aria-label="터미널 프로젝트"'),html.indexOf('</select>',html.indexOf('aria-label="터미널 프로젝트"')));

test('총괄 leads the project picker in its own group (VOC 2026-10-08: OPS sat below mcp-series)',()=>{
  const select=projectSelect(renderToStaticMarkup(<AiTerminalPanel visible={false} projects={projects} transport={transport} remote opsTargetId="p-ops" deviceName="아젠투지3호"/>));
  const ops=select.indexOf('label="총괄 (OPS)"'),rest=select.indexOf('label="프로젝트"');
  expect(ops).toBeGreaterThan(-1);expect(rest).toBeGreaterThan(ops);
  expect(select.indexOf('AgentsToZ-OPS')).toBeLessThan(rest);
  expect(select.indexOf('mcp-series')).toBeGreaterThan(rest);
  expect(select.match(/AgentsToZ-OPS/g)?.length).toBe(1);
});

test('without an OPS target the list stays a plain list',()=>{
  const select=projectSelect(renderToStaticMarkup(<AiTerminalPanel visible={false} projects={projects} transport={transport}/>));
  expect(select).not.toContain('optgroup');
  expect(select.indexOf('mcp-series')).toBeLessThan(select.indexOf('AgentsToZ-OPS'));
});
