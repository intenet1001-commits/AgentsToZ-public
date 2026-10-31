import {describe, expect, test} from 'bun:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {REMOTE_FEATURE_CHECKING, remoteFeatureAvailability} from '../src/remoteFeatureAvailability';
import {RemoteCommonMemoryPanel} from '../src/RemoteCommonMemoryPanel';
import {RemoteDeviceMemoryPanel} from '../src/RemoteDeviceMemoryPanel';
import {RemoteMetaCommonMemoryPanel} from '../src/RemoteMetaCommonMemoryPanel';
import {MobileWorkspacePanel} from '../src/MobileWorkspacePanel';

// 2026-11-01: the phone's 기록 tab told the owner of a current (1639) Mac to update it. The legacy capability answer is
// capped at eight names and never carries 공통기억/기기 기억, so until the extended manifest is confirmed a missing name
// proves nothing.
describe('remoteFeatureAvailability', () => {
  const legacy = ['ai-terminal-references-v1', 'workspace-v1', 'meta-memory-v1'];
  test('ready whenever the name is listed', () => {
    expect(remoteFeatureAvailability({supportedFeatures: legacy}, 'workspace-v1')).toBe('ready');
    expect(remoteFeatureAvailability({supportedFeatures: legacy, featuresProbing: true}, 'meta-memory-v1')).toBe('ready');
  });
  test('checking while nothing is known, while a probe runs, or before the extended manifest is confirmed', () => {
    expect(remoteFeatureAvailability({supportedFeatures: null}, 'goal-common-memory-v1')).toBe('checking');
    expect(remoteFeatureAvailability({supportedFeatures: legacy, featuresProbing: true, extendedCapabilitiesChecked: true}, 'device-memory-v1')).toBe('checking');
    expect(remoteFeatureAvailability({supportedFeatures: legacy, extendedCapabilitiesChecked: false}, 'goal-common-memory-v1')).toBe('checking');
    // A status from a controller that predates the flag is unconfirmed too.
    expect(remoteFeatureAvailability({supportedFeatures: legacy}, 'device-memory-v1')).toBe('checking');
  });
  test('update-required only from a confirmed manifest (or an old Mac\'s refusal) without the name', () => {
    expect(remoteFeatureAvailability({supportedFeatures: legacy, extendedCapabilitiesChecked: true}, 'device-memory-v1')).toBe('update-required');
    expect(remoteFeatureAvailability({supportedFeatures: [], extendedCapabilitiesChecked: true}, 'workspace-v1')).toBe('update-required');
  });
});

describe('기록 panels say 「checking」, not 「update the Mac app」, while the features are unconfirmed', () => {
  const transport = async () => { throw new Error('not used'); };
  const UPDATE = /업데이트/;
  test('공통기억 (cloud)', () => {
    const checking = renderToStaticMarkup(<RemoteCommonMemoryPanel visible available={false} checking online transport={transport}/>);
    expect(checking).toContain(REMOTE_FEATURE_CHECKING);
    expect(checking).not.toMatch(UPDATE);
    const old = renderToStaticMarkup(<RemoteCommonMemoryPanel visible available={false} online transport={transport}/>);
    expect(old).toContain('연결한 Mac 앱을 업데이트하면 클라우드 공통기억을 관리할 수 있습니다.');
  });
  test('기기 기억', () => {
    const checking = renderToStaticMarkup(<RemoteDeviceMemoryPanel visible available={false} checking online transport={transport}/>);
    expect(checking).toContain(REMOTE_FEATURE_CHECKING);
    expect(checking).not.toMatch(UPDATE);
    expect(renderToStaticMarkup(<RemoteDeviceMemoryPanel visible available={false} online transport={transport}/>)).toContain('연결한 Mac 앱을 업데이트하세요.');
  });
  test('이전 로컬 기억', () => {
    const checking = renderToStaticMarkup(<RemoteMetaCommonMemoryPanel visible available={false} checking online transport={transport}/>);
    expect(checking).toContain(REMOTE_FEATURE_CHECKING);
    expect(checking).not.toMatch(UPDATE);
    expect(renderToStaticMarkup(<RemoteMetaCommonMemoryPanel visible available={false} online transport={transport}/>)).toContain('연결한 Mac 앱을 업데이트하면 공통기억을 관리할 수 있습니다.');
  });
  test('내가 한 말', () => {
    const checking = renderToStaticMarkup(<MobileWorkspacePanel mode="records" projects={[]} available={false} checking online transport={transport} onDraft={() => {}}/>);
    expect(checking).toContain(REMOTE_FEATURE_CHECKING);
    expect(checking).not.toMatch(UPDATE);
    expect(renderToStaticMarkup(<MobileWorkspacePanel mode="records" projects={[]} available={false} online transport={transport} onDraft={() => {}}/>))
      .toContain('연결한 Mac 앱을 업데이트하면 기록 조회·세션 저장·대직 관리를 사용할 수 있습니다.');
  });
  test('offline still says to connect, before anything about features', () => {
    const offline = renderToStaticMarkup(<RemoteCommonMemoryPanel visible available={false} checking online={false} transport={transport}/>);
    expect(offline).not.toContain(REMOTE_FEATURE_CHECKING);
    expect(offline).toContain('관리할 Mac에 연결하면');
  });
  test('the portal passes the checking state to every 기록 panel', () => {
    const source = readFileSync(join(import.meta.dir, '../src/remote-control-portal-main.tsx'), 'utf8');
    for (const feature of ['COMMON_MEMORY_REMOTE_FEATURE', 'DEVICE_MEMORY_FEATURE', 'META_MEMORY_REMOTE_FEATURE', 'MOBILE_WORKSPACE_FEATURE']) {
      expect(source).toContain(`checking={featureChecking(${feature})}`);
    }
    expect(source).toContain("remoteFeatureAvailability(status,feature)==='checking'");
  });
});
