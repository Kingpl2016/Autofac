import { produce } from "immer";

import { BUILTIN_TEMPLATES } from "../../../lib/cueTemplates";
import { BUILTIN_EFFECTS } from "../../../lib/effectLibrary";
import { addFixtures } from "../../../lib/ops";
import { createEmptyProject, type LookClip, type Section, type ShowProject } from "../../../lib/project";
import { TIER_COLORS, type EnergyTier } from "../../../lib/sections";
import { DIMMER, HEAD16, RGBW } from "../../../lib/__tests__/testkit";
import { buildAliases } from "../../aliases";
import { planOps } from "../../compile";
import { draftSpans } from "../../draft";
import type { EditorSnapshot } from "../../env";
import { aiOpsSchema } from "../../opsSchema";
import { mapAnalysis } from "../../../lib/mediaAnalysis";
import type { AudioAnalysis } from "../../../lib/mediaApi";
import { testAnalysis } from "../../../lib/__tests__/analysisKit";
import type { Expectation } from "../features";

/**
 * 一致性评测的固定用例：工程 + 描述 + 对结果的宽松期望。
 *
 * 用例只增不改（改了用例，旧的评测结果就不可比了）；需要改时新增一个 id。
 */

/** 一个评测用例。 */
export interface EvalCase {
  id: string;
  /** 用户的描述 */
  prompt: string;
  project: ShowProject;
  /** 对每段特征的期望（只写有把握的） */
  expect: Expectation[];
  /** 主素材的音乐分析（素材从时间线 0 点开始）；有时草稿按分析编排 */
  analysis?: AudioAnalysis;
  /** 草稿加上节奏重音 */
  accents?: boolean;
}

/** 按“名称 + 能量 + 小节数”生成段落。 */
function sections(bpm: number, parts: readonly [string, EnergyTier, number][]): Section[] {
  const bar = (60_000 / bpm) * 4;
  let at = 0;
  return parts.map(([name, tier, bars], i) => {
    const s = { id: `s${i}`, name, startMs: Math.round(at), endMs: Math.round(at + bars * bar), color: [...TIER_COLORS[tier]] as Section["color"] };
    at += bars * bar;
    return s;
  });
}

/** 生成工程。 */
function show(name: string, setup: (d: ShowProject) => void): ShowProject {
  return produce(createEmptyProject(name), (d) => {
    d.output.gamma = 1;
    setup(d);
  });
}

const WARM = ["h0", "h1", "h7"];
const COOL = ["h4", "h5", "h6"];

