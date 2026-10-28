import { describe, expect, it } from "vitest";
import { produce } from "immer";

import { addDefaultLook, applicability, attrEffectNeeds, defaultLook, effectNeeds, templateNeeds, trackSupports } from "../cueDefaults";
import { BUILTIN_TEMPLATES } from "../cueTemplates";
import { EFFECT_PRESETS } from "../effectPresets";
import {
  availableAttrsOf,
  fixturesCapabilities,
  layerSupport,
  lookBadges,
  trackCapabilities,
  unsupportedLayers,
} from "../fixtureProfile";
import { addFixtures } from "../ops";
import { createEmptyProject, type ShowProject } from "../project";
import { DIMMER, HEAD16, RGBW } from "./testkit";

/** 轨道 0 = 调光灯，1 = RGBW，2 = 摇头灯。 */
function base(): ShowProject {
  return produce(createEmptyProject("t"), (d) => {
    addFixtures(d, DIMMER, 1);
    addFixtures(d, RGBW, 1);
    addFixtures(d, HEAD16, 1);
  });
}
const capsOf = (p: ShowProject, i: number) => trackCapabilities(p, p.tracks[i]);

describe("按灯具类型的默认外观与适用性", () => {
  it("默认外观：调光灯只有强度，混色灯加颜色，摇头灯加居中的 Pan / Tilt", () => {
    const p = base();
    expect(defaultLook(capsOf(p, 0))).toEqual({ intensity: { kind: "value", value: 100 } });
    expect(defaultLook(capsOf(p, 1), [255, 0, 0]).color).toEqual({ kind: "value", value: { kind: "rgb", rgb: [255, 0, 0] } });
    expect(defaultLook(capsOf(p, 2)).attrs).toEqual({ pan: { kind: "value", value: 0.5 }, tilt: { kind: "value", value: 0.5 } });
  });

  it("新建外观片段带模板的亮度与淡入淡出；场景轨道不新建", () => {
    let id: string | null = null;
    const p = produce(base(), (d) => {
      id = addDefaultLook(d, d.tracks[1].id, 0, { rgb: [0, 0, 255], brightness: 60, fadeInMs: 500, fadeOutMs: 500 });
      d.tracks.push({ id: "sc", target: { kind: "scene" }, mute: false, solo: false, lock: false });
    });
    expect(p.cues.find((c) => c.id === id)).toMatchObject({ kind: "look", brightness: 60, fadeInMs: 500, fadeOutMs: 500, endMs: 2000 });
    let none: string | null = "x";
    produce(p, (d) => {
      none = addDefaultLook(d, "sc", 0);
    });
    expect(none).toBeNull();
  });

  it("素材需要的能力与适用程度（按台数合计）", () => {
    expect(templateNeeds(BUILTIN_TEMPLATES.find((x) => x.id === "white")!)).toBe("intensity");
    expect(templateNeeds(BUILTIN_TEMPLATES.find((x) => x.id === "red")!)).toBe("mixing");
    expect(effectNeeds(EFFECT_PRESETS.find((x) => x.effect === "rainbow")!)).toBe("mixing");
    expect(effectNeeds(EFFECT_PRESETS.find((x) => x.effect === "breathe")!)).toBe("intensity");
    expect(attrEffectNeeds("circle")).toBe("position");

    const p = base();
    expect(applicability([capsOf(p, 0)], "mixing").level).toBe("none");
    expect(applicability([capsOf(p, 0), capsOf(p, 1)], "mixing")).toEqual({ level: "partial", needs: "mixing", supported: 1, total: 2 });
    expect(applicability([capsOf(p, 2)], "position").level).toBe("full");
    expect(trackSupports(p, p.tracks[0].id, "position")).toBe(false);
    expect(trackSupports(p, p.tracks[2].id, "position")).toBe(true);
  });

  it("片段徽标与没有灯支持的层；属性层取并集并计台数", () => {
    const p = base();
    const look = {
      intensity: { kind: "value" as const, value: 100 },
      color: { kind: "value" as const, value: { kind: "rgb" as const, rgb: [255, 0, 0] as [number, number, number] } },
      attrs: { pan: { kind: "value" as const, value: 0.5 } },
    };
    expect(lookBadges(look)).toEqual(["color", "position"]);
    const ids = p.fixtures.map((f) => f.id);
    expect(unsupportedLayers(look, layerSupport(p, [ids[0]]))).toEqual(["color", "pan"]);
    expect(unsupportedLayers(look, layerSupport(p, [ids[1]]))).toEqual(["pan"]);
    expect(unsupportedLayers(look, layerSupport(p, ids))).toEqual([]);
    expect(unsupportedLayers(look, layerSupport(p, []))).toEqual([]);
    const attrs = availableAttrsOf(p, ids);
    expect(attrs.map((a) => [a.key, a.supported])).toEqual([
      ["pan", 1],
      ["tilt", 1],
      ["reset", 1],
    ]);
    expect(fixturesCapabilities(p, ids).total).toBe(3);
  });
});
