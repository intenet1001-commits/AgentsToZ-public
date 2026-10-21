/**
 * Review w13 — CSS contracts of the phone attachment row that a browser emulator cannot show: Playwright resolves
 * env(safe-area-inset-*) to 0, so a doubled landscape inset (≈47pt on a notched iPhone) is only visible in the rules.
 */
import {expect,test} from 'bun:test';

const read=(name:string)=>Bun.file(new URL(`../src/${name}`,import.meta.url)).text();
/** Every rule block whose selector list names `selector`. */
function rules(css:string,selector:string):string[]{
  const out:string[]=[];
  const plain=css.replace(/\/\*[\s\S]*?\*\//g,'');
  const re=/([^{}]+)\{([^{}]*)\}/g;let match:RegExpExecArray|null;
  while((match=re.exec(plain)))if(match[1]!.split(',').some(part=>part.includes(selector)))out.push(match[2]!);
  return out;
}

test('the chips row adds no safe-area padding of its own; its containers already pad it', async () => {
  const bar=await read('RemoteWorkroomAttachBar.css'),panel=await read('AiTerminalPanel.css');
  const row=rules(bar,'.ai-terminal-remote-attach-row');
  expect(row.length).toBeGreaterThan(0);
  for(const body of row)expect(body).not.toContain('safe-area-inset');
  // The session view and the 「새 작업」 sheet pad left and right themselves.
  for(const container of ['.ai-terminal-panel.ai-terminal-session-view','.ai-terminal-panel.ai-terminal-new-task-sheet']){
    const padded=rules(panel,container).filter(body=>/padding:[^;]*env\(safe-area-inset-right[^;]*env\(safe-area-inset-left/.test(body));
    expect(padded.length).toBe(1);
  }
});

test('the docked row is capped (it scrolls inside), and folds while the keyboard is up', async () => {
  const bar=await read('RemoteWorkroomAttachBar.css');
  const capped=rules(bar,'.ai-terminal-panel.ai-terminal-session-view .ai-terminal-remote-attach-row').join('\n');
  expect(capped).toMatch(/max-height:\s*min\(/);
  expect(capped).toMatch(/overflow-y:\s*auto/);
  expect(bar).toContain('[data-keyboard="open"] .ai-terminal-remote-attach-row[data-attention="false"][data-expanded="false"] { display: none; }');
});