/** 全部用例。 */
export const EVAL_CASES: readonly EvalCase[] = [
  {
    id: "pop-warm",
    prompt: "流行歌：主歌温柔，副歌爆发，整体暖色调",
    project: show("pop", (d) => {
      addFixtures(d, RGBW, 8);
      addFixtures(d, HEAD16, 4);
      d.tempo = { bpm: 128, offsetMs: 0, beatsPerBar: 4 };
      d.sections = sections(128, [["前奏", "low", 8], ["主歌", "mid", 16], ["副歌", "high", 16], ["主歌 2", "mid", 16], ["副歌 2", "high", 16], ["尾声", "low", 8]]);
      d.durationMs = d.sections.at(-1)!.endMs;
    }),
    expect: [
      { span: 2, field: "level", oneOf: ["high", "mid"] },
      { span: 4, field: "level", oneOf: ["high", "mid"] },
      { span: 2, field: "moves", oneOf: [true] },
      { span: 1, field: "hue", oneOf: [...WARM, "white"] },
      { span: 2, field: "hue", oneOf: [...WARM, "white"] },
    ],
  },
  {
    id: "ballad-cool",
    prompt: "抒情慢歌，冷色，以蓝色为主，不要太花",
    project: show("ballad", (d) => {
      addFixtures(d, RGBW, 6);
      d.tempo = { bpm: 72, offsetMs: 0, beatsPerBar: 4 };
      d.durationMs = 120_000;
    }),
    expect: [0, 1, 2].map((span) => ({ span, field: "hue" as const, oneOf: COOL })),
  },
  {
    id: "edm-neon",
    prompt: "电子舞曲，霓虹配色，drop 段要很炸，build 段逐渐加强",
    project: show("edm", (d) => {
      addFixtures(d, RGBW, 8);
      addFixtures(d, HEAD16, 4);
      d.tempo = { bpm: 128, offsetMs: 0, beatsPerBar: 4 };
      d.sections = sections(128, [["Intro", "low", 8], ["Build", "mid", 8], ["Drop", "high", 16], ["Break", "low", 8], ["Drop 2", "high", 16]]);
      d.durationMs = d.sections.at(-1)!.endMs;
    }),
    expect: [
      { span: 2, field: "level", oneOf: ["high"] },
      { span: 4, field: "level", oneOf: ["high"] },
      { span: 2, field: "moves", oneOf: [true] },
      { span: 2, field: "kind", oneOf: ["intensity", "color"] },
    ],
  },
  {
    id: "dimmer-soft",
    prompt: "白光，柔和地明暗变化",
    project: show("dimmer", (d) => {
      addFixtures(d, DIMMER, 6);
      d.tempo = { bpm: 90, offsetMs: 0, beatsPerBar: 4 };
      d.durationMs = 64_000;
    }),
    expect: [0, 1].map((span) => ({ span, field: "moves" as const, oneOf: [false] })),
  },
  {
    id: "speech-no-tempo",
    prompt: "演讲开场，暖白光，安静",
    project: show("speech", (d) => {
      addFixtures(d, RGBW, 4);
      d.tempo = null;
      d.durationMs = 45_000;
    }),
    expect: [0, 1, 2].map((span) => ({ span, field: "hue" as const, oneOf: ["white", "h1"] })),
  },
  // ---- 带音乐分析：段落与能量来自分析（版本 4 起新增） ----
  {
    id: "music-unsectioned",
    prompt: "按音乐来，暖色",
    project: show("music", (d) => {
      addFixtures(d, RGBW, 8);
      addFixtures(d, HEAD16, 4);
      d.tempo = { bpm: 120, offsetMs: 0, beatsPerBar: 4 };
      d.durationMs = 64_000;
    }),
    analysis: testAnalysis(),
    expect: [
      { span: 0, field: "level", oneOf: ["low", "mid"] },
      { span: 1, field: "level", oneOf: ["high"] },
      { span: 1, field: "hue", oneOf: [...WARM, "white"] },
      { span: 1, field: "moves", oneOf: [true] },
    ],
  },
  {
    id: "music-accents",
    prompt: "电子舞曲，霓虹色，跟着节奏",
    project: show("music-accents", (d) => {
      addFixtures(d, RGBW, 8);
      d.tempo = { bpm: 120, offsetMs: 0, beatsPerBar: 4 };
      d.durationMs = 64_000;
    }),
    analysis: testAnalysis(),
    accents: true,
    expect: [
      { span: 1, field: "level", oneOf: ["high"] },
      { span: 1, field: "kind", oneOf: ["intensity", "color"] },
    ],
  },
  {
    id: "music-sectioned-labels",
    prompt: "抒情，冷色，相同的段落用相同的灯光",
    project: show("music-labels", (d) => {
      addFixtures(d, RGBW, 6);
      d.tempo = { bpm: 120, offsetMs: 0, beatsPerBar: 4 };
      d.sections = sections(120, [["开头", "mid", 8], ["中段", "mid", 16], ["结尾", "mid", 8]]);
      d.durationMs = 64_000;
    }),
    analysis: testAnalysis(),
    expect: [
      { span: 0, field: "hue", oneOf: COOL },
      { span: 2, field: "hue", oneOf: COOL },
      { span: 1, field: "level", oneOf: ["high", "mid"] },
    ],
  },
];

/**
 * 用例的编辑器快照（与编辑器里发起草稿 / 对话时相同的结构）。
 *
 * @param c 用例（编辑用例带选中的片段）。
 * @returns 快照。
 */
export function caseSnapshot(c: { project: ShowProject; selection?: readonly string[]; analysis?: AudioAnalysis }): EditorSnapshot {
  const selection = [...(c.selection ?? [])];
  const analysis = c.analysis ? mapAnalysis({ media: { id: "eval-media", name: "song.wav" }, clip: null, audio: c.analysis }) : null;
  return {
    project: c.project,
    aliases: buildAliases(c.project),
    env: { effects: BUILTIN_EFFECTS, templates: BUILTIN_TEMPLATES, libraryModels: [], lang: "zh", playheadMs: 0, selection, analysis },
    summary: { playheadMs: 0, selection, analysis },
  };
}

// ---- 编辑用例：在已有片段的工程上用对话修改 ----

/** 编辑结果的一项检查。 */
export interface EditCheck {
  name: string;
  ok: (next: ShowProject) => boolean;
}

/** 一个编辑用例。 */
export interface EditCase {
  id: string;
  /** 用户在对话里说的话 */
  prompt: string;
  project: ShowProject;
  /** 选中的片段 id */
  selection: readonly string[];
  /** 对每段特征的期望 */
  expect: Expectation[];
  /** 特征表达不了的检查（速度、特效是否保留…） */
  checks: EditCheck[];
  /** 参考答案（手写的操作）：CI 里验证它满足全部期望与检查，而原工程不满足，保证检查本身有效 */
  reference: unknown[];
}

/** 编辑用例的基础工程：8 台 RGBW + 4 台摇头灯，128 BPM，四个段落各有一个全部灯具的特效片段。 */
const EDIT_BASE: ShowProject = (() => {
  const base = show("edit", (d) => {
    addFixtures(d, RGBW, 8);
    addFixtures(d, HEAD16, 4);
    d.tempo = { bpm: 128, offsetMs: 0, beatsPerBar: 4 };
    d.sections = sections(128, [["前奏", "low", 8], ["主歌", "mid", 16], ["副歌", "high", 16], ["尾声", "low", 8]]);
    d.durationMs = d.sections.at(-1)!.endMs;
  });
  const fx = (from: string, effect: string, colors: string[], period: string | null) => ({ op: "addEffect", target: "all", from, to: `${from}:end`, effect, colors, period });
  const ops = aiOpsSchema.parse({
    summary: "",
    ops: [fx("S1", "breathe", ["warmWhite"], "8"), fx("S2", "intensityWave", ["amber"], "2"), fx("S3", "colorChase", ["red", "orange"], "1"), fx("S4", "fadeOut", ["amber"], null)],
  }).ops;
  return planOps(base, ops, caseSnapshot({ project: base }).env, buildAliases(base)).next;
})();

