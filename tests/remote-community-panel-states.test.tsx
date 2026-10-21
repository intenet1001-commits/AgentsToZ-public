import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { REMOTE_COMMUNITY_SENT_NOTICE, RemoteCommunityPanel, type RemoteCommunityPanelProps } from '../src/RemoteCommunityPanel';

// Production audit 2026-10-16: the community pane said 「Mac 앱 업데이트 필요」 whenever the Mac's features were merely
// unknown — no Mac paired, the capability probe not answered yet, a closed session — and 「확인하고 있습니다…」 forever
// for a Mac that was not online. And after sending it promised an AI would receive what was only left in the room.
const render = (props: Partial<RemoteCommunityPanelProps>) => renderToStaticMarkup(createElement(RemoteCommunityPanel, {
  opsTargetId: 'ops-control', visible: true, online: true, available: true,
  transport: async () => { throw new Error('no request expected while rendering'); },
  onDriveDevice() {},
  ...props,
}));

describe('the community pane says what it knows', () => {
  test('no Mac connected: connect first — never 「update the Mac」', () => {
    for (const available of [null, false, true] as const) {
      const html = render({ online: false, available });
      expect(html).toContain('data-testid="remote-community-offline"');
      expect(html).not.toContain('remote-community-update-required');
      expect(html).not.toContain('확인하고 있습니다');
    }
  });

  test('connected, features not known yet: checking, not 「update required」', () => {
    const html = render({ online: true, available: null });
    expect(html).toContain('data-testid="remote-community-checking"');
    expect(html).not.toContain('업데이트');
  });

  test('a Mac that answered without the feature is the one that needs updating', () => {
    expect(render({ online: true, available: false })).toContain('data-testid="remote-community-update-required"');
    expect(render({ online: true, available: true })).toContain('data-testid="remote-community"');
  });

  test('sending leaves the message in the room; nothing reaches an AI by itself', () => {
    expect(REMOTE_COMMUNITY_SENT_NOTICE).toContain('남겼습니다');
    expect(REMOTE_COMMUNITY_SENT_NOTICE).not.toMatch(/AI가 받습니다|총괄 AI/);
    expect(REMOTE_COMMUNITY_SENT_NOTICE).toContain('읽어줘');
  });
});
