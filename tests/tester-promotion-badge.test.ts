import {expect,test} from 'bun:test';
import {testerPromotionCounts,testerPromotionSignature,TESTER_PROMOTION_RECHECK_MS} from '../src/testerPromotionBadge';

const paths=['/a/one','/b/two'];
const now=1_000_000_000_000;

test('an empty collection stops lighting the badge for the same projects', ()=>{
  expect(testerPromotionCounts(paths,null,now)).toBe(true);                // never collected
  const memo={signature:testerPromotionSignature(paths),ready:0,at:now};
  expect(testerPromotionCounts(paths,memo,now+1000)).toBe(false);          // just told «none yet»
  expect(testerPromotionCounts([...paths].reverse(),memo,now)).toBe(false); // order does not matter
});

test('it counts again when there is something to do or something changed', ()=>{
  const memo={signature:testerPromotionSignature(paths),ready:0,at:now};
  expect(testerPromotionCounts([...paths,'/c/three'],memo,now)).toBe(true);           // a new project gained checks
  expect(testerPromotionCounts(paths,memo,now+TESTER_PROMOTION_RECHECK_MS)).toBe(true); // runs accumulate over a week
  expect(testerPromotionCounts(paths,{...memo,ready:2},now)).toBe(true);              // real candidates stay counted
  expect(testerPromotionCounts([],null,now)).toBe(false);
});
