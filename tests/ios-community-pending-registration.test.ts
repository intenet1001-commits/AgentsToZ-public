import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const app=(name:string)=>readFileSync(join(import.meta.dir,'../mobile/ios/App',name),'utf8');
test('the original iPad comparison and expiry appear beside the waiting header, before manager actions',()=>{
  const view=app('ScreenUnifiedEnrollment.swift').split('struct ScreenUnifiedEnrollmentView: View')[1]!;
  expect(view.indexOf('Section("이 기기의 등록 코드")')).toBeGreaterThan(view.indexOf('Text(center.unified.message)'));
  expect(view.indexOf('Section("이 기기의 등록 코드")')).toBeLessThan(view.indexOf('Section("관리 역할·승인 요청")'));
  expect(view.match(/Section\("이 기기의 등록 코드"\)/g)).toHaveLength(1);
  expect(view).toContain('if center.unified.review == nil, let code = center.unified.registrationCode');
  expect(view).toContain('accessibilityIdentifier("screenCommunityRegistrationCode")');
  expect(view).toContain('accessibilityIdentifier("screenCommunityRegistrationExpiry")');
});
test('only a successful v2 pending lookup followed by a failed legacy certificate lookup can retain the comparison',()=>{
  const source=app('ScreenCommunityDevices.swift'),refresh=source.split('func refresh() async {')[1]!.split('func receive(')[0]!;
  expect(refresh.indexOf('try await unified.refresh(account: account')).toBeLessThan(refresh.indexOf('unifiedRefreshSucceeded = true'));
  expect(refresh).toContain('legacyCertificateLookupFailed = true\n                certificate = try await model.refreshSelfCertificate()\n                legacyCertificateLookupFailed = false');
  expect(refresh).toContain('preservesPending(afterLegacyError: code,');
  expect(refresh).toContain('unifiedRefreshSucceeded: unifiedRefreshSucceeded, legacyCertificateLookupFailed: legacyCertificateLookupFailed');
  expect(refresh).toContain('hasAuthorization: unified.authorization != nil');
  expect(refresh).toContain('else { unified.endLocally() }');
  expect(refresh).toContain('["NOT_ENROLLED", "REGISTRATION_REVOKED"].contains(code)');
  expect(refresh).toContain('macs = []; registered = false; administrator = false; directory = nil; certificate = nil; pending = []; expiry?.cancel()');
  expect(refresh).toContain('if preservePending { message = unified.message; return }');
  expect(refresh).not.toContain('unified.request(');
});
