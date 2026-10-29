import { describe, expect, it } from "vitest";
import { produce } from "immer";

import { templateSwatch } from "../clipVisual";
import { templateNeeds } from "../cueDefaults";
import { parseTemplates, serializeTemplates, templateKind, type CueTemplate } from "../cueTemplates";
import { addEffectDefCue, BUILTIN_EFFECTS, defaultEffectParams, mergeEffectParams } from "../effectLibrary";
import { addFixtures } from "../ops";
import { createEmptyProject, type Cue, type Look, type ShowProject } from "../project";
import { addTemplateCue, searchTemplates, templateFromCue, templateLengthMs, upsertTemplate } from "../templateOps";
import { DIMMER, RGBW } from "./testkit";

const fx = (id: string) => BUILTIN_EFFECTS.find((e) => e.id === id)!;

const base = (over: Partial<CueTemplate> = {}): CueTemplate => ({
  id: "t-1",
  name: "测试",
  group: "custom",
  color: { kind: "rgb", rgb: [255, 0, 0] },
  brightness: 100,
  fadeInMs: 0,
  fadeOutMs: 0,
  ...over,
});

/** 两台 RGBW 灯（各一条轨道）+ 一个分组轨道。 */
function project(): ShowProject {
  return produce(createEmptyProject("t"), (d) => {
    addFixtures(d, RGBW, 2);
    d.durationMs = 60_000;
  });
}

describe("Cue 模板 v2 文件格式", () => {
  it("版本 1 的颜色模板照常读取；种类缺省为颜色；超过上限的色温夹到 20000K", () => {
    const r = parseTemplates({
      version: 1,
      templates: [
        { id: "a", name: "甲", color: { kind: "rgb", rgb: [1, 2, 3] } },
        { id: "k", name: "冷", color: { kind: "kelvin", kelvin: 30_000 } },
      ],
    });
    expect(r.issues).toEqual([]);
    expect(templateKind(r.templates[0])).toBe("color");
    expect(r.templates[0]).not.toHaveProperty("kind");
    expect(r.templates[1].color).toEqual({ kind: "kelvin", kelvin: 20_000 });
  });

  it("外观模板必须带外观、特效模板必须带特效；不属于该种类的字段丢弃", () => {
    const def = fx("breathe");
    const r = parseTemplates({
      templates: [
        { id: "l0", name: "缺外观", kind: "look", color: { kind: "rgb", rgb: [1, 1, 1] } },
        { id: "e0", name: "缺特效", kind: "effect", color: { kind: "rgb", rgb: [1, 1, 1] } },
        {
          id: "l1",
          name: "外观",
          kind: "look",
          color: { kind: "rgb", rgb: [1, 1, 1] },
          look: { intensity: { kind: "value", value: 50 } },
          spread: { order: "reverse" },
          fx: { def, params: defaultEffectParams(def) },
        },
        { id: "e1", name: "特效", kind: "effect", color: { kind: "rgb", rgb: [1, 1, 1] }, fx: { def, params: defaultEffectParams(def) }, spread: { order: "reverse" } },
        { id: "c1", name: "颜色", color: { kind: "rgb", rgb: [1, 1, 1] }, look: { intensity: { kind: "value", value: 1 } }, tags: ["a", "a", "b"] },
      ],
    });
    expect(r.issues.map((i) => i.index)).toEqual([1, 2]);
    const [look, effect, color] = r.templates;
    expect(look).toMatchObject({ kind: "look", spread: { order: "reverse" } });
    expect(look).not.toHaveProperty("fx");
    expect(effect).toMatchObject({ kind: "effect" });
    expect(effect).not.toHaveProperty("spread");
    expect(color).not.toHaveProperty("look");
    expect(color.tags).toEqual(["a", "b"]);
  });

  it("序列化写出版本 2，读回相同", () => {
    const t = base({ kind: "look", look: { intensity: { kind: "value", value: 30 } }, length: { kind: "beats", beats: 8 }, easing: "sCurve", builtin: true });
    const text = serializeTemplates([t]);
    expect(JSON.parse(text).version).toBe(2);
    const { builtin: _b, ...clean } = t;
    void _b;
    expect(parseTemplates(JSON.parse(text)).templates).toEqual([clean]);
  });
});

