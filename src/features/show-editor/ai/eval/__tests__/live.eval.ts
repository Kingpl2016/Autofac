import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createLanguageModel } from "@/features/ai/lib/model";
import type { AiProfile } from "@/features/ai/lib/types";
import { planOps } from "../../compile";
import { PROMPT_VERSION } from "../../prompt";
import { RECIPES_VERSION } from "../../recipes";
import { createShowAgent, runDraft, type Proposal } from "../../runtime";
import { SKILLS_VERSION } from "../../skills";
import { expectationScore, extractFeatures, meanAgreement, type SpanFeatures } from "../features";
import { caseSnapshot, caseSpans, checkScore, EDIT_CASES, EVAL_CASES } from "./cases";

/**
 * 真实调用各家模型的一致性评测（手动运行，不进 CI）：`npm run ai:eval`。
 *
 * 配置文件（`AI_EVAL_CONFIG`，默认 `ai-eval.config.json`，不要提交到仓库）：
 *
 * ```json
 * { "runs": 3, "models": [
 *   { "name": "deepseek", "kind": "openaiCompatible", "baseUrl": "https://api.deepseek.com/v1",
 *     "model": "deepseek-chat", "keyEnv": "DEEPSEEK_API_KEY", "supportsStructuredOutputs": false, "seed": 7 }
 * ] }
 * ```
 *
 * - 用例分两类：一键草稿（`EVAL_CASES`）与对话编辑（`EDIT_CASES`，走对话智能体与 `propose_ops`）；
 * - `AI_EVAL_SKILLS`：`on`（默认）只跑注入技能的版本，`off` 只跑不注入的，`both` 两种都跑并在报告里对比；
 * - Key 从环境变量读取。结果写到 `ai-eval/report.md`；`AI_EVAL_RECORD=1` 时把每次的模型输出录进
 *   `src/features/show-editor/ai/eval/recordings/`，供 CI 回放（`replay.test.ts`）。
 */

interface ModelConfig {
  name: string;
  kind: AiProfile["kind"];
  baseUrl: string;
  model: string;
  keyEnv?: string;
  supportsStructuredOutputs?: boolean;
  temperature?: number;
  seed?: number;
}

interface EvalConfig {
  runs?: number;
  models: ModelConfig[];
}

/** 一次运行的结果。 */
interface RunResult {
  ok: boolean;
  /** 草稿为尝试次数，编辑为 propose_ops 调用次数。 */
  attempts: number;
  ms: number;
  features: SpanFeatures[];
  expectation: number;
  /** 编辑用例的检查得分（草稿为 1）。 */
  checks: number;
  error?: string;
}

/** 技能开 / 关。 */
type Variant = "skills" | "plain";

const root = path.resolve(import.meta.dirname, "../../../../../..");
const configPath = path.resolve(root, process.env.AI_EVAL_CONFIG ?? "ai-eval.config.json");
const recordDir = path.resolve(import.meta.dirname, "../recordings");
const VARIANTS: readonly Variant[] = (() => {
  const v = process.env.AI_EVAL_SKILLS ?? "on";
  return v === "both" ? ["skills", "plain"] : v === "off" ? ["plain"] : ["skills"];
})();
const ALL_CASES = [...EVAL_CASES.map((c) => c.id), ...EDIT_CASES.map((c) => c.id)];

function readConfig(): EvalConfig | null {
  try {
    return JSON.parse(readFileSync(configPath, "utf8")) as EvalConfig;
  } catch {
    return null;
  }
}

const config = readConfig();
const pct = (x: number) => `${Math.round(x * 100)}%`;
const avg = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const failed = (started: number, e: unknown): RunResult => ({
  ok: false,
  attempts: 0,
  ms: performance.now() - started,
  features: [],
  expectation: 0,
  checks: 0,
  error: e instanceof Error ? e.message : String(e),
});

function record(name: string, data: Record<string, unknown>): void {
  if (process.env.AI_EVAL_RECORD !== "1") return;
  mkdirSync(recordDir, { recursive: true });
  writeFileSync(path.join(recordDir, `${name}.json`), `${JSON.stringify({ promptVersion: PROMPT_VERSION, ...data }, null, 2)}\n`);
}

