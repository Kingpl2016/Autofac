import type { FixtureModel, FixtureProperty } from "@/features/fixtures";
import { clamp } from "@/shared/lib/math";
import type { EffectColorLayer, EffectDef, EffectLayer, EffectParams } from "./effectDefSchema";
import { buildEffectLook, CUSTOM_EFFECT_GROUP, defaultEffectParams, EFFECT_FILE_VERSION, parseEffects, uniqueEffectId } from "./effectLibrary";
import { periodMs } from "./effects";
import { colorValueRgb } from "./looks";
import {
  createEmptyProject,
  type AttrKey,
  type ColorParam,
  type ColorValue,
  type LookClip,
  type Param,
  type Period,
  type Rgb,
  type ShowProject,
  type Tempo,
  type ValueCurve,
} from "./project";

/**
 * 特效编辑器的数据辅助：新建空白特效、校验、从片段反推特效、预览用的虚拟工程。
 */

/**
 * 一个新的空白特效（强度正弦，按拍）。
 *
 * @param existing 已有特效（取不重复的 `id`）。
 * @param name 显示名（界面语言下的“新特效”）。
 * @returns 特效定义。
 */
export function blankEffect(existing: readonly Pick<EffectDef, "id">[], name: string): EffectDef {
  return {
    id: uniqueEffectId(existing),
    name,
    group: CUSTOM_EFFECT_GROUP,
    scale: "percent",
    period: { kind: "beats", beats: 2 },
    size: 100,
    spread: 1,
    spreadBy: "phase",
    look: { intensity: { shape: "sine", lo: 0, hi: 1 } },
  };
}

/** 校验结果。 */
export type EffectValidation = { ok: true; def: EffectDef } | { ok: false; message: string };

/**
 * 按特效文件的规则校验一个特效（引用、范围、空外观等）。
 *
 * @param def 特效。
 * @returns 通过时为整理后的特效；否则为第一处问题（字段路径 + 原因）。
 */
export function validateEffect(def: EffectDef): EffectValidation {
  const { builtin: _b, ...clean } = def;
  void _b;
  const parsed = parseEffects({ version: EFFECT_FILE_VERSION, effects: [clean] });
  const first = parsed.effects[0];
  if (first) return { ok: true, def: first };
  return { ok: false, message: parsed.issues.find((i) => i.index !== null)?.message ?? "?" };
}

const round4 = (v: number) => Math.round(v * 10_000) / 10_000 + 0;

/** 片段内一个周期的毫秒数（曲线 / 颜色序列）。 */
function cycleMs(c: { period?: Period; cycles: number }, lengthMs: number, tempo: Tempo | null): number {
  return c.period ? periodMs(c.period, tempo) : Math.max(1, lengthMs) / Math.max(1, c.cycles);
}

/** 数值参数 → 特效层（强度按 % 换算成 0~1）。 */
function layerOf(p: Param<number>, scale: number, speed: (c: ValueCurve) => number | undefined): EffectLayer {
  const v = (x: number) => round4(clamp(x / scale, 0, 1));
  if (p.kind === "value") return { value: v(p.value) };
  if (p.kind === "keys") return { value: v(p.keys[0]?.value ?? 0) };
  const c = p.curve;
  const mult = speed(c);
  const layer: EffectLayer = { shape: c.shape, lo: v(c.from), hi: v(c.to) };
  if (mult !== undefined && Math.abs(mult - 1) > 1e-3) layer.cycles = round4(clamp(mult, 0.125, 16));
  if (c.phase) layer.phase = round4(c.phase);
  if (c.duty !== undefined) layer.duty = round4(c.duty);
  if (c.transition !== undefined) layer.transition = round4(c.transition);
  if (c.ease) layer.ease = c.ease;
  if (c.steps?.length) layer.steps = c.steps.map(round4);
  if (c.seed !== undefined) layer.seed = true;
  if (!c.period && c.shape === "ramp") layer.once = true;
  return layer;
}

