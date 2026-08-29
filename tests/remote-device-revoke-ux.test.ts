import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  buildAwsRuntimePreparationPrompt,
  describeRemoteDeviceError,
  parseRemoteRuntimeReadiness,
} from '../src/RemoteDeviceManager';

const source = readFileSync(new URL('../src/RemoteDeviceManager.tsx', import.meta.url), 'utf8');

describe('클라우드 단말 등록 해제 안전장치', () => {
  test('브라우저 기본 confirm이 아니라 화면 안 2단계 확인을 쓴다', () => {
    expect(source).not.toContain('window.confirm');
    expect(source).toContain('접속 자격을 폐기할까요?');
    expect(source).toContain('접속 자격 폐기');
    expect(source).toContain('이력 승계 재연결');
  });

  test('회원 오류 코드를 사용자가 해결 가능한 문장으로 바꾼다', () => {
    const message = describeRemoteDeviceError(new Error('PORTMGR_MEMBER_REQUIRED'));
    expect(message).not.toContain('PORTMGR_MEMBER_REQUIRED');
    expect(message).toContain('DB 허용 회원');
  });
});

describe('AWS 초보자 런타임 준비 게이트', () => {
  test('새 보고 형식은 비밀값 없이 Bun/API/Hermes 준비 상태를 구분하고 예전 보고는 미확인으로 둔다', () => {
    expect(parseRemoteRuntimeReadiness('4|b1a0h1')).toEqual({
      agentVersion: '4',
      reported: true,
      bunReady: true,
      apiReady: false,
      hermesReady: true,
    });
    expect(parseRemoteRuntimeReadiness('4')).toEqual({
      agentVersion: '4',
      reported: false,
      bunReady: null,
      apiReady: null,
      hermesReady: null,
    });
  });

  test('AI 준비 프롬프트는 기존 자원을 재사용하고 변경·비밀 노출을 먼저 막는다', () => {
    const prompt = buildAwsRuntimePreparationPrompt({
      display_name: 'Hermes AWS',
      hostname: 'ip-10-0-0-1',
      environment_kind: 'aws',
      default_workspace_root: '/home/ubuntu/projects',
      agent_version: '4|b1a0h0',
    });
    expect(prompt).toContain('기존 GitHub·Supabase·Vercel 자원을 그대로 사용');
    expect(prompt).toContain('승인 전에는 실행하지 마세요');
    expect(prompt).toContain('비밀 파일 내용은 열지 마세요');
    expect(prompt).toContain('Hermes와 Telegram은 선택 기능');
    expect(prompt).toContain('프로젝트 연결 가능');
    expect(prompt).not.toContain('ip-10-0-0-1');
    expect(prompt).not.toContain('/home/ubuntu/projects');
  });

  test('UI는 호스트 등록 → 런타임 준비 → 프로젝트 연결 순서와 API 게이트를 보여준다', () => {
    expect(source).toContain('data-testid="remote-onboarding-steps"');
    expect(source).toContain('data-testid="remote-runtime-preparation"');
    expect(source).toContain("parseRemoteRuntimeReadiness(device.agent_version).apiReady !== true");
    expect(source).toContain('아무 AI에나 붙여넣을 준비 프롬프트 복사');
    expect(source).toContain('enrollmentPollInFlightRef.current');
    expect(source).toContain('.abortSignal(controller.signal)');
  });
});
