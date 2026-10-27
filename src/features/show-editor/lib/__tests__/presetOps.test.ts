import { produce } from "immer";
import { describe, expect, it } from "vitest";

import { fixed } from "../looks";
import { addFixtures } from "../ops";
import { createPreset, inferPresetGroup, presetUsage, removePreset, renamePreset } from "../presetOps";
import { createEmptyProject, type LookClip, type ShowProject } from "../project";
import { projectIntegrityIssues } from "../schema";
import { RGBW } from "./testkit";

/** 一条轨道上有一个外观片段的工程。 */
function base(): ShowProject {
  return produce(createEmptyProject("t"), (d) => {
    addFixtures(d, RGBW, 1);
    d.durationMs = 60_000;
    const clip: LookClip = {
      id: "c1",
      kind: "look",
      trackId: d.tracks[0].id,
      startMs: 0,
      endMs: 2000,
      brightness: 100,
      fadeInMs: 0,
      fadeOutMs: 0,
      easing: "linear",
      look: { intensity: fixed(80), color: fixed({ kind: "rgb", rgb: [255, 0, 0] }) },
    };
    d.cues.push(clip);
  });
}

describe("inferPresetGroup", () => {
  it("按出现的层归类", () => {
    expect(inferPresetGroup({ intensity: fixed(50) })).toBe("intensity");
    expect(inferPresetGroup({ color: fixed({ kind: "kelvin", kelvin: 3200 }) })).toBe("color");
    expect(inferPresetGroup({ attrs: { pan: fixed(0.5), tilt: fixed(0.2) } })).toBe("position");
    expect(inferPresetGroup({ attrs: { gobo: fixed(0.1), zoom: fixed(0.4) } })).toBe("beam");
    expect(inferPresetGroup({ intensity: fixed(50), attrs: { pan: fixed(0.5) } })).toBe("all");
    expect(inferPresetGroup({})).toBe("all");
  });
});

describe("createPreset / renamePreset / removePreset", () => {
  it("从片段外观新建：深拷贝、空名用默认名、不带预设引用", () => {
    let id = "";
    const p = produce(base(), (d) => {
      const cue = d.cues[0];
      if (cue.kind === "look") id = createPreset(d, "  ", cue.look, "预设 1");
    });
    const preset = p.presets.find((x) => x.id === id);
    expect(preset).toMatchObject({ name: "预设 1", group: "all" });
    expect(preset?.look.presetId).toBeUndefined();
    expect(preset?.look.intensity).toEqual(fixed(80));
    // 改片段不影响预设
    const changed = produce(p, (d) => {
      const cue = d.cues[0];
      if (cue.kind === "look") cue.look.intensity = fixed(10);
    });
    expect(changed.presets[0].look.intensity).toEqual(fixed(80));
    expect(projectIntegrityIssues(p)).toEqual([]);
  });

  it("引用了别的预设的外观先展开再存（预设不嵌套）", () => {
    const p = produce(base(), (d) => {
      const first = createPreset(d, "红", { color: fixed({ kind: "rgb", rgb: [255, 0, 0] }) }, "x");
      createPreset(d, "组合", { intensity: fixed(40), presetId: first }, "x");
    });
    expect(p.presets[1].look).toEqual({ intensity: fixed(40), color: fixed({ kind: "rgb", rgb: [255, 0, 0] }) });
    expect(projectIntegrityIssues(p)).toEqual([]);
  });

  it("重命名忽略空白名称", () => {
    const p = produce(base(), (d) => {
      const id = createPreset(d, "A", { intensity: fixed(1) }, "x");
      renamePreset(d, id, "  B ");
      renamePreset(d, id, "   ");
    });
    expect(p.presets[0].name).toBe("B");
  });

  it("删除时把预设烘焙进引用它的片段，片段显式写出的层优先", () => {
    let id = "";
    const withRef = produce(base(), (d) => {
      id = createPreset(d, "蓝", { intensity: fixed(100), color: fixed({ kind: "rgb", rgb: [0, 0, 255] }) }, "x");
      const cue = d.cues[0];
      if (cue.kind === "look") cue.look = { intensity: fixed(30), presetId: id };
    });
    expect(presetUsage(withRef, id)).toBe(1);
    let baked = 0;
    const next = produce(withRef, (d) => {
      baked = removePreset(d, id);
    });
    expect(baked).toBe(1);
    expect(next.presets).toEqual([]);
    const cue = next.cues[0];
    expect(cue.kind === "look" && cue.look).toEqual({ intensity: fixed(30), color: fixed({ kind: "rgb", rgb: [0, 0, 255] }) });
    expect(projectIntegrityIssues(next)).toEqual([]);
  });
});
