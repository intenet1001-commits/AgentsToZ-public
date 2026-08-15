import { describe, expect, test } from "bun:test";
import { parseOnboardingHandoff } from "../src/onboardingHandoff";

describe("additional-device onboarding handoff", () => {
  test("accepts the portal v2 payload and normalizes its device fields", () => {
    expect(parseOnboardingHandoff(JSON.stringify({
      v: 2,
      type: "portmgr-onboard",
      deviceId: "11111111-1111-4111-8111-111111111111",
      deviceName: "Office PC",
      url: "https://abcdefghijklmnopqrst.supabase.co",
      key: "eyJ-public-anon",
    }))).toEqual({
      version: 2,
      supabaseUrl: "https://abcdefghijklmnopqrst.supabase.co",
      supabaseAnonKey: "eyJ-public-anon",
      deviceId: "11111111-1111-4111-8111-111111111111",
      deviceName: "Office PC",
    });
  });

  test("keeps the v1 setup payload backward compatible", () => {
    expect(parseOnboardingHandoff(JSON.stringify({
      v: 1,
      type: "portmanager-setup",
      device: "22222222-2222-4222-8222-222222222222",
      deviceName: "Legacy Mac",
      url: "https://abcdefghijklmnopqrst.supabase.co",
      key: "eyJ-legacy-anon",
      pwHash: "legacy-only",
    }))).toEqual({
      version: 1,
      supabaseUrl: "https://abcdefghijklmnopqrst.supabase.co",
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
