import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  CONTROL_CENTER_PROJECT_NAME,
  controlCenterRemoteCandidates,
  resolveControlCenterProject,
} from "../src/controlCenterProject";
import golden from "./fixtures/ops-folder-names-golden.json";

/**
 * "다른 맥에서 쓰던 OPS 가 왜 이 맥에서 자동으로 안 잡히나."
 *
 * resolveControlCenterProject 는 이 기기에 이미 등록된 ports 배열만 훑는다.
 * 그래서 OPS 운영 폴더(AgentsToZ-Control)가 다른 Mac 에만 등록돼 있으면
 * 영원히 발견되지 않고, 화면에는 `AgentsToZ OPS · 0` 만 남는다. 사용자는
 * 이미 만들어 둔 것이 있는데도 "새로 만들기" 밖에 선택지가 없다.
 *
 * 기기별 격리(device_id)는 유지해야 하므로 원격 행을 자동으로 이 기기 것으로
 * 삼으면 안 된다. 발견은 하되 "이 Mac 에 연결할까요?" 로 제안만 한다.
 */
describe("control center discovery across devices", () => {
  test("remote rows from another device are offered as candidates", () => {
    const rows = [
      { id: "a", name: "AgentsToZ-Control", device_id: "mac-2", device_name: "집데스크탑",
        folder_path: "/Users/other/AgentsToZ-Control", memory_id: "mem-1" },
      { id: "b", name: "some-app", device_id: "mac-2", device_name: "집데스크탑",
        folder_path: "/Users/other/some-app", memory_id: "mem-2" },
    ];
    const found = controlCenterRemoteCandidates(rows, "mac-1");
    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe("a");
    expect(found[0]?.deviceName).toBe("집데스크탑");
    expect(found[0]?.memoryId).toBe("mem-1");
  });

  test("a Mac that already migrated to AgentsToZ-OPS and one that has not are both offered", () => {
    // 폴더 이름은 AgentsToZ-OPS 로 바뀌었다. 아직 이전하지 않은 Mac 은 옛 이름으로 등록돼 있다.
    const rows = [
      { id: "old", name: "AgentsToZ-Control", device_id: "mac-2", device_name: "집맥",
        folder_path: "/Users/other/AgentsToZ-Control", memory_id: "mem-1" },
      { id: "new", name: "AgentsToZ-OPS", device_id: "mac-3", device_name: "회사맥",
        folder_path: "/Users/other/AgentsToZ-OPS", memory_id: "mem-1" },
    ];
    expect(controlCenterRemoteCandidates(rows, "mac-1").map(candidate => candidate.id)).toEqual(["old", "new"]);
  });

  test("golden OPS names are offered from other devices exactly when the name or folder says OPS", () => {
    // Remote rows carry no ai_name, so a case named only by its alias cannot be found remotely.
    for (const row of golden.filter(entry => entry.aiName === null)) {
      const found = controlCenterRemoteCandidates([{ id: "r", name: row.name, device_id: "mac-2",
        folder_path: `/Users/other/${row.leaf}`, memory_id: "m" }], "mac-1");
      expect({ case: row.case, offered: found.length === 1 }).toEqual({ case: row.case, offered: row.expectedRole === "ops" });
    }
  });

  test("a lineage written under the legacy name fills an AgentsToZ-OPS row", () => {
    // 기억 리비전의 project_name 은 쓰인 시점의 이름을 그대로 들고 있다.
    const rows = [{ id: "a", name: "AgentsToZ-OPS", device_id: "mac-2",
      folder_path: "/o/AgentsToZ-OPS", memory_id: null }];
    expect(controlCenterRemoteCandidates(rows, "mac-1",
      [{ memory_id: "mem-real", project_name: "AgentsToZ-Control" }])[0]?.memoryId).toBe("mem-real");
    // Two names for one lineage are the same project; two lineages under either name stay ambiguous.
    expect(controlCenterRemoteCandidates(rows, "mac-1", [
      { memory_id: "mem-real", project_name: "AgentsToZ-Control" },
      { memory_id: "mem-real", project_name: "AgentsToZ-OPS" },
    ])[0]?.memoryId).toBe("mem-real");
    expect(controlCenterRemoteCandidates(rows, "mac-1", [
      { memory_id: "mem-1", project_name: "AgentsToZ-Control" },
      { memory_id: "mem-2", project_name: "AgentsToZ-OPS" },
    ])[0]?.memoryId).toBeNull();
  });

  test("a row already owned by this device is not offered again", () => {
    // 내 기기 것이면 이미 로컬 해석이 처리한다. 다시 제안하면 중복 연결을 부른다.
    const rows = [{ id: "a", name: "AgentsToZ-Control", device_id: "mac-1", device_name: "이 맥",
      folder_path: "/Users/me/AgentsToZ-Control", memory_id: "mem-1" }];
    expect(controlCenterRemoteCandidates(rows, "mac-1")).toEqual([]);
  });

  test("the folder leaf identifies a renamed control center", () => {
    // 표시 이름은 사용자가 바꿀 수 있다. 실제 폴더 이름이 정본이다.
    const rows = [{ id: "a", name: "운영본부", device_id: "mac-2", device_name: "회사맥북",
      folder_path: "/Users/other/work/AgentsToZ-Control/", memory_id: "mem-9" }];
    expect(controlCenterRemoteCandidates(rows, "mac-1")).toHaveLength(1);
  });

  test("an unrelated name is never mistaken for the control center", () => {
    const rows = [{ id: "a", name: "Control experiment", device_id: "mac-2",
      folder_path: "/Users/other/control-notes", memory_id: "m" }];
    expect(controlCenterRemoteCandidates(rows, "mac-1")).toEqual([]);
  });

  test("rows missing an owner are skipped rather than guessed", () => {
    // device_id 가 없으면 누구 것인지 증명할 수 없다. 조용히 내 것으로 삼지 않는다.
    const rows = [{ id: "a", name: CONTROL_CENTER_PROJECT_NAME, device_id: null,
      folder_path: "/x/AgentsToZ-Control", memory_id: "m" }];
    expect(controlCenterRemoteCandidates(rows, "mac-1")).toEqual([]);
  });

  test("a lineage found in memory revisions fills a row that has no memory_id", () => {
    // 실측 2026-09-23: 원격 Control 행의 memory_id 가 비어 있어 「복원」이 이어붙일
    // 계보를 몰랐고, 폴더만 만들고 새 memoryId 로 갈라졌다. 등록 행에 계보가 없으면
    // 같은 이름의 기억 리비전에서 찾아 채운다.
    const rows = [{ id: "a", name: "AgentsToZ-Control", device_id: "mac-2",
      device_name: "집맥", folder_path: "/o/AgentsToZ-Control", memory_id: null }];
    const lineages = [
      { memory_id: "mem-real", project_name: "AgentsToZ-Control" },
      { memory_id: "mem-other", project_name: "remote control" },
    ];
    const found = controlCenterRemoteCandidates(rows, "mac-1", lineages);
    expect(found).toHaveLength(1);
    expect(found[0]?.memoryId).toBe("mem-real");
  });

  test("a row's own memory_id always wins over the lineage lookup", () => {
    // 행이 계보를 명시하면 그것이 정본이다. 추측이 정본을 덮지 않는다.
    const rows = [{ id: "a", name: "AgentsToZ-Control", device_id: "mac-2",
      folder_path: "/o/AgentsToZ-Control", memory_id: "mem-explicit" }];
    const lineages = [{ memory_id: "mem-guess", project_name: "AgentsToZ-Control" }];
    expect(controlCenterRemoteCandidates(rows, "mac-1", lineages)[0]?.memoryId).toBe("mem-explicit");
  });

  test("an ambiguous lineage is left empty rather than picked at random", () => {
    // 같은 이름의 계보가 여러 개면 어느 것인지 증명할 수 없다. 틀린 계보에 잇는 것은
    // 갈라지는 것보다 나쁘다 — 남의 기억에 덮어쓰게 된다.
    const rows = [{ id: "a", name: "AgentsToZ-Control", device_id: "mac-2",
      folder_path: "/o/AgentsToZ-Control", memory_id: null }];
    const lineages = [
      { memory_id: "mem-1", project_name: "AgentsToZ-Control" },
      { memory_id: "mem-2", project_name: "AgentsToZ-Control" },
    ];
    expect(controlCenterRemoteCandidates(rows, "mac-1", lineages)[0]?.memoryId).toBeNull();
  });

  test("local resolution still wins and needs no remote lookup", () => {
    // 회귀 방지: 로컬에 있으면 원격을 보지 않는다.
    const local = { id: "control", folderPath: "/Users/me/AgentsToZ-Control" };
    expect(resolveControlCenterProject([local])).toBe(local);
  });
});

