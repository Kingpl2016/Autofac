import { produce } from "immer";
import { beforeAll, describe, expect, it } from "vitest";

import { EFFECT_ICONS } from "../../components/effectIcons";
import type { Engine } from "../../engine/engine";
import builtinEffectsFile from "../builtinEffects.json";
import { loadTestEngine } from "../../engine/__tests__/testEngine";
import { createPreviewEvaluator } from "../color";
import { addEffectCue, addLookCue, setSpread, updateLooks } from "../cueOps";
import {
  addEffectDefCue,
  BUILTIN_EFFECTS,
  buildEffectLook,
  commonFx,
  convertLegacyEffects,
  copyEffectToUser,
  defaultEffectParams,
  detachFx,
  EFFECT_CLIP_MS,
  effectDefNeeds,
  effectHasSeed,
  effectParamValue,
  groupEffects,
  importEffects,
  legacyEffectFx,
  mergeEffects,
  parseEffectText,
  parseEffects,
  removeEffect,
  sanitizeEffectParams,
  serializeEffects,
  setFxParams,
  upsertEffect,
  type EffectDef,
} from "../effectLibrary";
import { presetOf } from "../effectPresets";
import { addFixtures, createGroup } from "../ops";
import { createEmptyProject, type EffectCue, type LookClip, type ShowProject } from "../project";
import { parseProject, projectIntegrityIssues } from "../schema";
import { RGBW } from "./testkit";

let engine: Engine;
beforeAll(() => {
  engine = loadTestEngine();
});

const tempo = { bpm: 120, offsetMs: 0, beatsPerBar: 4 };
const def = (id: string): EffectDef => {
  const d = BUILTIN_EFFECTS.find((e) => e.id === id);
  if (!d) throw new Error(id);
  return d;
};

/** 三台 RGBW 灯编成一组，时长 30 秒；返回工程与分组轨道。 */
function grouped(): { p: ShowProject; track: string } {
  const p = produce(createEmptyProject("t"), (d) => {
    addFixtures(d, RGBW, 3);
    d.durationMs = 30_000;
    d.tempo = tempo;
    createGroup(d, "排", d.fixtures.map((f) => f.id));
  });
  return { p, track: p.tracks.at(-1)!.id };
}

const lookOf = (p: ShowProject, id: string | null) => p.cues.find((c) => c.id === id) as LookClip | undefined;