/** 颜色参数 → 特效颜色层（色温、手动值换成显示色）。 */
function colorLayerOf(p: ColorParam): EffectColorLayer {
  const rgb = (c: ColorValue): Rgb => [...colorValueRgb(c)] as Rgb;
  if (p.kind === "value") return { rgb: rgb(p.value) };
  if (p.kind === "cycle") {
    const layer: EffectColorLayer = { colors: p.cycle.colors.slice(0, 16).map(rgb), blend: p.cycle.blend ?? "smooth" };
    if (p.cycle.transition !== undefined) layer.transition = round4(p.cycle.transition);
    if (p.cycle.ease) layer.ease = p.cycle.ease;
    return layer;
  }
  const colors = p.keys.slice(0, 16).map((k) => rgb(k.value));
  if (colors.length <= 1) return { rgb: colors[0] ?? [255, 255, 255] };
  return { colors, blend: p.keys.every((k) => k.curve === "hold") ? "step" : "smooth" };
}

/**
 * 从外观片段反推一个特效（“从片段创建特效”）：特效片段取它的特效快照（参数作为新的默认值）；
 * 普通外观片段按层换算——曲线成为波形层、颜色序列 / 关键帧成为色表、固定值成为固定层，
 * 第一条按时间计的曲线定出周期，其余层的速度换成倍数；分布的相位 / 色相 / 级联换成分布方式与扩散。
 *
 * 关键帧只取第一帧的值（特效不表达任意关键帧）。
 *
 * @param cue 外观片段。
 * @param ctx 轨道成员数、工程节拍、已有特效（取不重复的 `id`）与显示名。
 * @returns 特效定义（还需在编辑器里检查、保存）。
 */
export function effectFromClip(
  cue: LookClip,
  ctx: { members: number; tempo: Tempo | null; existing: readonly Pick<EffectDef, "id">[]; name: string },
): EffectDef {
  const id = uniqueEffectId(ctx.existing);
  if (cue.fx) {
    const { def, params } = cue.fx;
    return {
      ...structuredClone(def),
      id,
      name: ctx.name,
      group: CUSTOM_EFFECT_GROUP,
      period: params.period,
      size: params.size,
      spread: params.spread,
      ...(def.params ? { params: def.params.map((d) => ({ ...d, default: (params.values?.[d.id] ?? d.default) as never })) } : {}),
    };
  }
  const length = cue.endMs - cue.startMs;
  const curves = [cue.look.intensity, ...Object.values(cue.look.attrs ?? {})].filter((p): p is Extract<Param<number>, { kind: "curve" }> => p?.kind === "curve");
  const colorCycle = cue.look.color?.kind === "cycle" ? cue.look.color.cycle : null;
  const base = curves[0]?.curve ?? colorCycle;
  const baseMs = base ? cycleMs(base, length, ctx.tempo) : 2000;
  const period: Period = base?.period ?? { kind: "ms", ms: clamp(Math.round(baseMs), 20, 600_000) };
  const speed = (c: ValueCurve) => baseMs / cycleMs(c, length, ctx.tempo);
  const look: EffectDef["look"] = {};
  if (cue.look.intensity) look.intensity = layerOf(cue.look.intensity, 100, speed);
  if (cue.look.color) look.color = colorLayerOf(cue.look.color);
  for (const [key, p] of Object.entries(cue.look.attrs ?? {}) as [AttrKey, Param<number>][]) {
    look.attrs = { ...look.attrs, [key]: layerOf(p, 1, speed) };
  }
  if (!look.intensity && !look.color && !look.attrs) look.intensity = { value: 1 };
  const n = Math.max(1, ctx.members);
  const perMember = n > 1 ? n / (n - 1) : 1;
  const values = cue.spread?.values;
  let spreadBy: EffectDef["spreadBy"] = "none";
  let spread = 0;
  if (values?.phase) {
    spreadBy = "phase";
    spread = Math.abs(values.phase.to - values.phase.from) * perMember;
  } else if (values?.hue) {
    spreadBy = "hue";
    spread = (Math.abs(values.hue.to - values.hue.from) / 360) * perMember;
  } else if (cue.spread?.delay) {
    spreadBy = "delay";
    spread = (Math.abs(cue.spread.delay.toMs - cue.spread.delay.fromMs) / baseMs) * perMember;
  }
  return {
    id,
    name: ctx.name,
    group: CUSTOM_EFFECT_GROUP,
    scale: "percent",
    period,
    size: 100,
    spread: round4(clamp(spread, 0, 4)),
    spreadBy,
    look,
  };
}