describe("the desktop surfaces a discovered control center", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const chips = readFileSync(new URL("../src/ProjectRoleLabels.tsx", import.meta.url), "utf8");

  test("discovery is offered, not applied silently", () => {
    // 기기별 격리를 지켜야 하므로 원격 행을 자동으로 이 기기에 붙이지 않는다.
    expect(app).toContain("controlCenterRemoteCandidates");
    expect(app).toContain('data-testid="control-center-remote-candidate"');
  });

  test("the OPS role chip itself signals a remote find", () => {
    // 처음 구현은 결과를 「도구 및 설정」의 접힌 details 안에만 넣었다. 사용자가 보는
    // 자리는 사이드바 상단 역할 칩이고, 거기는 로컬만 세므로 `AgentsToZ OPS · 0` 이
    // 그대로였다 — 고쳤다고 말했지만 화면은 변한 것이 없었다.
    // 칩이 발견 사실을 직접 알려야 사용자가 새로 만들지 않는다.
    expect(chips).toContain("remoteFound");
    expect(chips).toContain('data-testid="project-role-filter-ops-remote"');
    // 칩을 누르면 복원 경로로 갈 수 있어야 한다.
    expect(app).toContain("onOpsRemoteFound");
  });

  test("restore joins the discovered lineage instead of initializing a new one", () => {
    // 실측 2026-09-23: restore 가 setNewProjectMemoryJoinId('') 로 계보를 비워
    // 폴더만 만들고 새 memoryId 로 갈라졌다. 발견한 후보의 계보를 실어 보내야
    // 「복원」이 이름값을 한다.
    expect(app).toContain("const joinable = opsRemoteCandidates.find(candidate => candidate.memoryId)");
    expect(app).toContain("setNewProjectMemoryJoinId(joinable?.memoryId ?? '')");
    // 조회는 계보 표도 함께 읽어야 memory_id 가 빈 행을 메울 수 있다.
    expect(app).toContain("portmgr_project_memory_revisions");
  });

  test("the lineage query searches both OPS folder names", () => {
    // 옛 이름으로 쓰인 리비전도, 새 이름으로 쓰인 리비전도 같은 OPS 계보다.
    expect(app).toContain("project_name.ilike.%${name}%");
    expect(app).toContain("[OPS_FOLDER_NAME, ...LEGACY_OPS_FOLDER_NAMES]");
  });
});