describe("特效库：配置文件", () => {
  it("内置 40 个特效，分四组，全部是只读；文件里的条目都合法", () => {
    expect(BUILTIN_EFFECTS).toHaveLength(40);
    expect(groupEffects(BUILTIN_EFFECTS).map((g) => [g.group, g.effects.length])).toEqual([
      ["position", 10],
      ["intensity", 15],
      ["color", 11],
      ["beam", 4],
    ]);
    expect(BUILTIN_EFFECTS.every((e) => e.builtin)).toBe(true);
    expect(parseEffects(builtinEffectsFile).issues).toEqual([]);
  });

  it("每个内置特效的图标都有对应的图形", () => {
    for (const e of BUILTIN_EFFECTS) expect(EFFECT_ICONS[e.icon ?? ""], e.id).toBeDefined();
  });

  it("单条不合法时跳过并记下原因；整份不对时没有特效；版本过新给出提示", () => {
    const parsed = parseEffects({
      version: 3,
      effects: [
        { id: "ok", name: "好", period: { kind: "ms", ms: 500 }, size: 50, look: { intensity: { value: 1 } } },
        { id: "bad id!", name: "坏", period: { kind: "ms", ms: 500 }, size: 50, look: { intensity: { value: 1 } } },
        { id: "empty", name: "空", period: { kind: "ms", ms: 500 }, size: 50, look: {} },
        { id: "script", name: "脚本", period: { kind: "ms", ms: 500 }, size: 50, look: { intensity: { value: 1, code: "alert(1)" } } },
      ],
    });
    expect(parsed.effects.map((e) => e.id)).toEqual(["ok"]);
    expect(parsed.effects[0]).toMatchObject({ group: "custom", scale: "percent", spread: 1, spreadBy: "phase" });
    expect(parsed.issues.map((i) => i.index)).toEqual([null, 2, 3, 4]);
    expect(parseEffectText("{oops").issues).toEqual([{ index: null, message: "json" }]);
    expect(parseEffects({ templates: [] }).effects).toEqual([]);
    // 版本 1 的文件照常读取
    expect(parseEffects({ version: 1, effects: [{ id: "v1", name: "旧", period: { kind: "ms", ms: 500 }, size: 50, look: { intensity: { value: 1 } } }] }).issues).toEqual([]);
  });

  it("引用必须指向同类型的已声明参数", () => {
    const base = { name: "x", period: { kind: "ms", ms: 500 }, size: 50 };
    const parsed = parseEffects({
      effects: [
        {
          ...base,
          id: "good",
          params: [
            { id: "lo", type: "percent", default: 0.2 },
            { id: "c", type: "color", default: [1, 2, 3] },
            { id: "s", type: "choice", default: "sine", options: [{ value: "sine" }, { value: "square" }] },
          ],
          look: { intensity: { shape: "$s", lo: "$lo", hi: 1 }, color: { rgb: "$c" } },
        },
        { ...base, id: "unknown", look: { intensity: { shape: "sine", lo: "$nope" } } },
        { ...base, id: "wrongType", params: [{ id: "c", type: "color", default: [1, 2, 3] }], look: { intensity: { shape: "sine", lo: "$c" } } },
        {
          ...base,
          id: "badShape",
          params: [{ id: "s", type: "choice", default: "x", options: [{ value: "x" }] }],
          look: { intensity: { shape: "$s" } },
        },
        { ...base, id: "dup", params: [{ id: "a", type: "percent", default: 0 }, { id: "a", type: "percent", default: 1 }], look: { intensity: { value: "$a" } } },
        { ...base, id: "badDefault", params: [{ id: "n", type: "number", min: 0, max: 1, default: 5 }], look: { intensity: { value: 1 } } },
      ],
    });
    expect(parsed.effects.map((e) => e.id)).toEqual(["good"]);
    expect(parsed.issues.map((i) => i.index)).toEqual([2, 3, 4, 5, 6]);
  });

  it("序列化去掉运行时标记，可原样读回", () => {
    const text = serializeEffects(BUILTIN_EFFECTS);
    expect(text).not.toContain("builtin");
    expect(text).toContain('"version": 2');
    expect(parseEffectText(text).effects.map((e) => e.id)).toEqual(BUILTIN_EFFECTS.map((e) => e.id));
  });

  it("合并：同 id 的用户特效覆盖内置的；复制、删除、导入、保存", () => {
    const mine: EffectDef = { ...def("circle"), builtin: undefined, name: "我的画圆" };
    const merged = mergeEffects(BUILTIN_EFFECTS, [mine]);
    expect(merged[0].name).toBe("我的画圆");
    expect(merged).toHaveLength(40);

    const { next, created } = copyEffectToUser([], BUILTIN_EFFECTS, def("rainbow"), " 副本");
    expect(created).toMatchObject({ id: "my-effect-1", group: "custom", name: { zh: "彩虹 副本", en: "Rainbow 副本" } });
    expect(created.builtin).toBeUndefined();
    expect(removeEffect(next, created.id)).toEqual([]);
    const imported = importEffects(next, [{ ...created, name: "改名" }, { ...def("strobe"), id: "s2" }]);
    expect([imported.added, imported.replaced]).toEqual([1, 1]);
    expect(imported.next.every((e) => e.builtin === undefined)).toBe(true);
    expect(upsertEffect(next, { ...created, name: "新名" })).toEqual([{ ...created, name: "新名" }]);
    expect(upsertEffect([], { ...def("strobe"), id: "s3" })[0].builtin).toBeUndefined();
  });

  it("需要的能力按层推断", () => {
    expect(effectDefNeeds(def("circle"))).toBe("position");
    expect(effectDefNeeds(def("fan"))).toBe("position");
    expect(effectDefNeeds(def("rainbow"))).toBe("mixing");
    expect(effectDefNeeds(def("zoomBreathe"))).toBe("focus");
    expect(effectDefNeeds(def("goboSpin"))).toBe("beam");
    expect(effectDefNeeds(def("intensityWave"))).toBe("intensity");
  });
});

