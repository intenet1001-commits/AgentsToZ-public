import {expect, test} from 'bun:test';
import {portSuggestionOrder} from '../src/portSuggestion';

test('each suggestion continues after the port currently shown, wrapping around (VOC 2026-09-24)', () => {
  expect([...portSuggestionOrder(9000, 9004, '9002')]).toEqual([9003, 9004, 9000, 9001]);
  expect([...portSuggestionOrder(9000, 9004, '')]).toEqual([9000, 9001, 9002, 9003, 9004]);
  expect([...portSuggestionOrder(9000, 9004, '9004')]).toEqual([9000, 9001, 9002, 9003]);
  // A value outside the range (or garbage) starts at the beginning of the range.
  expect([...portSuggestionOrder(9000, 9002, '3000')]).toEqual([9000, 9001, 9002]);
  expect([...portSuggestionOrder(9000, 9002, 'abc')]).toEqual([9000, 9001, 9002]);
});
