import { describe, expect, test } from "bun:test";
import {
  nextMissionState, normalizeMissionCreate, normalizeMissionEvent, projectMemoryRecipients,
} from "../src/orchestrationMissionModel";

describe("voice orchestration mission model", () => {
  test("keeps mission lifecycle explicit and never auto-resumes", () => {
    expect(nextMissionState("active", "mission-interrupted")).toBe("interrupted");
    expect(() => nextMissionState("interrupted", "instruction-sent")).toThrow("MISSION_STATE_TRANSITION_INVALID");
    expect(nextMissionState("interrupted", "mission-resumed")).toBe("active");
    expect(nextMissionState("active", "mission-paused")).toBe("paused");
    expect(nextMissionState("paused", "mission-completed")).toBe("completed");
    expect(() => nextMissionState("completed", "mission-resumed")).toThrow("MISSION_STATE_TRANSITION_INVALID");
  });

  test("stores bounded references instead of raw cross-store copies", () => {
    expect(normalizeMissionCreate({ title: "SDK 모바일 강화", goal: "SDK와 두 앱을 조율한다", requestId: "request_12345678" }))
      .toEqual({ title: "SDK 모바일 강화", goal: "SDK와 두 앱을 조율한다", requestId: "request_12345678" });
    expect(normalizeMissionEvent({
      missionId: "mission_12345678", kind: "instruction-sent", requestId: "request_abcdefgh",
      projectIds: ["sdk", "shadow", "sdk"], summary: "SDK 변경을 두 앱에 적용하도록 지시함",
      whatISaidEventId: `wis_${"a".repeat(64)}`,
    })).toMatchObject({ projectIds: ["sdk", "shadow"], whatISaidEventId: `wis_${"a".repeat(64)}` });
    expect(() => normalizeMissionEvent({
      missionId: "mission_12345678", kind: "instruction-sent", requestId: "request_abcdefgh",
      projectIds: [], summary: "x", whatISaidEventId: "copied raw transcript",
    })).toThrow("MISSION_INPUT_INVALID");
  });

  test("updates only projects with an actual decision, change, or verified result", () => {
    expect(projectMemoryRecipients({
      mentionedProjectIds: ["A", "B"], changedProjectIds: ["B"], decisionProjectIds: [], verifiedResultProjectIds: [],
    })).toEqual(["B"]);
    expect(projectMemoryRecipients({
      mentionedProjectIds: ["sdk", "shadow", "web"], changedProjectIds: ["sdk", "shadow", "web"],
      decisionProjectIds: ["sdk"], verifiedResultProjectIds: ["shadow", "web"],
    })).toEqual(["sdk", "shadow", "web"]);
  });

  test("accepts utterance links and rejects malformed What I Said IDs", () => {
    expect(normalizeMissionEvent({
      missionId: "mission_12345678", kind: "utterance-linked", requestId: "request_link_1",
      projectIds: ["A"], summary: "linked", whatISaidEventId: `wis_${"b".repeat(64)}`,
    }).kind).toBe("utterance-linked");
    expect(() => normalizeMissionEvent({
      missionId: "mission_12345678", kind: "utterance-linked", requestId: "request_link_2",
      projectIds: ["A"], summary: "linked", whatISaidEventId: "wis_bad",
    })).toThrow("MISSION_INPUT_INVALID");
  });
});
