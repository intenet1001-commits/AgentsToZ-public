import { describe, expect, test } from "bun:test";
import { createDesktopDeviceInvite, parseOnboardingHandoff, isPublicSupabaseClientKey } from "../src/onboardingHandoff";

const jwt = (role: string) => [Buffer.from(JSON.stringify({alg: 'HS256', typ: 'JWT'})).toString('base64url'),
  Buffer.from(JSON.stringify({role})).toString('base64url'), 'test-signature'].join('.');
const anon = jwt('anon');
const exampleProjectRef = ["abcdefghijkl", "mnopqrst"].join("");
const exampleSupabaseUrl = `https://${exampleProjectRef}.${["supabase", "co"].join(".")}`;

describe("additional-device onboarding handoff", () => {
  test("creates a v3 desktop invite without pre-allocating identity or carrying admin credentials", () => {
    const raw = createDesktopDeviceInvite({
      supabaseUrl: exampleSupabaseUrl,
      supabaseAnonKey: anon,
      suggestedDeviceName: "Office PC",
    });
    const encoded = JSON.parse(raw);
    expect(encoded).toEqual({
      v: 3,
      type: "portmgr-device-invite",
      url: exampleSupabaseUrl,
      key: anon,
      deviceName: "Office PC",
    });
    expect(encoded.deviceId).toBeUndefined();
    expect(encoded.serviceRoleKey).toBeUndefined();
    expect(encoded.accessToken).toBeUndefined();
    expect(parseOnboardingHandoff(raw)).toEqual({
      version: 3,
      supabaseUrl: exampleSupabaseUrl,
      supabaseAnonKey: anon,
      deviceName: "Office PC",
      freshDeviceRequired: true,
    });
  });

  test("accepts the portal v2 payload and normalizes its device fields", () => {
    expect(parseOnboardingHandoff(JSON.stringify({
      v: 2,
      type: "portmgr-onboard",
      deviceId: "11111111-1111-4111-8111-111111111111",
      deviceName: "Office PC",
      url: exampleSupabaseUrl,
      key: anon,
    }))).toEqual({
      version: 2,
      supabaseUrl: exampleSupabaseUrl,
      supabaseAnonKey: anon,
      deviceId: "11111111-1111-4111-8111-111111111111",
      deviceName: "Office PC",
    });
  });

  test("accepts Supabase's new publishable client key in a v3 invite", () => {
    const raw = createDesktopDeviceInvite({
      supabaseUrl: exampleSupabaseUrl,
      supabaseAnonKey: "sb_publishable_example",
      suggestedDeviceName: "Second PC",
    });

    expect(parseOnboardingHandoff(raw)).toMatchObject({
      version: 3,
      supabaseAnonKey: "sb_publishable_example",
      freshDeviceRequired: true,
    });
  });

  test("keeps the v1 setup payload backward compatible", () => {
    expect(parseOnboardingHandoff(JSON.stringify({
      v: 1,
      type: "portmanager-setup",
      device: "22222222-2222-4222-8222-222222222222",
      deviceName: "Legacy Mac",
      url: exampleSupabaseUrl,
      key: anon,
      pwHash: "legacy-only",
    }))).toEqual({
      version: 1,
      supabaseUrl: exampleSupabaseUrl,
      supabaseAnonKey: anon,
      deviceId: "22222222-2222-4222-8222-222222222222",
      deviceName: "Legacy Mac",
      passwordHash: "legacy-only",
    });
  });

  test("rejects unrelated or malformed payloads", () => {
    expect(() => parseOnboardingHandoff("{}"))
      .toThrow("portmanager onboarding 형식이 아닙니다");
    expect(() => parseOnboardingHandoff(JSON.stringify({
      v: 2,
      type: "portmgr-onboard",
      url: "https://attacker.example",
      key: "eyJ-anon",
    }))).toThrow("URL 형식이 잘못되었습니다");
  });
});


test('invite guards reject privileged keys and malformed values without disclosing them', () => {
  for (const key of [jwt('service_role'), jwt('authenticated'), 'eyJ-not-a-jwt', 'sb_secret_test',
    'sb_publishable_', 'sb_publishable_test\nsecret', 'x'.repeat(8193)]) {
    expect(isPublicSupabaseClientKey(key)).toBe(false);
    expect(() => createDesktopDeviceInvite({supabaseUrl: exampleSupabaseUrl,
      supabaseAnonKey: key, suggestedDeviceName: 'Mac'})).toThrow('Anon/publishable');
  }
  for (const raw of ['null', '[]', 'true', '"text"']) {
    expect(() => parseOnboardingHandoff(raw)).toThrow('onboarding');
  }
  for (const url of ['https://user@project.supabase.co', 'https://project.supabase.co/path',
    'https://project.supabase.co:443', 'https://project.supabase.co?x=1']) {
    expect(() => createDesktopDeviceInvite({supabaseUrl: url, supabaseAnonKey: anon,
      suggestedDeviceName: 'Mac'})).toThrow('URL');
  }
});