/** 预览用的虚拟灯数。 */
export const PREVIEW_MEMBERS = 8;

/** 预览用的片段长度（毫秒）：足够长，预览按周期循环播放。 */
export const PREVIEW_LENGTH_MS = 600_000;

/** 预览灯的通道：调光 + RGB + 特效用到的属性。 */
function previewModel(def: EffectDef): FixtureModel {
  const fns = ["dimmer", "red", "green", "blue", ...new Set([...Object.keys(def.look.attrs ?? {}), ...(def.fan ? [def.fan.attr] : []), "pan", "tilt"])];
  const properties: FixtureProperty[] = fns.map((fn, i) => ({
    name: fn,
    code: fn,
    function: fn as FixtureProperty["function"],
    channel: i + 1,
    width: 1,
    bigEndian: false,
    defaultValue: fn === "pan" || fn === "tilt" ? 128 : 0,
    valueDesc: "",
    description: "",
  }));
  return { id: "effect-preview", name: "Preview", system: "", productType: "", builtin: false, properties };
}

/** 预览工程与读取属性值需要的通道布局。 */
export interface EffectPreview {
  project: ShowProject;
  /** 灯具 id（成员顺序） */
  fixtureIds: string[];
  /** 每台灯占用的通道数 */
  stride: number;
  /** 通道功能 → 灯内偏移（0 起） */
  offsets: Map<string, number>;
}

/**
 * 预览用的虚拟工程：一排 {@link PREVIEW_MEMBERS} 台灯编成一组，从 0 开始放一个按参数生成的特效片段。
 *
 * @param def 特效。
 * @param params 参数。
 * @param tempo 节拍（按拍的周期用）；省略时按 120 BPM。
 * @returns 工程与通道布局。
 */
export function effectPreview(def: EffectDef, params: EffectParams = defaultEffectParams(def), tempo: Tempo | null = null): EffectPreview {
  const model = previewModel(def);
  const stride = model.properties.length;
  const p = createEmptyProject("preview");
  p.durationMs = PREVIEW_LENGTH_MS;
  p.output.gamma = 1;
  p.tempo = tempo;
  p.fixtureModels = [model];
  p.fixtures = Array.from({ length: PREVIEW_MEMBERS }, (_, i) => ({
    id: `p${i}`,
    name: `${i + 1}`,
    modelId: model.id,
    universe: 0,
    address: 1 + i * stride,
    stage: { x: i - (PREVIEW_MEMBERS - 1) / 2, y: 2 },
  }));
  p.groups = [{ id: "g", name: "G", fixtureIds: p.fixtures.map((f) => f.id) }];
  p.tracks = [{ id: "t", target: { kind: "group", id: "g" }, mute: false, solo: false, lock: false }];
  const { look, spread } = buildEffectLook(def, params, { members: PREVIEW_MEMBERS, tempo });
  // 没有颜色层的特效（只调强度 / 属性）在预览里用白光
  if (!look.color) look.color = { kind: "value", value: { kind: "rgb", rgb: [255, 255, 255] } };
  if (!look.intensity) look.intensity = { kind: "value", value: 100 };
  p.cues = [
    {
      id: "c",
      trackId: "t",
      kind: "look",
      startMs: 0,
      endMs: PREVIEW_LENGTH_MS,
      brightness: 100,
      fadeInMs: 0,
      fadeOutMs: 0,
      easing: "linear",
      look,
      ...(spread ? { spread } : {}),
    },
  ];
  return { project: p, fixtureIds: p.fixtures.map((f) => f.id), stride, offsets: new Map(model.properties.map((pr, i) => [pr.function, i])) };
}
