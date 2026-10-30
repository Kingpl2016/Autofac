import { describe, expect, it } from "vitest";

import { planOps } from "../../compile";
import { draftPlanToOps, draftSpans } from "../../draft";
import { aiOpsSchema, draftPlanSchema } from "../../opsSchema";
import { agreement, expectationScore, extractFeatures, meanAgreement, type SpanFeatures } from "../features";
import { caseSnapshot, caseSpans, checkScore, EDIT_CASES, EVAL_CASES } from "./cases";

/**
 * 回放录下的模型响应（CI 里跑，不调用模型）：保证编译器 / 规范化的改动不会让同一份模型输出得到不同的结果。
 *
 * 录音由 `npm run ai:eval`（`AI_EVAL_RECORD=1`）写进 `recordings/`，每份包含模型给出的草稿计划和当时算出的特征。
 * 有意改了编译规则、导致特征变化时，用新的评测结果重新录制。
 */

/** 一份录音：草稿用例录模型给出的计划（`plan`），编辑用例录 `propose_ops` 的操作（`ops`）。 */
interface Recording {
  case: string;
  model: string;
  promptVersion: number;
  /** 录制时是否注入了技能（旧录音没有这个字段，按注入算）。 */
  skills?: boolean;
  run: number;
  plan?: unknown;
  ops?: unknown;
  features: SpanFeatures[];
}

const recordings = Object.entries(import.meta.glob<Recording>("../recordings/*.json", { eager: true, import: "default" }));

describe("评测特征与评分", () => {
  const f = (kind: string, hue: string, level: SpanFeatures["level"], moves: boolean): SpanFeatures => ({ kind, hue, level, moves });

  it("一致度逐段逐项计分，段数不同时缺的段算不一致", () => {
    const a = [f("color", "h5", "high", true), f("intensity", "h5", "low", false)];
    expect(agreement(a, a)).toBe(1);
    expect(agreement(a, [f("color", "h5", "high", true), f("intensity", "h4", "low", false)])).toBe(7 / 8);
    expect(agreement(a, [a[0]])).toBe(4 / 8);
    expect(meanAgreement([a, a, a])).toBe(1);
    expect(meanAgreement([a])).toBe(1);
  });

  it("期望得分", () => {
    const a = [f("color", "h5", "high", true)];
    expect(expectationScore(a, [{ span: 0, field: "hue", oneOf: ["h4", "h5"] }, { span: 0, field: "moves", oneOf: [false] }])).toBe(0.5);
  });

  it("用例都有段落，期望引用的段落都存在", () => {
    for (const c of [...EVAL_CASES, ...EDIT_CASES]) {
      const spans = caseSpans(c);
      expect(spans.length, c.id).toBeGreaterThan(0);
      for (const e of c.expect) expect(e.span, c.id).toBeLessThan(spans.length);
    }
  });

  it.each(EDIT_CASES.map((c) => [c.id, c] as const))("编辑用例 %s：参考答案满足全部期望与检查，原工程不满足", (_id, c) => {
    const snapshot = caseSnapshot(c);
    const ops = aiOpsSchema.parse({ summary: "", ops: c.reference }).ops;
    const result = planOps(c.project, ops, snapshot.env, snapshot.aliases);
    expect(result.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(expectationScore(extractFeatures(result.next, caseSpans(c)), c.expect)).toBe(1);
    expect(checkScore(c, result.next)).toBe(1);
    const before = expectationScore(extractFeatures(c.project, caseSpans(c)), c.expect) * checkScore(c, c.project);
    expect(before).toBeLessThan(1);
  });
});

describe.skipIf(recordings.length === 0)("回放录下的模型响应", () => {
  it.each(recordings)("%s", (_file, rec) => {
    const edit = EDIT_CASES.find((x) => x.id === rec.case);
    if (edit) {
      const snapshot = caseSnapshot(edit);
      const ops = aiOpsSchema.parse(rec.ops);
      const result = planOps(edit.project, ops.ops, snapshot.env, snapshot.aliases);
      expect(result.issues.filter((i) => i.level === "error")).toEqual([]);
      expect(extractFeatures(result.next, caseSpans(edit))).toEqual(rec.features);
      return;
    }
    const c = EVAL_CASES.find((x) => x.id === rec.case);
    expect(c, `未知用例 ${rec.case}`).toBeDefined();
    if (!c) return;
    const snapshot = caseSnapshot(c);
    const plan = draftPlanSchema.parse(rec.plan);
    const spans = draftSpans(c.project, snapshot.aliases, "zh");
    const ops = draftPlanToOps(plan, spans, c.project, snapshot.env);
    const result = planOps(c.project, ops.ops, snapshot.env, snapshot.aliases);
    expect(result.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(extractFeatures(result.next, caseSpans(c))).toEqual(rec.features);
  });
});
