import { describe, expect, test } from "bun:test";
import {
  buildBuzzChannelCreateArgs,
  normalizeBuzzChannelId,
  normalizeBuzzChannelName,
  normalizeBuzzRelayUrl,
  parseBuzzChannelCreateOutput,
  parseBuzzChannelListOutput,
} from "../src/buzzProjectContract";
import { buzzRelayHealthUrl } from "../buzz-project-server";

describe("Buzz project contract", () => {
  test("normalizes only credential-free local websocket relay URLs", () => {
    expect(normalizeBuzzRelayUrl(undefined)).toBe("ws://localhost:3000");
    expect(normalizeBuzzRelayUrl("ws://localhost:3000/")).toBe("ws://localhost:3000");
    expect(normalizeBuzzRelayUrl("http://localhost:3000")).toBe("ws://localhost:3000");
    expect(normalizeBuzzRelayUrl("https://relay.example.com")).toBe("wss://relay.example.com");
    expect(() => normalizeBuzzRelayUrl("ftp://example.com")).toThrow("http(s):// 또는 ws(s)://");
    expect(() => normalizeBuzzRelayUrl("ws://key@localhost:3000")).toThrow("인증정보");
    expect(() => normalizeBuzzRelayUrl("ws://localhost:3000/?token=secret")).toThrow("query");
  });

  test("probes the relay main-port health endpoint", () => {
    expect(buzzRelayHealthUrl("ws://localhost:3000")).toBe("http://localhost:3000/health");
    expect(buzzRelayHealthUrl("wss://buzz.example.com/community"))
      .toBe("https://buzz.example.com/community/health");
  });

  test("accepts runtime channel UUIDs and produces a bounded default name", () => {
    expect(normalizeBuzzChannelId(" 90e60ca7-e624-4a9a-9c2a-e346715a9f46 "))
      .toBe("90e60ca7-e624-4a9a-9c2a-e346715a9f46");
    expect(() => normalizeBuzzChannelId("general")).toThrow("UUID");
    expect(normalizeBuzzChannelName("  AgentsToZ   프로젝트  ")).toBe("AgentsToZ 프로젝트");
    expect(normalizeBuzzChannelName("x".repeat(100))).toHaveLength(64);
  });

  test("uses argv rather than a shell command when creating an open stream", () => {
    expect(buildBuzzChannelCreateArgs({
      name: "AgentsToZ",
      description: "AgentsToZ project: AgentsToZ",
    })).toEqual([
      "channels", "create",
      "--name", "AgentsToZ",
      "--type", "stream",
      "--visibility", "open",
      "--description", "AgentsToZ project: AgentsToZ",
    ]);
  });

  test("parses list and create JSON without accepting malformed channel identities", () => {
    const id = "90e60ca7-e624-4a9a-9c2a-e346715a9f46";
    expect(parseBuzzChannelListOutput(JSON.stringify([
      { channel_id: id, name: "AgentsToZ", description: "local" },
      { channel_id: "bad", name: "ignored" },
    ]))).toEqual([{ channelId: id, name: "AgentsToZ", description: "local" }]);
    expect(parseBuzzChannelCreateOutput(JSON.stringify({ accepted: true, channel_id: id })))
      .toEqual({ channelId: id, accepted: true });
    expect(() => parseBuzzChannelCreateOutput(JSON.stringify({ accepted: true, channel_id: "bad" })))
      .toThrow("channel_id");
  });
});
