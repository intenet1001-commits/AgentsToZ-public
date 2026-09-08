import { describe, expect, test } from 'bun:test';
import { diagnoseOnboardingDevice } from '../src/onboardingDiagnosis';

describe('온보딩 로컬 단말 진단', () => {
  test('아무 설정도 없는 공개 레포 클론은 첫/추가 단말 여부를 한 번 확인한다', () => {
    expect(diagnoseOnboardingDevice({})).toEqual({
      stage: 'fresh',
      recommendedAction: 'choose-first-or-additional',
      hasSupabaseConfig: false,
      hasDeviceIdentity: false,
      localAdminPresent: false,
      canCreateAdditionalDeviceInvite: false,
      needsExistingDeviceAnswer: true,
    });
  });

  test('등록 대기 UUID는 새로 만들지 않고 추가 단말 등록을 이어간다', () => {
    const result = diagnoseOnboardingDevice({
      supabaseUrl: 'https://example.supabase.co',
      supabaseAnonKey: 'sb_publishable_example',
      deviceId: '11111111-1111-4111-8111-111111111111',
      pendingDeviceRegistration: true,
      localAdminPresent: true,
    });
    expect(result.stage).toBe('additional-pending');
    expect(result.recommendedAction).toBe('resume-additional-registration');
    expect(result.canCreateAdditionalDeviceInvite).toBe(false);
  });

  test('확정된 로컬 신원은 첫/추가를 다시 묻지 않고 다른 PC 초대를 권한다', () => {
    const result = diagnoseOnboardingDevice({
      supabaseUrl: 'https://example.supabase.co',
      supabaseAnonKey: 'eyJpublic',
      deviceId: '11111111-1111-4111-8111-111111111111',
      pendingDeviceRegistration: false,
      localAdminPresent: true,
    });
    expect(result.stage).toBe('registered');
    expect(result.recommendedAction).toBe('create-additional-device-invite');
    expect(result.canCreateAdditionalDeviceInvite).toBe(true);
    expect(result.needsExistingDeviceAnswer).toBe(false);
  });

  test('URL만 남은 중간 상태를 등록 완료로 과장하지 않는다', () => {
    const result = diagnoseOnboardingDevice({
      supabaseUrl: 'https://example.supabase.co',
      supabaseAnonKey: 'eyJpublic',
    });
    expect(result.stage).toBe('configured-unregistered');
    expect(result.recommendedAction).toBe('finish-current-setup');
    expect(result.canCreateAdditionalDeviceInvite).toBe(false);
  });
});
