import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HERMES_COMMAND_HOST_LABELS,
  hermesCommandHostNotes,
  isHermesCommandAvailable,
  parseHermesCommandHost,
} from "../src/hermesCommandHost";

const panel = readFileSync(join(import.meta.dir, "../src/ProjectMemoryPanel.tsx"), "utf8");

describe("Hermes 명령을 붙여넣는 호스트", () => {
  test("깨진 값·빈 값은 로컬로 떨어진다", () => {
    // 원격으로 잘못 떨어지면 설치 버튼이 통째로 사라져 고장으로 읽힌다.
    expect(parseHermesCommandHost(null)).toBe("local");
    expect(parseHermesCommandHost("")).toBe("local");
    expect(parseHermesCommandHost("{bogus}")).toBe("local");
    expect(parseHermesCommandHost("local")).toBe("local");
    expect(parseHermesCommandHost("remote")).toBe("remote");
  });

  test("창을 여는 명령만 원격에서 해당 없음이 된다", () => {
    // 실측 근거: AWS 설치 검증이 요구하는 스킬은 6개이고 hermes-open이 빠져 있다.
    expect(isHermesCommandAvailable("remote", { desktopOnly: true })).toBe(false);
    expect(isHermesCommandAvailable("local", { desktopOnly: true })).toBe(true);
    for (const host of ["local", "remote"] as const) {
      expect(isHermesCommandAvailable(host, {})).toBe(true);
    }
  });

  test("호스트마다 무엇이 저장되는지가 달라진다", () => {
    expect(hermesCommandHostNotes("remote").captures).toContain("AWS에 clone된 폴더");
    expect(hermesCommandHostNotes("remote").captures).toContain("이 Mac에서 한 작업은 담기지 않습니다");
    expect(hermesCommandHostNotes("local").captures).toContain("이 Mac");
    expect(hermesCommandHostNotes("local").desktopUnavailable).toBeNull();
    expect(hermesCommandHostNotes("remote").desktopUnavailable).toBeTruthy();
  });

  // 축은 "Telegram으로 무엇을 제어하는가"다. 대상만 적으면 로컬 터미널에서 Hermes를
  // 쓰는 이야기와 섞여 읽힌다 — 그 둘은 이미 패널의 다른 줄이 맡고 있다.
  test("라벨과 설명이 Telegram 제어 대상을 말한다", () => {
    expect(HERMES_COMMAND_HOST_LABELS.local).toBe("Telegram → 이 PC의 Hermes");
    expect(HERMES_COMMAND_HOST_LABELS.remote).toBe("Telegram → AWS의 Hermes");
    expect(hermesCommandHostNotes("local").gateway).toContain("이 Mac에서 도는 Hermes gateway");
    expect(hermesCommandHostNotes("remote").gateway).toContain("AWS에서 도는 Hermes gateway");
  });

  // 두 경로를 실제로 가르는 이유는 대개 "맥이 꺼져 있어도 도는가"다.
  test("언제 응답하는지를 밝힌다", () => {
    expect(hermesCommandHostNotes("local").uptime).toContain("이 Mac이 켜져 있고");
    expect(hermesCommandHostNotes("remote").uptime).toContain("이 Mac이 꺼져 있어도");
  });
});

describe("호스트 스위치는 목록을 복제하지 않는다", () => {
  test("명령 표는 한 벌뿐이다", () => {
    // 7개 중 6개가 글자까지 같아서, 목록을 두 벌로 가르면 중복이 그만큼 돌아온다.
    expect(panel.match(/const hermesTopicCommands/g)?.length).toBe(1);
    expect(panel).not.toContain('data-testid="project-memory-aws-telegram-commands"');
  });

  test("스위치와 그 결과가 화면에 있다", () => {
    // 칩은 HERMES_COMMAND_HOSTS 를 돌며 렌더되므로 testid 가 템플릿이다.
    expect(panel).toContain('data-testid={`project-memory-hermes-host-${host}`}');
    expect(panel).toContain('HERMES_COMMAND_HOSTS.map(host =>');
    expect(panel).toContain('data-testid="project-memory-hermes-host-captures"');
    expect(panel).toContain('isHermesCommandAvailable(hermesHost, item)');
    expect(panel).toContain("desktopOnly: true");
  });

  test("원격일 때 로컬 설치 상태를 그대로 두지 않는다", () => {
    // 읽을 수 없는 호스트를 로컬 판정으로 칠하면 잘 도는 명령이 미설치로 보인다.
    expect(panel).toContain("const hermesTracksInstalls = hermesHost === 'local'");
    expect(panel).toContain("{hermesHost === 'local' && hermesAdapter && (");
    expect(panel).toContain('data-testid="project-memory-hermes-remote-install-note"');
  });

  test("선택은 기기별로 남는다", () => {
    expect(panel).toContain('HERMES_COMMAND_HOST_STORAGE_KEY');
    expect(panel).toContain('localStorage.setItem(HERMES_COMMAND_HOST_STORAGE_KEY, next)');
  });
});
