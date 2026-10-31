import {expect, test} from 'bun:test';
import {workModeCopy, workModeMessages} from '../src/i18n';
import {screenHelperLines, type ScreenHelperStatus} from '../src/workModeScreenHelper';

const ko = workModeCopy('ko');
const running = (state: ScreenHelperStatus['state']): ScreenHelperStatus => ({supported: true, installed: true, running: true, state});

test('the panel says where AgentsToZ Screen is before anything about its state', () => {
  expect(screenHelperLines({supported: true, installed: false, running: false, state: null}, ko)).toEqual({line: ko.screenMissing, notes: [], canOpen: true});
  expect(screenHelperLines({supported: false, installed: false, running: false, state: null}, ko).canOpen).toBe(false);
  expect(screenHelperLines({supported: true, installed: true, running: false, state: null}, ko)).toEqual({line: ko.screenStopped, notes: [], canOpen: true});
  // A development build runs from elsewhere: still openable, and an unreadable state is said as such.
  expect(screenHelperLines({supported: true, installed: false, running: true, state: null}, ko)).toEqual({line: ko.screenUnknown, notes: [], canOpen: true});
});

test('on, off and starting, with what still needs doing', () => {
  const base = {viewing: false, devices: 0, capture: true, control: true, loginItem: 'off'} as const;
  expect(screenHelperLines(running({...base, power: 'off'}), ko).line).toBe(ko.screenOff);
  expect(screenHelperLines(running({...base, power: 'starting'}), ko).line).toBe(ko.screenStarting);
  expect(screenHelperLines(running({...base, power: 'on'}), ko).line).toBe(ko.screenOnNone);
  expect(screenHelperLines(running({...base, power: 'on', devices: 3}), ko).line).toBe('화면 제어 켜짐 · 등록된 기기 3대');
  expect(screenHelperLines(running({...base, power: 'on', devices: 1, viewing: true, capture: false, control: false, loginItem: 'approval'}), ko).notes)
    .toEqual([ko.screenViewing, ko.screenNoCapture, ko.screenNoControl, ko.screenLoginApproval]);
});

test('on but off an approved network is not shown as ready for devices', () => {
  // 결정 4: AgentsToZ Screen accepts connections only on networks approved at the Mac. While it waits, registered
  // devices cannot connect, so the count of devices that "can connect" would mislead.
  const waiting = screenHelperLines(running({viewing: false, devices: 2, capture: true, control: true, loginItem: 'off', power: 'waiting'}), ko);
  expect(waiting.line).toBe(ko.screenWaiting);
  expect(waiting.line).not.toContain('2');
  for (const copy of Object.values(workModeMessages)) {
    expect(copy.screenWaiting).toContain('AgentsToZ Screen');
    expect(copy.screenWaiting).not.toBe(copy.screenOn);
  }
  // Neutral: waiting also means no network, a router not identified yet or a network without one that can never be
  // approved. AgentsToZ Screen says which; the status file does not carry the reason.
  expect(ko.screenWaiting).not.toContain('에서 승인');
  expect(workModeMessages.en.screenWaiting).not.toMatch(/approve it/i);
});

test('every language has the device count slot and says where to tap on the phone', () => {
  for (const copy of Object.values(workModeMessages)) {
    expect(copy.screenOn).toContain('{n}');
    expect(copy.screenHint).toContain('Mac 화면');
  }
});
