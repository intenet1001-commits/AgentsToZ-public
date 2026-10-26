import {describe, expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ControlProfilePanel} from '../src/ControlProfilePanel';

const noop = () => {};
const render = (props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(ControlProfilePanel, {onClose: noop, onOpenWork: noop, ...props}));

describe('아젠투지 설정 offers the OPS restore a second Mac needs', () => {
  test('a Mac without an OPS folder that found another Mac\'s OPS gets the restore button and that Mac\'s name', () => {
    const html = render({onRestoreOps: noop, restoreFrom: '1호'});
    expect(html).toContain('data-testid="control-profile-restore"');
    expect(html).toContain('1호에서 쓰는 아젠투지(OPS)가 있습니다');
    expect(html).toContain('다른 Mac의 아젠투지 복원');
  });

  test('no button without the restore action, and none before anything says another Mac exists', () => {
    expect(render({restoreFrom: '1호'})).not.toContain('control-profile-restore');
    expect(render({onRestoreOps: noop})).not.toContain('control-profile-restore');
  });

  test('the app hands the panel the restore only when this Mac has no OPS folder', () => {
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    expect(app).toContain("onRestoreOps={controlCenterProject?undefined:()=>{setShowControlProfile(false);void handleOnboardingControlCenter('restore');}}");
    // The restore continues the first candidate with a memory ID, so that is the Mac the panel names.
    expect(app).toContain('restoreFrom={controlCenterProject?undefined:(opsRemoteCandidates.find(candidate=>candidate.memoryId)??opsRemoteCandidates[0])?.deviceName}');
    expect(app).toContain('const joinable = opsRemoteCandidates.find(candidate => candidate.memoryId);');
  });
});