describe("特效库：参数", () => {
  it("可调参数取当前值，缺省或类型不对时取默认值", () => {
    const sparkle = def("sparkle");
    const p = defaultEffectParams(sparkle);
    expect(effectParamValue(sparkle, p, "density")).toBe(0.3);
    expect(effectParamValue(sparkle, { ...p, values: { density: 0.8 } }, "density")).toBe(0.8);
    expect(effectParamValue(sparkle, { ...p, values: { density: "x" } }, "density")).toBe(0.3);
    expect(effectParamValue(sparkle, p, "nope")).toBeUndefined();
    expect(effectHasSeed(sparkle)).toBe(true);
    expect(effectHasSeed(def("circle"))).toBe(false);
  });

  it("规整：非法参数回到默认，未声明或越界的可调参数丢弃", () => {
    const sparkle = def("sparkle");
    expect(sanitizeEffectParams(sparkle, { nope: 1 })).toEqual(defaultEffectParams(sparkle));
    const clean = sanitizeEffectParams(sparkle, {
      ...defaultEffectParams(sparkle),
      blocks: 2,
      values: { density: 0.5, color: [1, 2, 3], other: 1, bad: "x" },
    });
    expect(clean.values).toEqual({ density: 0.5, color: [1, 2, 3] });
    expect(clean.blocks).toBe(2);
    expect(sanitizeEffectParams(sparkle, { ...defaultEffectParams(sparkle), values: { density: 5 } }).values).toBeUndefined();
    // 幅度类的大小夹到 0.5
    expect(sanitizeEffectParams(def("circle"), { ...defaultEffectParams(def("circle")), size: 0.9 }).size).toBe(0.5);
  });
});

