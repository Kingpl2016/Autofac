import { produce } from "immer";
import { beforeAll, describe, expect, it } from "vitest";

import type { Engine } from "../../engine/engine";
import { loadTestEngine } from "../../engine/__tests__/testEngine";
import { createPreviewEvaluator } from "../color";
import { addLookCue } from "../cueOps";
import {
  BUILTIN_EFFECTS,
  buildEffectLook,
  copyEffectToUser,
  defaultEffectParams,
  effectDefNeeds,
  groupEffects,
  importEffects,
  mergeEffects,
  parseEffectText,
  parseEffects,
  removeEffect,
  serializeEffects,
  type EffectDef,
} from "../effectLibrary";
import { addFixtures, createGroup } from "../ops";
import { createEmptyProject } from "../project";
import { projectIntegrityIssues } from "../schema";
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

describe("特效库：配置文件", () => {
  it("内置 24 个特效，分四组，全部是只读", () => {
    expect(BUILTIN_EFFECTS).toHaveLength(24);
    expect(groupEffects(BUILTIN_EFFECTS).map((g) => [g.group, g.effects.length])).toEqual([
      ["position", 8],
      ["intensity", 8],
      ["color", 4],
      ["beam", 4],
    ]);
    expect(BUILTIN_EFFECTS.every((e) => e.builtin)).toBe(true);
  });

  it("单条不合法时跳过并记下原因；整份不对时没有特效；版本过新给出提示", () => {
    const parsed = parseEffects({
      version: 2,
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
  });

  it("序列化去掉运行时标记，可原样读回", () => {
    const text = serializeEffects(BUILTIN_EFFECTS);
    expect(text).not.toContain("builtin");
    expect(parseEffectText(text).effects.map((e) => e.id)).toEqual(BUILTIN_EFFECTS.map((e) => e.id));
  });

  it("合并：同 id 的用户特效覆盖内置的；复制、删除、导入", () => {
    const mine: EffectDef = { ...def("circle"), builtin: undefined, name: "我的画圆" };
    const merged = mergeEffects(BUILTIN_EFFECTS, [mine]);
    expect(merged[0].name).toBe("我的画圆");
    expect(merged).toHaveLength(24);

    const { next, created } = copyEffectToUser([], BUILTIN_EFFECTS, def("rainbow"), " 副本");
    expect(created).toMatchObject({ id: "my-effect-1", group: "custom", name: { zh: "彩虹 副本", en: "Rainbow 副本" } });
    expect(created.builtin).toBeUndefined();
    expect(removeEffect(next, created.id)).toEqual([]);
    const imported = importEffects(next, [{ ...created, name: "改名" }, { ...def("strobe"), id: "s2" }]);
    expect([imported.added, imported.replaced]).toEqual([1, 1]);
    expect(imported.next.every((e) => e.builtin === undefined)).toBe(true);
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

describe("特效库：生成外观", () => {
  it("与旧的画圆一致：按拍换算次数，分组成员错开相位", () => {
    const circle = buildEffectLook(def("circle"), defaultEffectParams(def("circle")), { lengthMs: 8000, members: 4, tempo });
    expect(circle.look.attrs?.pan).toMatchObject({ kind: "curve", curve: { shape: "sine", from: 0.35, to: 0.65, cycles: 4, phase: 0 } });
    expect(circle.look.attrs?.tilt).toMatchObject({ kind: "curve", curve: { phase: 0.25 } });
    expect(circle.look.intensity).toEqual({ kind: "value", value: 100 });
    expect(circle.spread).toEqual({ values: { phase: { from: 0, to: -0.75 } } });
    expect(buildEffectLook(def("circle"), defaultEffectParams(def("circle")), { lengthMs: 8000, members: 1, tempo }).spread).toBeUndefined();
  });

  it("参数：大小、反向、分翼、舞台顺序、追逐占空比", () => {
    const p = { ...defaultEffectParams(def("intensityChase")), size: 60, direction: -1 as const, wings: 2, order: "stageX" as const };
    const chase = buildEffectLook(def("intensityChase"), p, { lengthMs: 4000, members: 4, tempo });
    expect(chase.look.intensity).toMatchObject({ kind: "curve", curve: { shape: "square", from: 0, to: 60, duty: 0.25, cycles: 8 } });
    expect(chase.spread).toEqual({ values: { phase: { from: 0, to: 0.75 } }, wings: 2, order: "stageX" });
  });

  it("扇形、时间级联与只走一次的渐亮", () => {
    const fan = buildEffectLook(def("fan"), defaultEffectParams(def("fan")), { lengthMs: 8000, members: 5, tempo });
    expect(fan.spread?.values?.pan).toEqual({ from: 0.25, to: 0.75 });
    const fade = buildEffectLook(def("fadeIn"), { ...defaultEffectParams(def("fadeIn")), direction: -1 }, { lengthMs: 8000, members: 3, tempo });
    expect(fade.look.intensity).toMatchObject({ kind: "curve", curve: { shape: "ramp", from: 0, to: 100, cycles: 1 } });
    // 4 拍 = 2000 ms，3 台错开 2/3 个周期；反向时成员倒序
    expect(fade.spread).toEqual({ delay: { fromMs: 0, toMs: 1333 }, order: "reverse" });
    const two = buildEffectLook(def("twoColor"), defaultEffectParams(def("twoColor")), { lengthMs: 4000, members: 1, tempo });
    expect(two.look.color?.kind === "keys" && two.look.color.keys.every((k) => k.curve === "hold")).toBe(true);
  });

  it("每个内置特效都能放进工程并通过完整性校验", () => {
    for (const e of BUILTIN_EFFECTS) {
      const p = produce(createEmptyProject("t"), (d) => {
        addFixtures(d, RGBW, 3);
        d.durationMs = 20_000;
        const { look, spread } = buildEffectLook(e, { ...defaultEffectParams(e), wings: 2 }, { lengthMs: 8000, members: 3, tempo });
        expect(addLookCue(d, d.tracks[0].id, 0, look, 8000, spread), e.id).not.toBeNull();
      });
      expect(projectIntegrityIssues(p), e.id).toEqual([]);
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
        { lengthMs: 4000, members: 4, tempo: null },
      );
      look.color = { kind: "value", value: { kind: "rgb", rgb: [255, 255, 255] } };
      addLookCue(d, d.tracks.at(-1)!.id, 0, look, 4000, spread);
    });
    const evaluate = createPreviewEvaluator(p, engine);
    const lit = (t: number) => p.fixtures.map((f, i) => ((evaluate(t).get(f.id)?.[0] ?? 0) > 0 ? i : -1)).filter((i) => i >= 0);
    expect(lit(100)).toEqual([0]);
    expect(lit(350)).toEqual([1]);
    expect(lit(850)).toEqual([3]);
  });
});