describe("模板的长度、搜索与保存", () => {
  it("长度：省略为默认 2 秒；按拍按工程节拍换算；至少 100 毫秒", () => {
    expect(templateLengthMs(base(), null)).toBe(2000);
    expect(templateLengthMs(base({ length: { kind: "beats", beats: 4 } }), { bpm: 120, offsetMs: 0, beatsPerBar: 4 })).toBe(2000);
    expect(templateLengthMs(base({ length: { kind: "ms", ms: 5 } }), null)).toBe(100);
  });

  it("搜索：中英文名、标签、说明都算，多个词需同时匹配", () => {
    const list = [
      base({ id: "a", name: { zh: "开场红", en: "Opening red" }, tags: ["intro"] }),
      base({ id: "b", name: "暖白", note: "LEE 201" }),
    ];
    expect(searchTemplates(list, "opening").map((t) => t.id)).toEqual(["a"]);
    expect(searchTemplates(list, "INTRO 红").map((t) => t.id)).toEqual(["a"]);
    expect(searchTemplates(list, "lee").map((t) => t.id)).toEqual(["b"]);
    expect(searchTemplates(list, "  ")).toHaveLength(2);
    expect(searchTemplates(list, "intro 暖")).toEqual([]);
  });

  it("保存：同 id 原位替换，否则追加；不写运行时标记", () => {
    const user = [base({ id: "a" }), base({ id: "b" })];
    expect(upsertTemplate(user, base({ id: "a", brightness: 10, builtin: true }))).toEqual([base({ id: "a", brightness: 10 }), base({ id: "b" })]);
    expect(upsertTemplate(user, base({ id: "c" })).map((t) => t.id)).toEqual(["a", "b", "c"]);
  });
});

describe("按模板插入片段", () => {
  it("颜色模板：按灯具类型的默认外观，带多色分布、亮度、淡入淡出、缓动与长度", () => {
    const p = produce(project(), (d) => {
      const id = addTemplateCue(
        d,
        d.tracks[0].id,
        1000,
        base({
          brightness: 70,
          fadeInMs: 300,
          fadeOutMs: 200,
          easing: "easeInOut",
          length: { kind: "ms", ms: 4000 },
          spread: { colors: { colors: [{ kind: "rgb", rgb: [255, 0, 0] }, { kind: "rgb", rgb: [0, 0, 255] }], blend: "step" } },
        }),
        "开场",
      );
      expect(id).not.toBeNull();
    });
    const cue = p.cues[0];
    expect(cue).toMatchObject({ kind: "look", startMs: 1000, endMs: 5000, brightness: 70, fadeInMs: 300, fadeOutMs: 200, easing: "easeInOut", label: "开场" });
    expect(cue.kind === "look" && cue.look.color).toEqual({ kind: "value", value: { kind: "rgb", rgb: [255, 0, 0] } });
    expect(cue.kind === "look" && cue.spread?.colors?.blend).toBe("step");
  });

  it("外观模板：外观与分布原样写入（不共享对象）", () => {
    const look: Look = { intensity: { kind: "curve", curve: { shape: "sine", from: 0, to: 100, cycles: 2, phase: 0 } } };
    const template = base({ kind: "look", look, spread: { order: "reverse" } });
    const p = produce(project(), (d) => void addTemplateCue(d, d.tracks[0].id, 0, template));
    const cue = p.cues[0];
    expect(cue.kind === "look" && cue.look).toEqual(look);
    expect(cue.kind === "look" && cue.look).not.toBe(look);
    expect(cue.kind === "look" && cue.spread).toEqual({ order: "reverse" });
  });

  it("特效预设模板：生成带特效快照的片段（插入后仍可改参数）；场景轨道不新建", () => {
    const def = fx("twoColor");
    const params = mergeEffectParams(def, defaultEffectParams(def), { size: 40 });
    const template = base({ kind: "effect", fx: { def, params } });
    let sceneResult: string | null = "x";
    const start = project();
    const p = produce(start, (d) => {
      void addTemplateCue(d, d.tracks[0].id, 0, template, "双色");
      d.tracks.push({ id: "scene", target: { kind: "scene" }, mute: false, solo: false, lock: false } as ShowProject["tracks"][number]);
      sceneResult = addTemplateCue(d, "scene", 0, template);
    });
    const cue = p.cues[0];
    expect(cue.kind === "look" && cue.fx?.def.id).toBe("twoColor");
    expect(cue.kind === "look" && cue.fx?.params.size).toBe(40);
    expect(sceneResult).toBeNull();
    // 与直接从特效库插入的结果一致（除 id 外）
    const direct = produce(start, (d) => void addEffectDefCue(d, d.tracks[0].id, 0, def, params, "双色"));
    const strip = (c: Cue) => ({ ...c, id: "" });
    expect(strip(cue)).toEqual(strip(direct.cues[0]));
  });
});