describe("特效库：生成外观", () => {
  it("周期按时间计：与片段长度无关，分组成员错开相位", () => {
    const circle = buildEffectLook(def("circle"), defaultEffectParams(def("circle")), { members: 4, tempo });
    expect(circle.look.attrs?.pan).toEqual({
      kind: "curve",
      curve: { shape: "sine", from: 0.35, to: 0.65, cycles: 1, phase: 0, period: { kind: "beats", beats: 4 } },
    });
    expect(circle.look.attrs?.tilt).toMatchObject({ kind: "curve", curve: { phase: 0.25 } });
    expect(circle.look.intensity).toEqual({ kind: "value", value: 100 });
    expect(circle.spread).toEqual({ values: { phase: { from: 0, to: -0.75 } } });
    expect(buildEffectLook(def("circle"), defaultEffectParams(def("circle")), { members: 1, tempo }).spread).toBeUndefined();
    // 层的 cycles 是速度倍数：8 字的 Tilt 两倍速
    const eight = buildEffectLook(def("figure8"), defaultEffectParams(def("figure8")), { members: 1, tempo });
    expect(eight.look.attrs?.tilt).toMatchObject({ curve: { period: { kind: "beats", beats: 4 } } });
  });

  it("参数：大小、反向、分翼、舞台顺序、追逐占空比、成块 / 分组 / 打乱、按拍对齐", () => {
    const p = {
      ...defaultEffectParams(def("intensityChase")),
      size: 60,
      direction: -1 as const,
      wings: 2,
      order: "stageX" as const,
      blocks: 2,
      groups: 3,
      shuffle: 9,
      sync: true,
    };
    const chase = buildEffectLook(def("intensityChase"), p, { members: 4, tempo });
    expect(chase.look.intensity).toEqual({
      kind: "curve",
      curve: { shape: "square", from: 0, to: 60, cycles: 1, phase: 0, period: { kind: "beats", beats: 1 }, sync: "beat", duty: 0.25 },
    });
    expect(chase.spread).toEqual({ values: { phase: { from: 0, to: 0.75 } }, wings: 2, order: "stageX", blocks: 2, groups: 3, shuffle: 9 });
  });

  it("扇形、时间级联、只走一次的渐亮、颜色序列", () => {
    const fan = buildEffectLook(def("fan"), defaultEffectParams(def("fan")), { members: 5, tempo });
    expect(fan.spread?.values?.pan).toEqual({ from: 0.25, to: 0.75 });
    const fade = buildEffectLook(def("fadeIn"), { ...defaultEffectParams(def("fadeIn")), direction: -1 }, { members: 3, tempo });
    expect(fade.look.intensity).toEqual({ kind: "curve", curve: { shape: "ramp", from: 0, to: 100, cycles: 1, phase: 0 } });
    // 4 拍 = 2000 ms，3 台错开 2/3 个周期；反向时成员倒序
    expect(fade.spread).toEqual({ delay: { fromMs: 0, toMs: 1333 }, order: "reverse" });
    const two = buildEffectLook(def("twoColor"), defaultEffectParams(def("twoColor")), { members: 1, tempo });
    expect(two.look.color).toEqual({
      kind: "cycle",
      cycle: {
        colors: [
          { kind: "rgb", rgb: [255, 0, 0] },
          { kind: "rgb", rgb: [0, 64, 255] },
        ],
        blend: "step",
        cycles: 1,
        phase: 0,
        period: { kind: "beats", beats: 2 },
      },
    });
  });

  it("可调参数进入生成的外观：密度、颜色、色表、过渡方式、随机种子（换一组）", () => {
    const sparkle = def("sparkle");
    const a = buildEffectLook(sparkle, { ...defaultEffectParams(sparkle), values: { density: 0.6, color: [255, 0, 0] } }, { members: 3, tempo });
    expect(a.look.intensity).toMatchObject({ curve: { shape: "random", duty: 0.6, ease: "linear" } });
    expect(a.look.color).toEqual({ kind: "value", value: { kind: "rgb", rgb: [255, 0, 0] } });
    const seed = (x: typeof a) => (x.look.intensity?.kind === "curve" ? x.look.intensity.curve.seed : undefined);
    const again = buildEffectLook(sparkle, defaultEffectParams(sparkle), { members: 3, tempo });
    const reroll = buildEffectLook(sparkle, { ...defaultEffectParams(sparkle), seed: 5 }, { members: 3, tempo });
    expect(seed(a)).toBe(seed(again));
    expect(seed(reroll)).not.toBe(seed(a));
    const gradient = def("gradient");
    const g = buildEffectLook(gradient, { ...defaultEffectParams(gradient), values: { colors: [[1, 2, 3], [4, 5, 6], [7, 8, 9]], blend: "hue" } }, { members: 3, tempo });
    expect(g.look.color).toMatchObject({ kind: "cycle", cycle: { blend: "hue", colors: [{ rgb: [1, 2, 3] }, { rgb: [4, 5, 6] }, { rgb: [7, 8, 9] }] } });
    const breathe = buildEffectLook(def("breathe"), { ...defaultEffectParams(def("breathe")), values: { floor: 0.5 } }, { members: 1, tempo });
    expect(breathe.look.intensity).toMatchObject({ curve: { from: 50, to: 100 } });
  });

  it("每个内置特效都能放进工程并通过完整性与工程校验", () => {
    for (const e of BUILTIN_EFFECTS) {
      const p = produce(createEmptyProject("t"), (d) => {
        addFixtures(d, RGBW, 3);
        d.durationMs = 20_000;
        createGroup(d, "排", d.fixtures.map((f) => f.id));
        expect(addEffectDefCue(d, d.tracks.at(-1)!.id, 0, e, { ...defaultEffectParams(e), wings: 2 }), e.id).not.toBeNull();
      });
      expect(projectIntegrityIssues(p), e.id).toEqual([]);
      const r = parseProject(JSON.stringify(p));
      expect(r.ok, `${e.id}: ${r.ok ? "" : r.detail}`).toBe(true);
    }
  });

  it("强度追逐在分组成员之间轮流点亮（引擎求值）", () => {
    const p = produce(createEmptyProject("t"), (d) => {
      addFixtures(d, RGBW, 4);
      d.durationMs = 10_000;
      d.output.gamma = 1;
      createGroup(d, "排", d.fixtures.map((f) => f.id));
      const { look, spread } = buildEffectLook(
        def("intensityChase"),
        { ...defaultEffectParams(def("intensityChase")), period: { kind: "ms", ms: 1000 } },
        { members: 4, tempo: null },
      );
      look.color = { kind: "value", value: { kind: "rgb", rgb: [255, 255, 255] } };
      addLookCue(d, d.tracks.at(-1)!.id, 0, look, 4000, spread);
    });
    const evaluate = createPreviewEvaluator(p, engine);
    const lit = (t: number) => p.fixtures.map((f, i) => ((evaluate(t).get(f.id)?.[0] ?? 0) > 0 ? i : -1)).filter((i) => i >= 0);
    expect(lit(100)).toEqual([0]);
    expect(lit(350)).toEqual([1]);
    expect(lit(850)).toEqual([3]);
    // 周期按时间计：第 3 秒与第 0 秒相同
    expect(lit(3100)).toEqual([0]);
  });

  it("星光闪烁按密度随机点亮，每台灯不同（引擎求值）", () => {
    const p = produce(createEmptyProject("t"), (d) => {
      addFixtures(d, RGBW, 6);
      d.durationMs = 60_000;
      d.output.gamma = 1;
      createGroup(d, "排", d.fixtures.map((f) => f.id));
      addEffectDefCue(d, d.tracks.at(-1)!.id, 0, def("sparkle"), { ...defaultEffectParams(def("sparkle")), values: { density: 0.5 } }, undefined, 50_000);
    });
    const evaluate = createPreviewEvaluator(p, engine);
    let lit = 0;
    let samples = 0;
    const patterns = new Set<string>();
    for (let t = 10; t < 50_000; t += 250) {
      const row = p.fixtures.map((f) => ((evaluate(t).get(f.id)?.[0] ?? 0) > 0 ? 1 : 0));
      lit += row.reduce<number>((a, b) => a + b, 0);
      samples += row.length;
      patterns.add(row.join(""));
    }
    expect(lit / samples).toBeGreaterThan(0.35);
    expect(lit / samples).toBeLessThan(0.65);
    expect(patterns.size).toBeGreaterThan(10);
  });
});

