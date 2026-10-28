import { describe, expect, it } from "vitest";
import { produce } from "immer";

import { fixtureProfile, fixturesCapabilities, trackCapabilities } from "../fixtureProfile";
import { addFixtures, createGroup } from "../ops";
import { createEmptyProject } from "../project";
import { DIMMER, HEAD16, RGBW } from "./testkit";

describe("灯具能力画像", () => {
  it("按通道功能推断类型与能力", () => {
    expect(fixtureProfile(DIMMER)).toEqual({ type: "dimmer", caps: new Set(["intensity"]) });
    expect(fixtureProfile(RGBW)).toEqual({ type: "mixing", caps: new Set(["intensity", "mixing", "colorTemp"]) });
    const head = fixtureProfile(HEAD16);
    expect(head.type).toBe("mover");
    expect([...head.caps].sort()).toEqual(["intensity", "position"]);
    expect(fixtureProfile(undefined)).toEqual({ type: "other", caps: new Set() });
  });

  it("轨道汇总：任一 / 全部支持，按台数统计；分组轨道取全部成员", () => {
    const p = produce(createEmptyProject("t"), (d) => {
      const a = addFixtures(d, RGBW, 2);
      const b = addFixtures(d, DIMMER, 1);
      createGroup(d, "混合", [...a, ...b]);
    });
    const group = p.tracks.find((t) => t.target.kind === "group")!;
    const caps = trackCapabilities(p, group);
    expect(caps.total).toBe(3);
    expect(caps.counts.get("mixing")).toBe(2);
    expect(caps.any.has("mixing")).toBe(true);
    expect([...caps.all]).toEqual(["intensity"]);
    expect(caps.types).toEqual(["mixing", "dimmer"]);
    expect(fixturesCapabilities(p, []).all.size).toBe(0);
  });
});