describe("片段 → 模板（v2）", () => {
  const cueBase = { id: "c", trackId: "t", startMs: 0, endMs: 3000, brightness: 90, fadeInMs: 0, fadeOutMs: 0, easing: "sCurve" as const };

  it("特效片段存为特效预设模板；带属性层 / 曲线的外观存为外观模板；预设引用合并进来", () => {
    const p = produce(project(), (d) => void addEffectDefCue(d, d.tracks[0].id, 0, fx("twoColor"), defaultEffectParams(fx("twoColor"))));
    const fromFx = templateFromCue(p.cues[0]);
    expect(fromFx).toMatchObject({ kind: "effect", fx: { def: { id: "twoColor" } } });

    const look = templateFromCue({ ...cueBase, kind: "look", look: { attrs: { pan: { kind: "value", value: 0.5 } } } });
    expect(look).toMatchObject({ kind: "look", easing: "sCurve", length: { kind: "ms", ms: 3000 }, look: { attrs: { pan: { kind: "value", value: 0.5 } } } });

    const preset = { id: "p1", name: "蓝", look: { color: { kind: "value" as const, value: { kind: "rgb" as const, rgb: [0, 0, 255] as [number, number, number] } } } };
    const fromPreset = templateFromCue({ ...cueBase, kind: "look", look: { presetId: "p1" } }, [preset as ShowProject["presets"][number]]);
    expect(fromPreset).toMatchObject({ color: { kind: "rgb", rgb: [0, 0, 255] } });
    expect(fromPreset).not.toHaveProperty("look");
  });

  it("经典 RGB 特效片段换算成可配置特效存为特效预设模板", () => {
    const t = templateFromCue({
      ...cueBase,
      kind: "effect",
      effect: "rainbow",
      colors: [],
      period: { kind: "ms", ms: 2000 },
      phaseSpread: 0,
      direction: 1,
      range: [0, 100],
      seed: 1,
    } as Cue);
    expect(t).toMatchObject({ kind: "effect", fx: { def: { id: "rainbow" } } });
  });
});

describe("模板需要的能力与色块", () => {
  it("能力：颜色按颜色；外观按层；特效按特效", () => {
    expect(templateNeeds(base())).toBe("mixing");
    expect(templateNeeds(base({ color: { kind: "kelvin", kelvin: 3200 } }))).toBe("intensity");
    expect(templateNeeds(base({ kind: "look", look: { intensity: { kind: "value", value: 1 } } }))).toBe("intensity");
    expect(templateNeeds(base({ kind: "look", look: { attrs: { pan: { kind: "value", value: 0 } } } }))).toBe("position");
    expect(templateNeeds(base({ kind: "effect", fx: { def: fx("breathe"), params: defaultEffectParams(fx("breathe")) } }))).toBe("intensity");
    // 调光灯工程里依旧可用（只看模板本身）
    void DIMMER;
  });

  it("色块：多色分布为渐变（跳变为硬边）；没有颜色层的外观为中性；特效与特效库同一画法", () => {
    const multi = templateSwatch(base({ spread: { colors: { colors: [{ kind: "rgb", rgb: [255, 0, 0] }, { kind: "rgb", rgb: [0, 0, 255] }], blend: "step" } } }));
    expect(multi.background).toBe("linear-gradient(90deg, rgb(255 0 0) 0%, rgb(255 0 0) 50%, rgb(0 0 255) 50%, rgb(0 0 255) 100%)");
    expect(templateSwatch(base({ kind: "look", look: { intensity: { kind: "value", value: 1 } } }))).toEqual({ background: null, neutral: true });
    expect(templateSwatch(base()).background).toBe("rgb(255 0 0)");
    const def = fx("twoColor");
    expect(templateSwatch(base({ kind: "effect", fx: { def, params: defaultEffectParams(def) } })).neutral).toBe(false);
  });
});
