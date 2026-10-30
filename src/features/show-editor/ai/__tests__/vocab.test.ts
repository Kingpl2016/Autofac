import { produce } from "immer";
import { describe, expect, it } from "vitest";

import { BUILTIN_TEMPLATES } from "../../lib/cueTemplates";
import { BUILTIN_EFFECTS } from "../../lib/effectLibrary";
import { addFixtures } from "../../lib/ops";
import { createEmptyProject } from "../../lib/project";
import { HEAD16, RGBW } from "../../lib/__tests__/testkit";
import { buildAliases, resolveAlias } from "../aliases";
import { summarizeProject } from "../context";
import { draftPlanToOps, draftSpans } from "../draft";
import { aiOpsSchema, draftPlanSchema } from "../opsSchema";
import { toPortableJsonSchema, validateWith } from "../portableSchema";
import { describeTime, resolveShift, resolveTime } from "../timeRef";
import { quantizeRgb, resolveColor } from "../vocab";

const tempo = { bpm: 120, offsetMs: 0, beatsPerBar: 4 };
const project = produce(createEmptyProject("t"), (d) => {
  addFixtures(d, RGBW, 4);
  addFixtures(d, HEAD16, 2);
  d.durationMs = 40_000;
  d.tempo = tempo;
});

describe("词汇表与量化", () => {
  it("相近的颜色落到同一个值，量化是幂等的", () => {
    expect(resolveColor("#1E90FF")).toEqual(resolveColor("#1F8FFF"));
    const q = quantizeRgb([30, 144, 255]);
    expect(quantizeRgb(q)).toEqual(q);
    expect(resolveColor("Blue")).toEqual({ kind: "rgb", rgb: [0, 0, 255] });
    expect(resolveColor("3150K")).toEqual({ kind: "kelvin", kelvin: 3200 });
    expect(resolveColor("chartreuse")).toBeNull();
  });

  it("时间引用：秒、小节、段落、标记点与偏移量", () => {
    const p = produce(project, (d) => {
      d.sections = [{ id: "s", name: "A", startMs: 2000, endMs: 6000, color: [0, 0, 0] }];
      d.markers = [{ id: "m", timeMs: 5000, label: "x" }];
    });
    const ctx = { project: p, aliases: buildAliases(p), playheadMs: 1234 };
    const ms = (r: string) => {
      const x = resolveTime(r, ctx);
      return x.ok ? x.ms : x.error;
    };
    expect(ms("b3")).toBe(4000);
    expect(ms("b3:2")).toBe(4500);
    expect(ms("b3:2.5")).toBe(4767); // 4.75 s 对齐到输出帧（30 FPS）
    expect(ms("1.07s")).toBe(1133); // 1/4 拍网格 1.125 s，再对齐到帧
    expect(ms("S1:end")).toBe(6000);
    expect(ms("M1")).toBe(5000);
    expect(ms("end")).toBe(40_000);
    expect(ms("b0")).toMatch(/start at 1/);
    expect(ms("1:30")).toMatch(/not a valid time/);
    expect(resolveShift("+2bars", p)).toEqual({ ok: true, ms: 4000 });
    expect(resolveShift("-1beats", p)).toEqual({ ok: true, ms: -500 });
    expect(describeTime(4500, p)).toBe("0:04.5 (b3:2)");
  });

  it("别名由工程内容决定，重复生成结果相同", () => {
    const a = buildAliases(project);
    const b = buildAliases(structuredClone(project));
    expect([...a.toId.keys()]).toEqual([...b.toId.keys()]);
    expect(resolveAlias(a, "f1", "F")).toBe(project.fixtures[0].id);
    expect(resolveAlias(a, "F1", "G")).toBeNull();
  });

  it("摘要稳定、不含 id 与路径", () => {
    const aliases = buildAliases(project);
    const text = summarizeProject(project, aliases, { playheadMs: 0, selection: [] });
    expect(text).toBe(summarizeProject(project, buildAliases(project), { playheadMs: 0, selection: [] }));
    expect(text).toContain("F1-F4 ×4");
    expect(text).toContain("F5-F6 ×2");
    expect(text).toContain("Tempo 120 BPM");
    expect(text).not.toContain(project.fixtures[0].id);
  });
});

/** 遍历 JSON Schema 的所有节点。 */
function walk(node: unknown, visit: (n: Record<string, unknown>, depth: number) => void, depth = 0): void {
  if (Array.isArray(node)) node.forEach((x) => walk(x, visit, depth));
  else if (typeof node === "object" && node !== null) {
    const n = node as Record<string, unknown>;
    visit(n, depth);
    for (const v of Object.values(n)) walk(v, visit, depth + 1);
  }
}

describe("可移植 JSON Schema", () => {
  it.each([
    ["ops", aiOpsSchema],
    ["draft", draftPlanSchema],
  ] as const)("%s：没有 oneOf / const / 数值关键字，所有字段必填、对象封闭", (_name, schema) => {
    const js = toPortableJsonSchema(schema);
    let maxDepth = 0;
    walk(js, (n, depth) => {
      maxDepth = Math.max(maxDepth, depth);
      for (const k of ["oneOf", "const", "minimum", "maximum", "pattern", "minItems", "maxItems", "maxLength", "default", "$schema"]) {
        expect(n[k], k).toBeUndefined();
      }
      if (n.type === "object" && n.properties) {
        expect(n.additionalProperties).toBe(false);
        expect([...(n.required as string[])].sort()).toEqual(Object.keys(n.properties as object).sort());
      }
    });
    // 嵌套不太深（schema 节点层数，含 properties / items / anyOf 这类中间层）
    expect(maxDepth).toBeLessThanOrEqual(16);
  });

  it("宽松解析：漏写的可省略字段补 null，多写的字段忽略，错误给出路径", () => {
    const ok = validateWith(aiOpsSchema, { summary: "x", ops: [{ op: "deleteCues", cues: ["C1"], extra: 1 }] });
    expect(ok).toEqual({ success: true, value: { summary: "x", ops: [{ op: "deleteCues", cues: ["C1"] }] } });
    const bad = validateWith(aiOpsSchema, { summary: "x", ops: [{ op: "addEffect", target: "all" }] });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.message).toMatch(/ops\.0/);
  });
});

describe("一键草稿", () => {
  it("没有段落时按 8 小节切分，并随草稿新建段落", () => {
    const aliases = buildAliases(project);
    const spans = draftSpans(project, aliases, "zh");
    expect(spans.map((s) => [s.alias, s.from, s.to])).toEqual([
      ["S1", "start", "b9"],
      ["S2", "b9", "b17"],
      ["S3", "b17", "end"],
    ]);
    const plan = draftPlanSchema.parse({
      summary: "",
      palette: "cool",
      items: [
        { section: "S1", energy: "low", light: "mood-calm" },
        { section: "S2", energy: "mid", light: "intensityWave", move: "panSweep" },
        { section: "S3", energy: "high", light: "colorChase", period: "1", move: "circle" },
      ],
    });
    const ops = draftPlanToOps(plan, spans, project, { effects: BUILTIN_EFFECTS, templates: BUILTIN_TEMPLATES });
    expect(ops.ops.map((o) => o.op)).toEqual(["addSection", "addSection", "addSection", "applyTemplate", "addEffect", "addEffect", "addEffect", "addEffect"]);
    expect(ops.ops[4]).toMatchObject({ op: "addEffect", target: "all", effect: "intensityWave", colors: ["cyan", "violet"] });
  });
});