/** 第 i 个段落里的特效片段。 */
function fxIn(p: ShowProject, i: number): LookClip[] {
  const s = [...p.sections].sort((a, b) => a.startMs - b.startMs)[i];
  return p.cues.filter((c): c is LookClip => c.kind === "look" && !!c.fx && !c.disabled && c.startMs < s.endMs && s.startMs < c.endMs);
}

/** 第 i 个段落里有没有某个特效（或某组特效）。 */
const hasFx = (p: ShowProject, i: number, test: (fx: NonNullable<LookClip["fx"]>) => boolean) => fxIn(p, i).some((c) => c.fx && test(c.fx));

/** 副歌的片段（选中用）。 */
const CHORUS_CLIPS = fxIn(EDIT_BASE, 2).map((c) => c.id);

/** 全部编辑用例。 */
export const EDIT_CASES: readonly EditCase[] = [
  {
    id: "edit-recolor-chorus",
    prompt: "副歌改成蓝紫色",
    project: EDIT_BASE,
    selection: [],
    expect: [{ span: 2, field: "hue", oneOf: COOL }, { span: 2, field: "kind", oneOf: ["color"] }, { span: 1, field: "hue", oneOf: WARM }],
    checks: [{ name: "副歌仍是颜色追逐", ok: (p) => hasFx(p, 2, (fx) => fx.def.id === "colorChase") }],
    reference: [{ op: "editCues", cues: ["C3"], colors: ["blue", "violet"] }],
  },
  {
    id: "edit-speed-selection",
    prompt: "这个快一倍",
    project: EDIT_BASE,
    selection: CHORUS_CLIPS,
    expect: [{ span: 2, field: "hue", oneOf: ["h0"] }, { span: 2, field: "kind", oneOf: ["color"] }],
    checks: [{ name: "副歌周期变成半拍", ok: (p) => hasFx(p, 2, (fx) => fx.params.period.kind === "beats" && fx.params.period.beats === 0.5) }],
    reference: [{ op: "editCues", cues: ["selection"], speed: "x2" }],
  },
  {
    id: "edit-dim-verse",
    prompt: "主歌暗一点",
    project: EDIT_BASE,
    selection: [],
    expect: [{ span: 1, field: "level", oneOf: ["low"] }, { span: 1, field: "kind", oneOf: ["intensity"] }, { span: 2, field: "level", oneOf: ["high"] }],
    checks: [{ name: "主歌仍是强度波浪", ok: (p) => hasFx(p, 1, (fx) => fx.def.id === "intensityWave") }],
    reference: [{ op: "editCues", cues: ["C2"], brightness: 60 }],
  },
  {
    id: "edit-movers-chorus",
    prompt: "副歌让摇头灯大幅摇摆起来",
    project: EDIT_BASE,
    selection: [],
    expect: [{ span: 2, field: "moves", oneOf: [true] }, { span: 1, field: "moves", oneOf: [false] }, { span: 2, field: "kind", oneOf: ["color"] }],
    checks: [{ name: "副歌有位置特效", ok: (p) => hasFx(p, 2, (fx) => fx.def.group === "position") }],
    reference: [{ op: "addEffect", target: "movers", from: "S3", to: "S3:end", effect: "ballyhoo", size: "large" }],
  },
  {
    id: "edit-calm-outro",
    prompt: "尾声换成柔和的冷色呼吸",
    project: EDIT_BASE,
    selection: [],
    expect: [{ span: 3, field: "hue", oneOf: COOL }, { span: 3, field: "kind", oneOf: ["intensity"] }, { span: 2, field: "hue", oneOf: ["h0"] }],
    checks: [{ name: "尾声是呼吸", ok: (p) => hasFx(p, 3, (fx) => fx.def.id === "breathe") }],
    reference: [{ op: "addEffect", target: "all", from: "S4", to: "S4:end", effect: "breathe", colors: ["blue"], fadeIn: "medium" }],
  },
];

/**
 * 编辑结果的检查得分。
 *
 * @param c 用例。
 * @param next 修改后的工程。
 * @returns 0~1。
 */
export function checkScore(c: EditCase, next: ShowProject): number {
  return c.checks.length === 0 ? 1 : c.checks.filter((k) => k.ok(next)).length / c.checks.length;
}

/**
 * 用例的段落（特征按它计算）。
 *
 * @param c 用例。
 * @returns 段落的起止。
 */
export function caseSpans(c: { project: ShowProject; analysis?: AudioAnalysis }): { startMs: number; endMs: number }[] {
  return draftSpans(c.project, buildAliases(c.project), "zh", caseSnapshot(c).env.analysis).map(({ startMs, endMs }) => ({ startMs, endMs }));
}