describe.skipIf(!config)("各模型的一致性评测", () => {
  const cfg = config as EvalConfig;
  const runs = Math.max(1, cfg?.runs ?? 3);
  /** `模型 / 变体` → 用例 → 每次运行。 */
  const results = new Map<string, Map<string, RunResult[]>>();
  const key = (model: string, variant: Variant) => `${model} / ${variant}`;

  for (const m of cfg?.models ?? []) {
    for (const variant of VARIANTS) {
      it(
        key(m.name, variant),
        async () => {
          const apiKey = m.keyEnv ? (process.env[m.keyEnv] ?? "") : "";
          const model = createLanguageModel(
            { kind: m.kind, baseUrl: m.baseUrl, model: m.model, supportsStructuredOutputs: m.supportsStructuredOutputs ?? false },
            globalThis.fetch,
            apiKey || "none",
          );
          const loaded = { model, settings: { temperature: m.temperature ?? 0, ...(m.seed === undefined ? {} : { seed: m.seed }) }, profile: {} as never };
          const skills = variant === "skills";
          const suffix = skills ? "" : ".plain";
          const byCase = new Map<string, RunResult[]>();

          for (const c of EVAL_CASES) {
            const list: RunResult[] = [];
            for (let run = 1; run <= runs; run += 1) {
              const started = performance.now();
              const snapshot = caseSnapshot(c);
              try {
                const r = await runDraft({ loaded, snapshot, prompt: c.prompt, palette: null, skills });
                const plan = planOps(c.project, r.ops.ops, snapshot.env, snapshot.aliases);
                const features = extractFeatures(plan.next, caseSpans(c));
                list.push({ ok: true, attempts: r.attempts, ms: performance.now() - started, features, expectation: expectationScore(features, c.expect), checks: 1 });
                record(`${c.id}.${m.name}${suffix}.${run}`, { case: c.id, model: m.name, skills, run, plan: r.plan, features });
              } catch (e) {
                list.push(failed(started, e));
              }
            }
            byCase.set(c.id, list);
          }

          for (const c of EDIT_CASES) {
            const list: RunResult[] = [];
            for (let run = 1; run <= runs; run += 1) {
              const started = performance.now();
              const snapshot = caseSnapshot(c);
              const proposals: Proposal[] = [];
              try {
                const agent = createShowAgent({ loaded, snapshot: () => snapshot, onProposal: (p) => proposals.push(p), skills });
                const result = await agent.generate({ prompt: c.prompt });
                const last = proposals.at(-1);
                if (!last) throw new Error(`no proposal; the model answered: ${result.text.slice(0, 200)}`);
                const plan = planOps(c.project, last.ops.ops, snapshot.env, snapshot.aliases);
                const features = extractFeatures(plan.next, caseSpans(c));
                const calls = result.steps.flatMap((s) => s.toolCalls).filter((t) => t.toolName === "propose_ops").length;
                list.push({
                  ok: true,
                  attempts: calls,
                  ms: performance.now() - started,
                  features,
                  expectation: expectationScore(features, c.expect),
                  checks: checkScore(c, plan.next),
                });
                record(`${c.id}.${m.name}${suffix}.${run}`, { case: c.id, model: m.name, skills, run, ops: last.ops, features });
              } catch (e) {
                list.push(failed(started, e));
              }
            }
            byCase.set(c.id, list);
          }
          results.set(key(m.name, variant), byCase);
          expect(byCase.size).toBe(ALL_CASES.length);
        },
        60 * 60_000,
      );
    }
  }

  it("写评测报告", () => {
    const names = [...new Set((cfg?.models ?? []).map((m) => m.name))];
    const runsOf = (k: string, ids: readonly string[]) => ids.map((id) => results.get(k)?.get(id) ?? []);
    const draftIds = EVAL_CASES.map((c) => c.id);
    const editIds = EDIT_CASES.map((c) => c.id);

    /** 一组用例上的汇总行。 */
    const row = (k: string, ids: readonly string[]) => {
      const lists = runsOf(k, ids);
      const all = lists.flat();
      const ok = all.filter((r) => r.ok);
      const self = lists.map((list) => meanAgreement(list.filter((r) => r.ok).map((r) => r.features)));
      return {
        success: ok.length / Math.max(1, all.length),
        attempts: avg(ok.map((r) => r.attempts)),
        seconds: avg(ok.map((r) => r.ms)) / 1000,
        self: avg(self),
        expectation: avg(ok.map((r) => r.expectation)),
        checks: avg(ok.map((r) => r.checks)),
      };
    };

    /** 两个结果集之间的跨模型一致度（各取第一次成功的结果，按用例平均）。 */
    const cross = (a: string, b: string, ids: readonly string[]) => {
      const scores = ids.map((id) => {
        const fa = results.get(a)?.get(id)?.find((r) => r.ok)?.features;
        const fb = results.get(b)?.get(id)?.find((r) => r.ok)?.features;
        return fa && fb ? meanAgreement([fa, fb]) : 0;
      });
      return avg(scores);
    };

    /** 所有模型两两之间的跨模型一致度平均值。 */
    const crossMean = (variant: Variant, ids: readonly string[]) => {
      const pairs: number[] = [];
      for (let i = 0; i < names.length; i += 1) {
        for (let j = i + 1; j < names.length; j += 1) pairs.push(cross(key(names[i], variant), key(names[j], variant), ids));
      }
      return pairs.length ? avg(pairs) : 1;
    };

    const lines = [
      "# AI 一致性评测",
      "",
      `提示词版本 ${PROMPT_VERSION}（技能 ${SKILLS_VERSION}、配方 ${RECIPES_VERSION}），每个用例每个模型运行 ${runs} 次，温度按配置（默认 0）。`,
      `变体：${VARIANTS.map((v) => (v === "skills" ? "注入技能" : "不注入技能")).join("、")}。`,
    ];
    for (const variant of VARIANTS) {
      for (const [title, ids] of [["一键草稿", draftIds], ["对话编辑", editIds]] as const) {
        lines.push(
          "",
          `## ${title}（${variant === "skills" ? "注入技能" : "不注入技能"}）`,
          "",
          "| 模型 | 成功率 | 平均尝试次数 | 平均耗时 | 自身一致度 | 期望满足率 | 检查通过率 |",
          "| --- | --- | --- | --- | --- | --- | --- |",
        );
        for (const name of names) {
          const r = row(key(name, variant), ids);
          lines.push(`| ${name} | ${pct(r.success)} | ${r.attempts.toFixed(2)} | ${r.seconds.toFixed(1)} s | ${pct(r.self)} | ${pct(r.expectation)} | ${pct(r.checks)} |`);
        }
        lines.push("", `跨模型一致度：`, "", `| | ${names.join(" | ")} |`, `| --- |${names.map(() => " --- |").join("")}`);
        for (const a of names) lines.push(`| ${a} | ${names.map((b) => pct(cross(key(a, variant), key(b, variant), ids))).join(" | ")} |`);
      }
    }
    if (VARIANTS.length === 2) {
      lines.push(
        "",
        "## 技能的效果（注入 − 不注入）",
        "",
        "| 用例组 | 指标 | 注入技能 | 不注入 | 差值 |",
        "| --- | --- | --- | --- | --- |",
      );
      for (const [title, ids] of [["一键草稿", draftIds], ["对话编辑", editIds]] as const) {
        const metric = (v: Variant, pick: (r: ReturnType<typeof row>) => number) => avg(names.map((n) => pick(row(key(n, v), ids))));
        const metrics: [string, number, number][] = [
          ["跨模型一致度", crossMean("skills", ids), crossMean("plain", ids)],
          ["自身一致度", metric("skills", (r) => r.self), metric("plain", (r) => r.self)],
          ["期望满足率", metric("skills", (r) => r.expectation), metric("plain", (r) => r.expectation)],
          ["检查通过率", metric("skills", (r) => r.checks), metric("plain", (r) => r.checks)],
          ["成功率", metric("skills", (r) => r.success), metric("plain", (r) => r.success)],
        ];
        for (const [label, on, off] of metrics) {
          const diff = Math.round((on - off) * 100);
          lines.push(`| ${title} | ${label} | ${pct(on)} | ${pct(off)} | ${diff >= 0 ? "+" : ""}${diff} |`);
        }
      }
    }
    const failures = [...results.entries()].flatMap(([k, byCase]) =>
      [...byCase.entries()].flatMap(([c, list]) => list.filter((r) => !r.ok).map((r) => `- ${k} / ${c}: ${r.error}`)),
    );
    if (failures.length > 0) lines.push("", "## 失败", "", ...failures);
    const out = path.resolve(root, "ai-eval");
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, "report.md"), `${lines.join("\n")}\n`);
    console.log(lines.join("\n"));
  });
});