describe("新增特效（引擎求值）", () => {
  /**
   * 把特效放到 n 台 RGBW 灯的分组上（周期改为给定毫秒数），返回 t 时刻每台灯的 [R, G, B, W]。
   * 没有颜色层的特效补白光，方便读强度。
   */
  function run(id: string, members: number, periodMs: number) {
    const e = def(id);
    const p = produce(createEmptyProject("t"), (d) => {
      addFixtures(d, RGBW, members);
      d.durationMs = 20_000;
      d.output.gamma = 1;
      if (members > 1) createGroup(d, "排", d.fixtures.map((f) => f.id));
      const params = { ...defaultEffectParams(e), period: { kind: "ms" as const, ms: periodMs } };
      const { look, spread } = buildEffectLook(e, params, { members, tempo: null });
      look.color ??= { kind: "value", value: { kind: "rgb", rgb: [255, 255, 255], white: "off" } };
      addLookCue(d, d.tracks.at(-1)!.id, 0, look, 10_000, spread);
    });
    const evaluate = createPreviewEvaluator(p, engine);
    return (t: number) => p.fixtures.map((f) => [...(evaluate(t).get(f.id) ?? [0, 0, 0, 0])].slice(0, 4));
  }

  it("心跳：两下强弱跳动后停在最暗", () => {
    const at = run("heartbeat", 1, 1600);
    const red = (t: number) => at(t)[0][0];
    // 8 步每步 200 ms，每步在前 60% 里滑向下一步：第一下在 120~200 ms 最亮，
    // 第二下（70%）在 520~600 ms，后半段停在最暗（5%）
    expect(red(150)).toBeGreaterThan(240);
    expect(red(560)).toBeGreaterThan(150);
    expect(red(560)).toBeLessThan(200);
    expect(red(380)).toBeLessThan(red(560));
    expect(red(1300)).toBeLessThanOrEqual(Math.ceil(255 * 0.05));
  });

  it("红蓝警灯：前半个周期红色连闪，后半个周期蓝色连闪", () => {
    const at = run("police", 1, 800);
    const [r1, , b1] = at(50)[0];
    const [r2, , b2] = at(450)[0];
    expect(r1).toBeGreaterThan(200);
    expect(b1).toBe(0);
    expect(r2).toBe(0);
    expect(b2).toBeGreaterThan(200);
    // 每次闪之间是暗的
    expect(Math.max(...at(150)[0])).toBe(0);
  });

  it("彩色频闪：每闪一下换一种颜色，闪之间全暗", () => {
    const at = run("colorStrobe", 1, 600);
    expect(at(25)[0].slice(0, 3)).toEqual([255, 0, 0]);
    expect(Math.max(...at(75)[0])).toBe(0);
    const second = at(125)[0];
    expect(second[0]).toBe(255);
    expect(second[1]).toBeGreaterThan(150);
  });

  it("拖尾追逐：同一时刻有一台最亮，其余有渐暗的尾巴", () => {
    const at = run("comet", 6, 1200);
    const reds = at(30).map((c) => c[0]);
    const head = Math.max(...reds);
    expect(head).toBeGreaterThan(200);
    expect(reds.filter((v) => v > 0 && v < head).length).toBeGreaterThanOrEqual(2);
  });

  it("火焰：始终是暖色（红远多于蓝），亮度不断变化", () => {
    const at = run("fire", 1, 1200);
    const seen = new Set<number>();
    for (let t = 0; t < 3000; t += 50) {
      const [r, , b] = at(t)[0];
      expect(r).toBeGreaterThan(0);
      expect(b * 5).toBeLessThan(r);
      seen.add(r);
    }
    expect(seen.size).toBeGreaterThan(5);
  });
});

