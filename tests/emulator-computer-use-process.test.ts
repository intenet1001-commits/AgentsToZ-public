import {expect,test} from 'bun:test';
import {judgeComputerUseAudit} from '../scripts/emulator-e2e/computerUseProcessLane';

test('J3A requires distinct completed mailbox rows in the A to B direction',()=>{
  const rows=Array.from({length:6},(_,n)=>['pending','taken','done'].map((state,i)=>({control_id:String(n),event:i===0?'insert':'update',state,request_kind:'computer-use',from_endpoint_id:'a',to_endpoint_id:'b'}))).flat();
  expect(judgeComputerUseAudit({audit:{dialogue_controls:rows}},'a','b')).toEqual([]);
  expect(judgeComputerUseAudit({audit:{dialogue_controls:rows}},'b','a')).toHaveLength(1);
  expect(judgeComputerUseAudit({audit:{dialogue_controls:rows.filter(r=>!(r.control_id==='0'&&r.state==='done'))}},'a','b')).toHaveLength(1);
  expect(judgeComputerUseAudit({audit:{dialogue_controls:[...rows,rows[1]]}},'a','b')).toHaveLength(1);
  expect(judgeComputerUseAudit({},'a','b')).toHaveLength(1);
});
