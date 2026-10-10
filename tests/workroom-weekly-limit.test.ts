import {expect,test} from 'bun:test';
import {pickWeeklyLimit,weeklyLimitResetLabel} from '../src/workroomWeeklyLimit';

test('picks the weekly window by its length, whichever slot it is in', () => {
  // Measured shape (Pro Lite, 2026-09-26): only primary, and it is the week.
  expect(pickWeeklyLimit({primary:{used_percent:73,window_minutes:10080,resets_at:1790813143},secondary:null}))
    .toEqual({usedPercent:73,remainingPercent:27,resetsAt:1790813143});
  expect(pickWeeklyLimit({primary:{used_percent:12,window_minutes:300},secondary:{used_percent:40.5,window_minutes:10080}}))
    .toEqual({usedPercent:40.5,remainingPercent:59.5,resetsAt:null});
});

test('shows nothing rather than guessing when there is no weekly window', () => {
  expect(pickWeeklyLimit({primary:{used_percent:12,window_minutes:300}})).toBeNull();
  expect(pickWeeklyLimit({primary:{window_minutes:10080}})).toBeNull();
  expect(pickWeeklyLimit(null)).toBeNull();
});

test('clamps and formats', () => {
  expect(pickWeeklyLimit({primary:{used_percent:130,window_minutes:10080}})?.remainingPercent).toBe(0);
  expect(weeklyLimitResetLabel(null)).toBe('');
  expect(weeklyLimitResetLabel(1790813143)).toMatch(/^\d{1,2}\/\d{1,2} \d{2}:\d{2} 초기화$/);
});