describe("特效片段：快照与改参数", () => {
  it("插入时保存特效快照与参数；时间线标签为特效名", () => {
    const { p: base, track } = grouped();
    let id: string | null = null;
    const p = produce(base, (d) => {
      id = addEffectDefCue(d, track, 2000, def("intensityChase"), { ...defaultEffectParams(def("intensityChase")), size: 60 }, "强度追逐");
    });
    const cue = lookOf(p, id);
    expect(cue).toMatchObject({ kind: "look", trackId: track, startMs: 2000, endMs: 2000 + EFFECT_CLIP_MS, label: "强度追逐" });
    expect(cue?.look.intensity).toMatchObject({ kind: "curve", curve: { to: 60, duty: 0.3333 } });
    expect(cue?.fx?.def.id).toBe("intensityChase");
    expect(cue?.fx?.def.builtin).toBeUndefined();
    expect(cue?.fx?.params.size).toBe(60);
    expect(projectIntegrityIssues(p)).toEqual([]);
    const r = parseProject(JSON.stringify(p));
    expect(r.ok && (r.project.cues.find((c) => c.id === id) as LookClip).fx).toEqual(cue?.fx);
  });

  it("改参数重新生成外观（一步撤销内完成）；锁定轨道不动；共同特效", () => {
    const { p: base, track } = grouped();
    let a: string | null = null;
    let b: string | null = null;
    const p = produce(base, (d) => {
      a = addEffectDefCue(d, track, 0, def("sparkle"), defaultEffectParams(def("sparkle")));
      b = addEffectDefCue(d, track, 10_000, def("sparkle"), defaultEffectParams(def("sparkle")));
    });
    expect(commonFx([lookOf(p, a)!, lookOf(p, b)!])?.def.id).toBe("sparkle");
    let n = 0;
    const q = produce(p, (d) => void (n = setFxParams(d, [a!, b!], { values: { density: 0.9 }, period: { kind: "ms", ms: 500 } })));
    expect(n).toBe(2);
    expect(lookOf(q, a)?.look.intensity).toMatchObject({ curve: { duty: 0.9, period: { kind: "ms", ms: 500 } } });
    expect(lookOf(q, a)?.fx?.params).toMatchObject({ period: { kind: "ms", ms: 500 }, values: { density: 0.9 } });
    // 合并可调参数：只改颜色时保留密度
    const r = produce(q, (d) => void setFxParams(d, [a!], { values: { color: [1, 2, 3] } }));
    expect(lookOf(r, a)?.fx?.params.values).toEqual({ density: 0.9, color: [1, 2, 3] });
    // 清除可选参数
    const withBlocks = produce(q, (d) => void setFxParams(d, [a!], { blocks: 2 }));
    expect(lookOf(withBlocks, a)?.fx?.params.blocks).toBe(2);
    const s = produce(withBlocks, (d) => void setFxParams(d, [a!], { blocks: undefined }));
    expect(lookOf(s, a)?.fx?.params.blocks).toBeUndefined();
    const locked = produce(p, (d) => {
      d.tracks.at(-1)!.lock = true;
    });
    expect(produce(locked, (d) => void setFxParams(d, [a!], { size: 10 }))).toBe(locked);
  });

  it("手动编辑外观层或分布、转为普通外观时删除快照", () => {
    const { p: base, track } = grouped();
    let id: string | null = null;
    const p = produce(base, (d) => {
      id = addEffectDefCue(d, track, 0, def("circle"), defaultEffectParams(def("circle")));
    });
    expect(lookOf(produce(p, (d) => void updateLooks(d, [id!], (l) => void (l.intensity = { kind: "value", value: 50 }))), id)?.fx).toBeUndefined();
    expect(lookOf(produce(p, (d) => void setSpread(d, [id!], undefined)), id)?.fx).toBeUndefined();
    let n = 0;
    const q = produce(p, (d) => void (n = detachFx(d, [id!])));
    expect(n).toBe(1);
    expect(lookOf(q, id)?.fx).toBeUndefined();
    expect(lookOf(q, id)?.look).toEqual(lookOf(p, id)?.look);
  });

  it("轨道不存在时不改工程", () => {
    const p = createEmptyProject("t");
    const next = produce(p, (d) => {
      expect(addEffectDefCue(d, "nope", 0, def("circle"), defaultEffectParams(def("circle")))).toBeNull();
    });
    expect(next).toBe(p);
  });
});

