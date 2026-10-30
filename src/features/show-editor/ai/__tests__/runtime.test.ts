import { produce } from "immer";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import type { LoadedModel } from "@/features/ai";
import { BUILTIN_TEMPLATES } from "../../lib/cueTemplates";
import { BUILTIN_EFFECTS } from "../../lib/effectLibrary";
import { addFixtures } from "../../lib/ops";
import { createEmptyProject, type ShowProject } from "../../lib/project";
import { HEAD16, RGBW } from "../../lib/__tests__/testkit";
import { buildAliases } from "../aliases";
import type { EditorSnapshot } from "../env";
import { createShowAgent, runDraft, type Proposal } from "../runtime";

vi.mock("@/features/ai", () => ({}));

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
};
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], finishReason: { unified: "stop" as const, raw: undefined }, usage, warnings: [] });
const call = (id: string, toolName: string, input: unknown) => ({
  content: [{ type: "tool-call" as const, toolCallId: id, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls" as const, raw: undefined },
  usage,
  warnings: [],
});

const project: ShowProject = produce(createEmptyProject("t"), (d) => {
  addFixtures(d, RGBW, 4);
  addFixtures(d, HEAD16, 2);
  d.durationMs = 32_000;
  d.tempo = { bpm: 120, offsetMs: 0, beatsPerBar: 4 };
});

const snapshot = (p: ShowProject = project): EditorSnapshot => ({
  project: p,
  aliases: buildAliases(p),
  env: { effects: BUILTIN_EFFECTS, templates: BUILTIN_TEMPLATES, libraryModels: [RGBW], lang: "zh", playheadMs: 0, selection: [] },
  summary: { playheadMs: 0, selection: [] },
});

const loaded = (model: MockLanguageModelV4): LoadedModel =>
  ({ model, settings: { temperature: 0 }, profile: { id: "p" } }) as unknown as LoadedModel;

describe("一键草稿（回放模型响应）", () => {
  it("计划展开成操作并能应用；模型给错特效时把错误回传，第二次修正后成功", async () => {
    const bad = { summary: "x", palette: "cool", items: [{ section: "S1", energy: "low", light: "nope", colors: null, period: null, move: null }] };
    const good = {
      summary: "冷色开场，后段加速",
      palette: "cool",
      items: [
        { section: "S1", energy: "low", light: "breathe", colors: null, period: null, move: null },
        { section: "S2", energy: "high", light: "colorChase", colors: ["blue", "violet"], period: "1", move: "circle" },
      ],
    };
    const model = new MockLanguageModelV4({ doGenerate: [text(JSON.stringify(bad)), text(JSON.stringify(good))] });
    const attempts: number[] = [];
    const r = await runDraft({ loaded: loaded(model), snapshot: snapshot(), prompt: "冷色", palette: null, onAttempt: (n) => attempts.push(n) });
    expect(attempts).toEqual([1, 2]);
    expect(r.attempts).toBe(2);
    expect(r.ops.summary).toBe("冷色开场，后段加速");
    expect(r.ops.ops.filter((o) => o.op === "addSection")).toHaveLength(2);
    // 第二次请求带上了第一次的错误说明
    const second = JSON.stringify(model.doGenerateCalls[1].prompt);
    expect(second).toContain("unknown effect 'nope'");
  });

  it("模型输出不是合法结构时重试；连续失败后报错", async () => {
    const model = new MockLanguageModelV4({ doGenerate: [text("not json"), text("{}"), text("[]")] });
    await expect(runDraft({ loaded: loaded(model), snapshot: snapshot(), prompt: "", palette: "fire" })).rejects.toMatchObject({ code: "no_object" });
    expect(model.doGenerateCalls).toHaveLength(3);
  });
});

describe("对话智能体（回放模型响应）", () => {
  it("只读工具查询，propose_ops 校验失败时回传错误，修正后交给界面暂存", async () => {
    const proposals: Proposal[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: [
        call("1", "list_cues", { target: null, from: null, to: null }),
        call("2", "propose_ops", { summary: "错", ops: [{ op: "addEffect", target: "G7", from: "b1", to: "b5", effect: "breathe" }] }),
        call("3", "propose_ops", { summary: "全部灯呼吸", ops: [{ op: "addEffect", target: "all", from: "b1", to: "b5", effect: "breathe" }] }),
        text("已准备好：前 4 小节全部灯慢呼吸。"),
      ],
    });
    const agent = createShowAgent({ loaded: loaded(model), snapshot: () => snapshot(), onProposal: (p) => proposals.push(p) });
    const result = await agent.generate({ prompt: "前四小节来个呼吸" });
    expect(result.text).toContain("呼吸");
    expect(proposals).toHaveLength(1);
    expect(proposals[0].ops.ops[0]).toMatchObject({ op: "addEffect", target: "all", effect: "breathe", period: null });
    // 每一步的系统提示词都带着工程摘要；第二次 propose_ops 前模型看到了第一次的错误
    const third = JSON.stringify(model.doGenerateCalls[2].prompt);
    expect(third).toContain("no group 'G7'");
    expect(JSON.stringify(model.doGenerateCalls[0].prompt)).toContain("Tempo 120 BPM");
    // 发给模型的工具 schema 是可移植形态
    const tools = JSON.stringify(model.doGenerateCalls[0].tools);
    expect(tools).not.toContain('"oneOf"');
    expect(tools).toContain("propose_ops");
    expect(tools).toContain("list_recipes");
  });

  it("按用户最后一句话注入技能；关掉技能时提示词里没有", async () => {
    const reply = () => new MockLanguageModelV4({ doGenerate: [text("好")] });
    const on = reply();
    await createShowAgent({ loaded: loaded(on), snapshot: () => snapshot(), onProposal: () => {} }).generate({
      messages: [
        { role: "user", content: "你好" },
        { role: "assistant", content: "你好" },
        { role: "user", content: [{ type: "text", text: "摇头灯画圆" }] },
      ],
    });
    const system = JSON.stringify(on.doGenerateCalls[0].prompt[0]);
    expect(system).toContain("### Moving heads");
    expect(system).toContain("### Everyday wording");
    expect(system).not.toContain("### Patch and output");

    const off = reply();
    await createShowAgent({ loaded: loaded(off), snapshot: () => snapshot(), onProposal: () => {}, skills: false }).generate({ prompt: "摇头灯画圆" });
    expect(JSON.stringify(off.doGenerateCalls[0].prompt[0])).not.toContain("Guides for this request");
  });

  it("每轮带上记忆并回调用到的条目；提议带着这一轮用户的话；较早的轮次发送前压缩", async () => {
    const proposals: Proposal[] = [];
    const turns: string[][] = [];
    const model = new MockLanguageModelV4({
      doGenerate: [
        call("p9", "propose_ops", { summary: "主歌冷色", ops: [{ op: "addEffect", target: "all", from: "b1", to: "b5", effect: "breathe", colors: ["blue"] }] }),
        text("好了"),
      ],
    });
    const agent = createShowAgent({
      loaded: loaded(model),
      snapshot: () => snapshot(),
      onProposal: (p) => proposals.push(p),
      memory: () => ({
        prefs: [{ id: "u1", text: "不要频闪", enabled: true, createdAt: 0 }],
        notes: [],
        exemplars: [{ id: "e1", request: "副歌改成冷色", summary: "副歌冷色", ops: [{ op: "editCues", cues: ["C1"], colors: ["blue"] }], enabled: true, createdAt: 0 }],
        shared: [],
      }),
      outcomeOf: (id) => (id === "old" ? "applied" : undefined),
      onTurn: (info) => turns.push(info.memory.map((m) => m.id)),
    });
    const history = (n: number) => [
      { role: "user" as const, content: `旧的第 ${n} 句` },
      { role: "assistant" as const, content: [{ type: "tool-call" as const, toolCallId: n === 1 ? "old" : `x${n}`, toolName: "propose_ops", input: { summary: `旧改动 ${n}`, ops: [] } }] },
      { role: "tool" as const, content: [{ type: "tool-result" as const, toolCallId: n === 1 ? "old" : `x${n}`, toolName: "propose_ops", output: { type: "json" as const, value: { ok: true } } }] },
      { role: "assistant" as const, content: [{ type: "text" as const, text: `旧回复 ${n}` }] },
    ];
    await agent.generate({ prompt: [...[1, 2, 3, 4, 5].flatMap(history), { role: "user", content: "主歌改成冷色" }] });
    expect(turns).toEqual([["u1", "e1"]]);
    expect(proposals[0].request).toBe("主歌改成冷色");
    const prompt = JSON.stringify(model.doGenerateCalls[0].prompt);
    expect(prompt).toContain("- 不要频闪");
    expect(prompt).toContain('\\"副歌改成冷色\\" → propose_ops(');
    // 第 1、2 轮压缩成一行，最近 4 轮（第 2~5 句 + 这一句）里第 2 轮之后原样
    expect(prompt).toContain("[proposed a change: 旧改动 1 (applied)]");
    expect(prompt).not.toContain('"toolCallId":"old"');
    expect(prompt).toContain('"toolCallId":"x5"');
    // 工具里有 remember
    expect(JSON.stringify(model.doGenerateCalls[0].tools)).toContain("remember");
  });

  it("草稿注入歌曲编排与颜色技能", async () => {
    const plan = { summary: "s", palette: "cool", items: [{ section: "S1", energy: "low", light: "balladBed", colors: null, period: null, move: null }] };
    const model = new MockLanguageModelV4({ doGenerate: [text(JSON.stringify(plan))] });
    const r = await runDraft({ loaded: loaded(model), snapshot: snapshot(), prompt: "冷色", palette: null });
    expect(r.ops.ops.some((o) => o.op === "applyRecipe")).toBe(true);
    const system = JSON.stringify(model.doGenerateCalls[0].prompt[0]);
    expect(system).toContain("### Song structure");
    expect(system).toContain("### Moving heads");
  });
});
