import { describe, expect, test } from "bun:test";
import { createDesktopDeviceInvite, parseOnboardingHandoff } from "../src/onboardingHandoff";

const exampleProjectRef = ["abcdefghijkl", "mnopqrst"].join("");
const exampleSupabaseUrl = `https://${exampleProjectRef}.${["supabase", "co"].join(".")}`;

describe("additional-device onboarding handoff", () => {
  test("creates a v3 desktop invite without pre-allocating identity or carrying admin credentials", () => {
    const raw = createDesktopDeviceInvite({
      supabaseUrl: exampleSupabaseUrl,
      supabaseAnonKey: "eyJ-public-anon",
      suggestedDeviceName: "Office PC",
    });
    const encoded = JSON.parse(raw);
    expect(encoded).toEqual({
      v: 3,
      type: "portmgr-device-invite",
      url: exampleSupabaseUrl,
      key: "eyJ-public-anon",
      deviceName: "Office PC",
    });
    expect(encoded.deviceId).toBeUndefined();
    expect(encoded.serviceRoleKey).toBeUndefined();
    expect(encoded.accessToken).toBeUndefined();
    expect(parseOnboardingHandoff(raw)).toEqual({
      version: 3,
      supabaseUrl: exampleSupabaseUrl,
      supabaseAnonKey: "eyJ-public-anon",
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
      key: "eyJ-public-anon",
    }))).toEqual({
      version: 2,
      supabaseUrl: exampleSupabaseUrl,
      supabaseAnonKey: "eyJ-public-anon",
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
      key: "eyJ-legacy-anon",
      pwHash: "legacy-only",
    }))).toEqual({
      version: 1,
      supabaseUrl: exampleSupabaseUrl,
      supabaseAnonKey: "eyJ-legacy-anon",
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