describe("经典颜色特效 → 可配置特效", () => {
  const legacy = (effect: EffectCue["effect"], over: Partial<EffectCue> = {}): EffectCue => ({
    id: "e",
    trackId: "t",
    kind: "effect",
    startMs: 0,
    endMs: 4000,
    brightness: 100,
    fadeInMs: 0,
    fadeOutMs: 0,
    easing: "linear",
    ...presetOf(effect).params,
    ...over,
  });

  it("8 种都有对应：周期、扩散、方向、亮度范围与颜色带过去", () => {
    for (const effect of ["breathe", "rainbow", "chase", "wipe", "gradient", "pulse", "sparkle", "strobe"] as const) {
      expect(legacyEffectFx(legacy(effect)), effect).not.toBeNull();
    }
    const breathe = legacyEffectFx(legacy("breathe", { range: [10, 80], colors: [[255, 0, 0]], phaseSpread: 0.3, direction: -1 }))!;
    expect(breathe.def.look.intensity).toMatchObject({ shape: "sine", lo: 0.1, hi: 0.8 });
    expect(breathe.def.look.color).toEqual({ rgb: "$color" });
    expect(breathe.params).toMatchObject({ period: presetOf("breathe").params.period, spread: 0.3, direction: -1, values: { color: [255, 0, 0] } });
    // 脉冲从亮到暗：保持方向
    expect(legacyEffectFx(legacy("pulse", { range: [20, 100] }))!.def.look.intensity).toMatchObject({ lo: 1, hi: 0.2 });
    // 单色擦除：补一个黑色
    expect(legacyEffectFx(legacy("wipe", { colors: [[0, 255, 0]] }))!.params.values).toEqual({ colors: [[0, 255, 0], [0, 0, 0]] });
    expect(legacyEffectFx(legacy("gradient", { colors: [[1, 2, 3], [4, 5, 6], [7, 8, 9]] }))!.params.values).toEqual({ colors: [[1, 2, 3], [4, 5, 6], [7, 8, 9]] });
  });

  it("原地换成可配置特效片段，时间与亮度保持，可通过工程校验", () => {
    const { p: base, track } = grouped();
    let id: string | null = null;
    const p = produce(base, (d) => {
      id = addEffectCue(d, track, 1000, presetOf("sparkle"));
      const c = d.cues.find((x) => x.id === id);
      if (c) c.brightness = 70;
    });
    let n = 0;
    const q = produce(p, (d) => void (n = convertLegacyEffects(d, [id!], (x) => `→ ${x.id}`)));
    expect(n).toBe(1);
    const cue = lookOf(q, id);
    expect(cue).toMatchObject({ kind: "look", startMs: 1000, brightness: 70, label: "→ sparkle" });
    expect(cue?.fx?.def.id).toBe("sparkle");
    expect(projectIntegrityIssues(q)).toEqual([]);
    expect(parseProject(JSON.stringify(q)).ok).toBe(true);
  });
});
