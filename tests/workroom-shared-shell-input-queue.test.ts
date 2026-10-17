import {expect,test} from 'bun:test';
import {createSharedShellInputQueue} from '../src/workroomSharedShellInputQueue';

function deferred(){
  let resolve!:()=>void;
  const promise=new Promise<void>(done=>{resolve=done});
  return {promise,resolve};
}

test('shared shell paste chunks and Enter reach the transport in input order',async()=>{
  const first=deferred(),sent:string[]=[],errors:unknown[]=[];
  const queue=createSharedShellInputQueue(async(part,shellId)=>{
    expect(shellId).toBe('shell-1234');
    sent.push(part);
    if(sent.length===1)await first.promise;
  },error=>errors.push(error));
  queue.enqueue('x'.repeat(4096)+'Y','shell-1234');
  queue.enqueue('\r','shell-1234');
  await Promise.resolve();
  expect(sent).toEqual(['x'.repeat(4096)]);
  first.resolve();
  await queue.drain();
  expect(sent).toEqual(['x'.repeat(4096),'Y','\r']);
  expect(errors).toEqual([]);
});

test('failed input does not block later input, and invalidation drops unsent old-shell input',async()=>{
  const first=deferred(),sent:string[]=[],errors:unknown[]=[];
  let calls=0;
  const queue=createSharedShellInputQueue(async(part,shellId)=>{
    sent.push(`${shellId}:${part}`);
    if(++calls===1){await first.promise;throw Error('first write failed');}
  },error=>errors.push(error));
  queue.enqueue('a'.repeat(4096)+'stale','shell-old');
  await Promise.resolve();
  queue.invalidate();
  queue.enqueue('fresh\r','shell-new');
  first.resolve();
  await queue.drain();
  expect(sent).toEqual([`shell-old:${'a'.repeat(4096)}`,'shell-new:fresh\r']);
  expect(errors).toEqual([]);
  queue.enqueue('after\r','shell-new');
  await queue.drain();
  expect(sent.at(-1)).toBe('shell-new:after\r');
});

test('a failed input reports its error and the next input still sends',async()=>{
  const sent:string[]=[],errors:unknown[]=[];
  const queue=createSharedShellInputQueue(async(part)=>{sent.push(part);if(part==='bad')throw Error('write failed');},error=>errors.push(error));
  queue.enqueue('bad','shell-1234');
  queue.enqueue('good','shell-1234');
  await queue.drain();
  expect(sent).toEqual(['bad','good']);
  expect(errors).toHaveLength(1);
  expect(String(errors[0])).toContain('write failed');
});
