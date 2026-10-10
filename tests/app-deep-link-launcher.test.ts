import {expect,test} from 'bun:test';
import {runAppDeepLinkCommand} from '../src/appDeepLinkLauncher';

function launcher(output = '') {
  let finish!: (code: number) => void;
  let writes!: ReadableStreamDefaultController<Uint8Array>;
  const exited = new Promise<number>(resolve => {finish = code => {writes.enqueue(new TextEncoder().encode(output));writes.close();resolve(code)};});
  const stderr = new ReadableStream<Uint8Array>({start(controller) {writes = controller}});
  let killed = false;
  return {
    child: {exited, stderr, kill: (_signal: string) => {killed = true; finish(137)}},
    finish,
    get killed() {return killed},
  };
}

test('desktop link launch awaits its process without blocking other API work',async()=>{
  const process = launcher();
  const pending = runAppDeepLinkCommand(['/usr/bin/open','codex://threads/fixture'],'open failed',{
    spawn: () => process.child,
  });
  let unrelatedWorkRan = false;
  await Promise.resolve().then(() => {unrelatedWorkRan = true});
  expect(unrelatedWorkRan).toBe(true);
  process.finish(0);
  await expect(pending).resolves.toBeUndefined();
  expect(process.killed).toBe(false);
});

test('desktop link launch reports stderr and kills only its launcher at the deadline',async()=>{
  const failed = launcher('handler unavailable');
  const failure = runAppDeepLinkCommand(['open','bad-url'],'open failed',{spawn: () => failed.child});
  failed.finish(1);
  await expect(failure).rejects.toThrow('handler unavailable');

  const hung = launcher();
  await expect(runAppDeepLinkCommand(['open','hung-url'],'open timed out',{spawn: () => hung.child,timeoutMs: 10})).rejects.toThrow('open timed out');
  expect(hung.killed).toBe(true);
});
