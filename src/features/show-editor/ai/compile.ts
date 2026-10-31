import { current, produce } from "immer";

import type { FixtureCapability, FixtureModel } from "@/features/fixtures";
import { clamp } from "@/shared/lib/math";
import { applyAddPlan, planAddFixtures } from "../lib/addPlan";
import { unsafeFlash } from "../lib/attrEffects";
import { moverIds } from "../lib/autoDraft";
import {
  addLookCue,
  MIN_CUE_MS,
  normalizeFades,
  nudgeCues,
  removeCues,
  setCueLabel,
  setCueTimes,
  splitCues,
  updateCues,
  updateLooks,
} from "../lib/cueOps";
import { templateNeeds, trackSupports } from "../lib/cueDefaults";
import { templateName, type CueTemplate } from "../lib/cueTemplates";
import type { EffectDef, EffectParams } from "../lib/effectDefSchema";
import { addEffectDefCue, defaultEffectParams, effectDefNeeds, effectName, setFxParams } from "../lib/effectLibrary";
import { supportsColor, trackCapabilities } from "../lib/fixtureProfile";
import { addMarker, createGroup, ensureDuration, ensureRefTracks, setOutput, setTempo, trackFixtureIds } from "../lib/ops";
import type { ColorParam, ColorValue, Cue, Look, Param, Period, Rgb, ShowProject, Spread } from "../lib/project";
import { projectIntegrityIssues, projectSchema } from "../lib/schema";
import { addSection, TIER_COLORS, updateSection } from "../lib/sections";
import { addTemplateCue } from "../lib/templateOps";
import { deleteRange } from "../lib/timelineEdit";
import { newId } from "../lib/ids";
import type { TimelineAnalysis } from "../lib/mediaAnalysis";
import { repatchSequential } from "../lib/universeOps";
import { resolveAlias, type AliasMap } from "./aliases";
import { SENSITIVE_OPS, type AiOp } from "./opsSchema";
import { expandRecipe } from "./recipes";
import { resolveShift, resolveTime, type TimeContext } from "./timeRef";
import {
  colorRgb,
  fadeOf,
  periodOf,
  quantizeFraction,
  quantizePercent,
  quantizeRgb,
  resolveColor,
  sizeOf,
  speedOf,
  spreadOf,
} from "./vocab";

/**
 * AiOps 编译器：把模型给出的操作列表确定性地写进工程草稿。
 *
 * 每条操作都复用编辑器已有的纯函数（`addEffectDefCue`、`addTemplateCue`、`createGroup`、`deleteRange`…），
 * 所以 AI 的修改与手动编辑走同一条路径、遵守同样的规则（对齐到帧、不重叠、锁定轨道不动）。
 *
 * 语义检查（别名是否存在、灯具能否表现、时间能否放下、频闪是否过快）在执行时完成：
 * 用 {@link planOps} 在副本上试运行，有错误时把说明（英文，给模型看）回传给模型重试。
 */

/** 编译需要的外部数据。 */
export interface CompileEnv {
  /** 可用特效（内置 + 用户）。 */
  effects: readonly EffectDef[];
  /** 可用 Cue 模板（内置 + 用户）。 */
  templates: readonly CueTemplate[];
  /** 灯具素材库的模型（`addFixtures` 用，别名 `L1`… 按这个顺序）。 */
  libraryModels: readonly FixtureModel[];
  /** 界面语言（片段名、新分组名）。 */
  lang: string;
  /** 播放头（`playhead` 时间）。 */
  playheadMs: number;
  /** 用户选中的片段（`selection`）。 */
  selection: readonly string[];
  /** 主素材的音乐 / 画面分析（换算到时间线）；`placeAccents` 按它放置片段。 */
  analysis?: TimelineAnalysis | null;
}

/** 一条操作的问题。 */
export interface OpIssue {
  /** 第几条操作（从 0 起）；整批的问题为 `-1`。 */
  index: number;
  level: "error" | "warning";
  /** 说明（英文，回传给模型；界面上作为详情显示）。 */
  message: string;
}

/** 试运行的结果。 */
export interface OpsPlan {
  /** 应用后的工程（有错误时也给出，仅供诊断）。 */
  next: ShowProject;
  issues: OpIssue[];
  /** 是否有错误（有则不能应用）。 */
  failed: boolean;
  /** 是否含敏感改动（配接、输出、大批量删除），自动写入时也要确认。 */
  sensitive: boolean;
}

/** 一次删除超过这么多片段算敏感操作。 */
export const MAX_SILENT_DELETES = 20;

/** 操作执行失败（说明回传给模型）。 */
class OpError extends Error {}

/** 一批操作的执行状态。 */
interface RunState {
  env: CompileEnv;
  aliases: AliasMap;
  time: TimeContext;
  /** 本批新建的分组：`new_*` → 分组 id。 */
  newGroups: Map<string, string>;
  /** 本批新建的灯具：`new_*` → 灯具 id。 */
  newFixtures: Map<string, string[]>;
  /** `all` / `movers` 对应的轨道（同一批里复用）。 */
  special: Map<string, string>;
  warn: (message: string) => void;
}

const fail = (message: string): never => {
  throw new OpError(message);
};

/** 解析时间，失败时报错。 */
function timeOf(ref: string, st: RunState): number {
  const r = resolveTime(ref, st.time);
  return r.ok ? r.ms : fail(r.error);
}

/** 解析颜色列表，失败时报错。 */
function colorsOf(refs: readonly string[]): ColorValue[] {
  return refs.map((r) => resolveColor(r) ?? fail(`unknown color '${r}'`));
}

/** 分组的轨道；没有时补一条。 */
function groupTrack(d: ShowProject, groupId: string): string {
  const found = d.tracks.find((t) => t.target.kind === "group" && t.target.id === groupId && t.role !== "accent");
  if (found) return found.id;
  const id = newId();
  d.tracks.push({ id, target: { kind: "group", id: groupId }, mute: false, solo: false, lock: false });
  return id;
}

/** 灯具的轨道；没有时补一条。 */
function fixtureTrack(d: ShowProject, ref: string): string {
  ensureRefTracks(d, [ref]);
  return d.tracks.find((t) => t.target.kind === "fixture" && t.target.id === ref && t.role !== "accent")?.id ?? fail(`fixture '${ref}' not found`);
}

/** 一组灯具对应的轨道：一台用灯具轨道，多台找成员相同的分组，没有就新建分组。 */
function setTrack(d: ShowProject, ids: readonly string[], name: string): string {
  if (ids.length === 0) fail("there are no matching fixtures");
  if (ids.length === 1) return fixtureTrack(d, ids[0]);
  const key = [...ids].sort().join(",");
  const same = d.groups.find((g) => [...g.fixtureIds].sort().join(",") === key);
  const gid = same?.id ?? createGroup(d, name, ids) ?? fail("could not create a group");
  return groupTrack(d, gid);
}

/** 解析片段的目标轨道。 */
function targetTrack(d: ShowProject, ref: string, st: RunState): string {
  const r = ref.trim();
  const zh = st.env.lang.startsWith("zh");
  if (r === "all" || r === "movers") {
    const cached = st.special.get(r);
    if (cached && d.tracks.some((t) => t.id === cached)) return cached;
    const ids = r === "all" ? d.fixtures.map((f) => f.id) : moverIds(d);
    if (r === "movers" && ids.length === 0) fail("there are no moving heads (fixtures with pan) in this show");
    const name = r === "all" ? (zh ? "全部灯具" : "All fixtures") : zh ? "摇头灯" : "Movers";
    const id = setTrack(d, ids, name);
    st.special.set(r, id);
    return id;
  }
  if (r.startsWith("new_")) {
    const gid = st.newGroups.get(r) ?? fail(`'${r}' was not created earlier in this batch`);
    return groupTrack(d, gid);
  }
  const prefix = r[0]?.toUpperCase();
  if (prefix === "G") {
    const gid = resolveAlias(st.aliases, r, "G");
    if (!gid || !d.groups.some((g) => g.id === gid)) fail(`no group '${r}'`);
    return groupTrack(d, gid as string);
  }
  if (prefix === "F") {
    const fid = resolveAlias(st.aliases, r, "F");
    if (!fid || !d.fixtures.some((f) => f.id === fid)) fail(`no fixture '${r}'`);
    return fixtureTrack(d, fid as string);
  }
  if (prefix === "T") {
    const tid = resolveAlias(st.aliases, r, "T");
    const track = tid ? d.tracks.find((t) => t.id === tid) : undefined;
    if (!track) fail(`no track '${r}'`);
    if (track?.target.kind === "scene") fail(`track '${r}' is a scene track; put clips on fixture/group tracks`);
    return tid as string;
  }
  return fail(`'${r}' is not a valid target (use all, movers, G1, F1, T1 or new_<name>)`);
}

/** 解析灯具列表（`F1`… 或本批新建的 `new_*`）。 */
function fixtureRefs(d: ShowProject, refs: readonly string[], st: RunState): string[] {
  const out: string[] = [];
  for (const r of refs) {
    const fresh = st.newFixtures.get(r.trim());
    if (fresh) {
      out.push(...fresh);
      continue;
    }
    const id = resolveAlias(st.aliases, r, "F");
    if (!id || !d.fixtures.some((f) => f.id === id)) fail(`no fixture '${r}'`);
    out.push(id as string);
  }
  return [...new Set(out)];
}

/** 解析片段列表（`C1`… 或 `selection`），并确认它们都还在、所在轨道没锁。 */
function cueRefs(d: ShowProject, refs: readonly string[], st: RunState): string[] {
  const ids: string[] = [];
  for (const r of refs) {
    if (r.trim().toLowerCase() === "selection") {
      if (st.env.selection.length === 0) fail("the user has not selected any clips");
      ids.push(...st.env.selection);
      continue;
    }
    ids.push(resolveAlias(st.aliases, r, "C") ?? fail(`no clip '${r}'`));
  }
  const unique = [...new Set(ids)];
  for (const id of unique) {
    const cue = d.cues.find((c) => c.id === id) ?? fail(`clip '${st.aliases.toAlias.get(id) ?? id}' no longer exists`);
    if (d.tracks.find((t) => t.id === cue.trackId)?.lock) fail(`clip '${st.aliases.toAlias.get(id)}' is on a locked track`);
  }
  return unique;
}

/** 准备放片段的时间范围：解析起止、延长节目、按需清空范围。 */
function prepareRange(
  d: ShowProject,
  op: { from: string; to: string; replace: boolean | null },
  trackId: string,
  st: RunState,
): { start: number; end: number } {
  const start = timeOf(op.from, st);
  const end = timeOf(op.to, st);
  if (end - start < MIN_CUE_MS) fail(`'to' (${op.to}) must be after 'from' (${op.from})`);
  if (d.tracks.find((t) => t.id === trackId)?.lock) fail("the target track is locked");
  ensureDuration(d, end);
  if (op.replace ?? true) {
    deleteRange(d, { startMs: start, endMs: end }, { trackIds: [trackId], objects: false }, false);
  } else if (d.cues.some((c) => c.trackId === trackId && c.startMs < end && start < c.endMs)) {
    fail("the range overlaps existing clips on that track; set replace to true or choose another range");
  }
  return { start, end };
}

/** 新片段的收尾：精确设置终点、亮度、淡入淡出与名称。 */
function finishCue(
  d: ShowProject,
  id: string | null,
  end: number,
  op: { brightness: number | null; fadeIn: AiOpFade; fadeOut: AiOpFade; label: string | null },
): Cue {
  const cue = (id ? d.cues.find((c) => c.id === id) : undefined) ?? fail("the clip could not be placed there");
  // 范围已经清空，终点可以直接对齐到期望值（模板 / 特效自己的默认长度不算数）
  cue.endMs = Math.max(cue.startMs + MIN_CUE_MS, Math.round(end));
  if (op.brightness !== null) cue.brightness = quantizePercent(op.brightness);
  if (op.fadeIn !== null) cue.fadeInMs = fadeOf(op.fadeIn, d.tempo);
  if (op.fadeOut !== null) cue.fadeOutMs = fadeOf(op.fadeOut, d.tempo);
  normalizeFades(cue);
  if (op.label) setCueLabel(d, cue.id, op.label);
  return cue;
}

type AiOpFade = Extract<AiOp, { op: "addEffect" }>["fadeIn"];

/** 片段是否闪得太快（超过安全频率）。 */
function checkFlash(d: ShowProject, cue: Cue): void {
  if (cue.kind === "look" && unsafeFlash(cue.look, cue.endMs - cue.startMs, d.tempo)) {
    fail("this would flash faster than 10 Hz (photosensitivity limit); choose a longer period");
  }
}

/** 轨道是否支持某种能力，不支持时报错。 */
function requireCapability(d: ShowProject, trackId: string, needs: FixtureCapability, what: string): void {
  if (!trackSupports(d, trackId, needs)) fail(`no fixture on that target can do ${what} (needs '${needs}')`);
}

/** 给特效套上颜色：有颜色参数时填参数；没有颜色层时加一个固定颜色层（存在特效快照里，改参数后仍保留）。 */
function colorize(def: EffectDef, params: EffectParams, rgbs: readonly Rgb[], st: RunState): { def: EffectDef; params: EffectParams } {
  if (rgbs.length === 0) return { def, params };
  const list = def.params?.find((p) => p.type === "colors");
  const single = def.params?.find((p) => p.type === "color");
  if (list && list.type === "colors") {
    const min = list.min ?? 1;
    const max = list.max ?? 16;
    const filled = Array.from({ length: clamp(rgbs.length, min, max) }, (_, i) => [...rgbs[i % rgbs.length]] as Rgb);
    return { def, params: { ...params, values: { ...params.values, [list.id]: filled } } };
  }
  if (single) return { def, params: { ...params, values: { ...params.values, [single.id]: [...rgbs[0]] as Rgb } } };
  if (!def.look.color) return { def: { ...def, look: { ...def.look, color: { rgb: [...rgbs[0]] as Rgb } } }, params };
  st.warn(`effect '${def.id}' has fixed colors; the given colors were ignored`);
  return { def, params };
}

/** 周期按倍率加速（2 = 快一倍），夹在工程允许的范围。 */
function fasterPeriod(p: Period, mult: number): Period {
  return p.kind === "beats"
    ? { kind: "beats", beats: clamp(p.beats / mult, 0.0625, 128) }
    : { kind: "ms", ms: clamp(Math.round(p.ms / mult), 20, 600_000) };
}

/** 数值 / 颜色参数里的曲线按倍率加速。 */
function fasterParam(p: Param<number> | ColorParam | undefined, mult: number): void {
  const timing = p?.kind === "curve" ? p.curve : p?.kind === "cycle" ? p.cycle : undefined;
  if (!timing) return;
  if (timing.period) timing.period = fasterPeriod(timing.period, mult);
  else timing.cycles = clamp(Math.round(timing.cycles * mult), 1, 1000);
}

/** 片段在 `[0, 1]` 位置上的时间（关键帧用）。 */
const keyTime = (at: number, length: number) => Math.round(clamp(at, 0, 1) * length);

/** `addLook` 的外观与分布。 */
function buildLook(op: Extract<AiOp, { op: "addLook" }>, lengthMs: number, members: number): { look: Look; spread?: Spread } {
  const look: Look = {};
  const spread: Spread = {};
  const intensityKinds = [op.intensity !== null, op.intensityWave !== null, op.intensityKeys !== null].filter(Boolean).length;
  if (intensityKinds > 1) fail("give only one of intensity, intensityWave, intensityKeys");
  if (op.intensityWave) {
    const w = op.intensityWave;
    look.intensity = {
      kind: "curve",
      curve: { shape: w.shape, from: quantizePercent(w.low), to: quantizePercent(w.high), cycles: 1, phase: 0, period: periodOf(w.period) },
    };
  } else if (op.intensityKeys) {
    const keys = [...op.intensityKeys].sort((a, b) => a.at - b.at);
    look.intensity = { kind: "keys", keys: keys.map((k) => ({ tMs: keyTime(k.at, lengthMs), value: quantizePercent(k.value), curve: "linear" })) };
  } else {
    // 没给强度时默认全亮：范围已经清空，没有强度层的片段会是黑的
    look.intensity = { kind: "value", value: op.intensity === null ? 100 : quantizePercent(op.intensity) };
  }

  const colorKinds = [op.color, op.colorCycle, op.colorSpread, op.colorKeys].filter((x) => x !== null).length;
  if (colorKinds > 1) fail("give only one of color, colorCycle, colorSpread, colorKeys");
  if (op.color) look.color = { kind: "value", value: colorsOf([op.color])[0] };
  if (op.colorCycle) {
    look.color = {
      kind: "cycle",
      cycle: { colors: colorsOf(op.colorCycle.colors), blend: op.colorCycle.blend, cycles: 1, phase: 0, period: periodOf(op.colorCycle.period) },
    };
  }
  if (op.colorKeys) {
    const keys = [...op.colorKeys].sort((a, b) => a.at - b.at);
    look.color = { kind: "keys", keys: keys.map((k) => ({ tMs: keyTime(k.at, lengthMs), value: colorsOf([k.color])[0], curve: "linear" })) };
  }
  if (op.colorSpread) {
    const list = colorsOf(op.colorSpread);
    look.color = { kind: "value", value: list[0] };
    if (list.length > 1) spread.colors = { colors: list, blend: "step" };
  }

  const attrs: NonNullable<Look["attrs"]> = {};
  if (op.pan !== null) attrs.pan = { kind: "value", value: quantizeFraction(op.pan) };
  if (op.tilt !== null) attrs.tilt = { kind: "value", value: quantizeFraction(op.tilt) };
  for (const a of op.attrs ?? []) attrs[a.attr] = { kind: "value", value: quantizeFraction(a.value) };
  if (Object.keys(attrs).length > 0) look.attrs = attrs;

  if (op.spread && op.spread !== "none" && members >= 2) {
    spread.values = { phase: { from: 0, to: -Math.round(((spreadOf(op.spread) * (members - 1)) / members) * 10_000) / 10_000 } };
  }
  return Object.keys(spread).length > 0 ? { look, spread } : { look };
}

/** 执行一条操作。 */
function runOp(d: ShowProject, op: AiOp, st: RunState): void {
  const { env } = st;
  switch (op.op) {
    case "addEffect": {
      const def = env.effects.find((e) => e.id === op.effect) ?? fail(`unknown effect '${op.effect}' (see the effect list)`);
      const trackId = targetTrack(d, op.target, st);
      requireCapability(d, trackId, effectDefNeeds(def), `the effect '${def.id}'`);
      const { start, end } = prepareRange(d, op, trackId, st);
      let params = defaultEffectParams(def);
      if (op.period) params = { ...params, period: periodOf(op.period) };
      if (op.size) params = { ...params, size: sizeOf(op.size, def.scale) };
      if (op.spread) params = { ...params, spread: spreadOf(op.spread) };
      if (op.reverse) params = { ...params, direction: -1 };
      if (op.mirror) params = { ...params, wings: 2 };
      const colored = colorize(def, params, op.colors ? colorsOf(op.colors).map(colorRgb) : [], st);
      const id = addEffectDefCue(d, trackId, start, colored.def, colored.params, op.label ?? effectName(def, env.lang), end - start);
      const cue = finishCue(d, id, end, { ...op, label: null });
      checkFlash(d, cue);
      return;
    }
    case "addLook": {
      const trackId = targetTrack(d, op.target, st);
      const track = d.tracks.find((t) => t.id === trackId);
      const caps = track ? trackCapabilities(d, track) : null;
      const wantsColor = op.color !== null || op.colorCycle !== null || op.colorSpread !== null || op.colorKeys !== null;
      if (wantsColor && caps && !supportsColor(caps)) fail("no fixture on that target can change color");
      if ((op.pan !== null || op.tilt !== null) && caps && !caps.any.has("position")) fail("no fixture on that target has pan/tilt");
      const { start, end } = prepareRange(d, op, trackId, st);
      const members = track ? trackFixtureIds(d, track).length : 1;
      const { look, spread } = buildLook(op, end - start, members);
      const id = addLookCue(d, trackId, start, look, end - start, spread);
      const cue = finishCue(d, id, end, op);
      checkFlash(d, cue);
      return;
    }
    case "applyTemplate": {
      const template = env.templates.find((t) => t.id === op.template) ?? fail(`unknown template '${op.template}' (see the template list)`);
      const trackId = targetTrack(d, op.target, st);
      requireCapability(d, trackId, templateNeeds(template), `the template '${template.id}'`);
      const { start, end } = prepareRange(d, op, trackId, st);
      const id = addTemplateCue(d, trackId, start, template, op.label ?? templateName(template, env.lang));
      const cue = finishCue(d, id, end, { ...op, label: null });
      checkFlash(d, cue);
      return;
    }
    case "applyRecipe": {
      const trackId = targetTrack(d, op.target, st);
      const track = d.tracks.find((t) => t.id === trackId);
      const caps = track ? trackCapabilities(d, track) : null;
      const ref = op.target.trim();
      const hasMovers = moverIds(d).length > 0;
      if (op.movers === true && !hasMovers) st.warn("there are no moving heads; the recipe's movement was skipped");
      const withMovers = (op.movers ?? ref === "all") && ref !== "movers" && hasMovers;
      for (const layer of expandRecipe(op, { canColor: caps ? supportsColor(caps) : true, withMovers })) {
        try {
          runOp(d, layer, st);
        } catch (e) {
          if (e instanceof OpError) fail(`recipe '${op.recipe}': ${e.message}`);
          throw e;
        }
      }
      return;
    }
    case "placeAccents":
      placeAccents(d, op, st);
      return;
    case "editCues": {
      const ids = cueRefs(d, op.cues, st);
      if (op.brightness !== null) updateCues(d, ids, { brightness: quantizePercent(op.brightness) });
      for (const id of ids) {
        const cue = d.cues.find((c) => c.id === id);
        if (!cue) continue;
        if (op.fadeIn !== null) updateCues(d, [id], { fadeInMs: fadeOf(op.fadeIn, d.tempo) });
        if (op.fadeOut !== null) updateCues(d, [id], { fadeOutMs: fadeOf(op.fadeOut, d.tempo) });
        if (op.label !== null) setCueLabel(d, id, op.label);
        if (op.tag !== null) cue.tag = op.tag;
        if (op.disabled !== null) {
          if (op.disabled) cue.disabled = true;
          else delete cue.disabled;
        }
        if (op.colors) recolor(d, cue, colorsOf(op.colors), st);
        if (op.speed) speedUp(d, cue, speedOf(op.speed));
        if (op.size) {
          if (cue.kind === "look" && cue.fx) setFxParams(d, [id], { size: sizeOf(op.size, cue.fx.def.scale) });
          else st.warn(`clip '${st.aliases.toAlias.get(id)}' is not an effect clip; size ignored`);
        }
        const after = d.cues.find((c) => c.id === id);
        if (after) checkFlash(d, after);
      }
      return;
    }
    case "moveCues": {
      const ids = cueRefs(d, op.cues, st);
      const shift = resolveShift(op.by, d);
      if (!shift.ok) fail(shift.error);
      const delta = shift.ok ? shift.ms : 0;
      const lastEnd = Math.max(...d.cues.filter((c) => ids.includes(c.id)).map((c) => c.endMs));
      ensureDuration(d, lastEnd + delta);
      if (!nudgeCues(d, ids, delta)) fail("cannot move: the clips would overlap other clips or leave the show");
      return;
    }
    case "resizeCues": {
      const ids = cueRefs(d, op.cues, st);
      if (op.from === null && op.to === null) fail("give from and/or to");
      for (const id of ids) {
        const cue = d.cues.find((c) => c.id === id);
        if (!cue) continue;
        const start = op.from === null ? cue.startMs : timeOf(op.from, st);
        const end = op.to === null ? cue.endMs : timeOf(op.to, st);
        ensureDuration(d, end);
        if (!setCueTimes(d, id, start, end)) fail(`cannot resize clip '${st.aliases.toAlias.get(id)}': it would overlap another clip or be too short`);
      }
      return;
    }
    case "deleteCues":
      removeCues(d, cueRefs(d, op.cues, st));
      return;
    case "clearRange": {
      const trackId = targetTrack(d, op.target, st);
      const start = timeOf(op.from, st);
      const end = timeOf(op.to, st);
      if (end <= start) fail("'to' must be after 'from'");
      deleteRange(d, { startMs: start, endMs: end }, { trackIds: [trackId], objects: false }, false);
      return;
    }
    case "splitCues": {
      const ids = cueRefs(d, op.cues, st);
      if (splitCues(d, ids, timeOf(op.at, st)).length === 0) st.warn("no clip was split (the time is outside the clips or too close to an edge)");
      return;
    }
    case "addSection": {
      const start = timeOf(op.from, st);
      const end = timeOf(op.to, st);
      ensureDuration(d, end);
      const id = addSection(d, start, end - start, op.name) ?? fail("the section overlaps an existing section or is shorter than 0.5 s");
      if (op.energy) updateSection(d, id, { color: [...TIER_COLORS[op.energy]] as Rgb });
      return;
    }
    case "addMarker":
      if (addMarker(d, timeOf(op.at, st), op.label) === null) st.warn("a marker already exists at that time");
      return;
    case "setTempo":
      setTempo(d, {
        bpm: op.bpm,
        beatsPerBar: op.beatsPerBar ?? d.tempo?.beatsPerBar ?? 4,
        offsetMs: op.offset === null ? (d.tempo?.offsetMs ?? 0) : Math.round(Number(op.offset.slice(0, -1)) * 1000),
      });
      return;
    case "createGroup": {
      if (st.newGroups.has(op.as) || st.newFixtures.has(op.as)) fail(`'${op.as}' is already used in this batch`);
      const gid = createGroup(d, op.name, fixtureRefs(d, op.members, st)) ?? fail("a group needs at least 2 existing fixtures");
      st.newGroups.set(op.as, gid);
      return;
    }
    case "addFixtures": {
      const n = /^L(\d+)$/i.exec(op.model.trim());
      const model = (n ? env.libraryModels[Number(n[1]) - 1] : undefined) ?? fail(`no fixture model '${op.model}' (see list_fixture_models)`);
      if (op.as && (st.newGroups.has(op.as) || st.newFixtures.has(op.as))) fail(`'${op.as}' is already used in this batch`);
      const plan = planAddFixtures(d, model, {
        count: op.count,
        ...(op.name ? { nameTemplate: op.name } : {}),
        start: op.universe === null ? "auto" : { universe: op.universe, address: op.address ?? 1 },
      });
      const ids = applyAddPlan(d, model, plan);
      if (ids.length === 0) fail("there is no free DMX address for these fixtures");
      if (ids.length < op.count) st.warn(`only ${ids.length} of ${op.count} fixtures fit (out of universes)`);
      if (plan.shifted) st.warn("the requested address was taken; the fixtures were placed at the next free address");
      if (op.as) {
        st.newFixtures.set(op.as, ids);
        if (ids.length >= 2) {
          const gid = createGroup(d, op.name?.replace("{n}", "").trim() || model.name, ids);
          if (gid) st.newGroups.set(op.as, gid);
        }
      }
      return;
    }
    case "patchFixtures": {
      const ids = fixtureRefs(d, op.fixtures, st);
      const moved = repatchSequential(d, ids, { universe: op.universe, address: op.address }, op.gap ?? 0);
      if (moved < ids.length) st.warn(`${ids.length - moved} fixture(s) kept their address (already there, or out of universes)`);
      return;
    }
    case "setOutput": {
      const protocol = op.protocol ?? "artNet";
      const port = protocol === "sacn" ? 5568 : 6454;
      if (op.mode === "unicast") {
        const ip = op.ip?.trim() ?? "";
        const ok = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(ip) && ip.split(".").every((p) => Number(p) <= 255);
        if (!ok) fail("unicast needs a valid IPv4 address in 'ip'");
        setOutput(d, { target: { kind: "direct", ip, protocol, port } });
      } else if (op.mode === "broadcast") {
        setOutput(d, { target: { kind: "direct", ip: "255.255.255.255", protocol, port } });
      } else {
        if (op.mode === "routed" && d.output.universes.length === 0) st.warn("the universe routing table is empty; nothing will be sent until routes are added");
        setOutput(d, { target: { kind: op.mode } });
      }
      return;
    }
  }
}

/** 一次 `placeAccents` 最多放多少个片段。 */
export const MAX_ACCENTS = 128;

/** 重音之间至少相隔多少毫秒（没有节拍时；有节拍时为一拍）。 */
const MIN_ACCENT_GAP_MS = 250;

/** 各类重音的默认特效。 */
const ACCENT_EFFECTS = { hits: "hit", drops: "hit", builds: "fadeIn" } as const;

/** 重音的亮度档位。 */
const ACCENT_BRIGHTNESS = { subtle: 50, normal: 80, strong: 100 } as const;

/**
 * 主轨道的重音层：同一目标、`role: "accent"` 的轨道，紧挨在主轨道下面；没有时新建。
 *
 * @param d 工程草稿。
 * @param mainId 主轨道 id。
 * @returns 重音层轨道 id。
 */
function accentTrack(d: ShowProject, mainId: string): string {
  const main = d.tracks.find((t) => t.id === mainId) ?? fail("the target track is missing");
  if (main.target.kind === "scene") fail("accents need a fixture or group target, not a scene track");
  const target = main.target;
  const found = d.tracks.find((t) => t.role === "accent" && t.target.kind === target.kind && t.target.kind !== "scene" && t.target.id === (target as { id: string }).id);
  if (found) {
    if (found.lock) fail("the accent track is locked");
    return found.id;
  }
  const id = newId();
  d.tracks.splice(d.tracks.indexOf(main) + 1, 0, { id, target: { ...target }, mute: false, solo: false, lock: false, role: "accent" });
  return id;
}

/** 按分析事件放重音片段（见 `opsSchema.ts` 的 `placeAccents`）。 */
function placeAccents(d: ShowProject, op: Extract<AiOp, { op: "placeAccents" }>, st: RunState): void {
  const analysis = st.env.analysis ?? fail("there is no music analysis for this show (add a song to the timeline first); use addEffect instead");
  const start = timeOf(op.from, st);
  const end = timeOf(op.to, st);
  if (end - start < MIN_CUE_MS) fail(`'to' (${op.to}) must be after 'from' (${op.from})`);
  const mainId = targetTrack(d, op.target, st);
  const trackId = accentTrack(d, mainId);
  const beatMs = d.tempo && d.tempo.bpm > 0 ? 60_000 / d.tempo.bpm : null;
  const barMs = beatMs && d.tempo ? beatMs * d.tempo.beatsPerBar : 2000;
  const gap = beatMs ?? MIN_ACCENT_GAP_MS;
  const brightness = ACCENT_BRIGHTNESS[op.strength ?? "strong"];

  // 事件 → 片段的 [起点, 终点)
  let spans: { start: number; end: number; shot?: number }[];
  if (op.events === "cuts") {
    const cuts = analysis.events.filter((e) => e.kind === "cut" && e.atMs >= start && e.atMs < end).map((e) => e.atMs);
    if (cuts.length === 0) fail("there are no video cuts in that range (the analysis found none, or the show has no analysed video)");
    // 每个切镜到下一个切镜（或范围终点）换一次色
    spans = cuts.map((at, i) => ({ start: at, end: cuts[i + 1] ?? end }));
  } else {
    const kind = { hits: "hit", drops: "drop", builds: "build" }[op.events];
    let list = analysis.events.filter((e) => e.kind === kind && e.atMs >= start && e.atMs < end);
    if (op.events === "hits" && op.every) list = list.filter((_, i) => i % Number(op.every) === 0);
    if (list.length === 0) fail(`there are no ${op.events} in that range (see the Events in the music analysis)`);
    spans = list.map((e, i) => {
      const next = list[i + 1]?.atMs ?? end;
      const length = op.events === "builds" ? (e.endMs ?? e.atMs + barMs) - e.atMs : barMs;
      return { start: e.atMs, end: Math.min(end, next, e.atMs + length) };
    });
  }
  // 密度：相隔太近的丢掉；数量上限
  const kept: typeof spans = [];
  for (const s of spans) {
    const prev = kept.at(-1);
    if (prev && s.start - prev.start < gap) continue;
    kept.push(s);
  }
  if (kept.length > MAX_ACCENTS) {
    st.warn(`only the first ${MAX_ACCENTS} of ${kept.length} accents were placed`);
    kept.length = MAX_ACCENTS;
  }

  // 重音层上这段范围原有的片段先清掉（同一批重复放置时结果不叠加）
  deleteRange(d, { startMs: start, endMs: end }, { trackIds: [trackId], objects: false }, false);
  ensureDuration(d, end);

  if (op.events === "cuts") {
    const given = op.colors ? colorsOf(op.colors) : null;
    if (!given && !op.fromVideo) fail("give colors, or set fromVideo to take the colors from the video");
    if (op.fromVideo && analysis.shots.length === 0) fail("the video has no analysed shots; give colors instead");
    kept.forEach((s, i) => {
      const color: ColorValue = op.fromVideo ? shotColor(analysis, s.start) : given![i % given!.length];
      const id = addLookCue(d, trackId, s.start, { color: { kind: "value", value: color } }, Math.max(MIN_CUE_MS, s.end - s.start));
      finishCue(d, id, Math.max(s.start + MIN_CUE_MS, s.end), { brightness: null, fadeIn: null, fadeOut: null, label: null });
    });
    return;
  }
  const effectId = op.effect ?? ACCENT_EFFECTS[op.events];
  const def = st.env.effects.find((e) => e.id === effectId) ?? fail(`unknown effect '${effectId}' (see the effect list)`);
  requireCapability(d, trackId, effectDefNeeds(def), `the effect '${def.id}'`);
  for (const s of kept) {
    if (s.end - s.start < MIN_CUE_MS) continue;
    let params = defaultEffectParams(def);
    // 冲击：一个周期等于片段长度（每个片段只冲一次）
    if (op.events !== "builds" && beatMs) params = { ...params, period: { kind: "ms", ms: Math.round(s.end - s.start) } };
    const colored = colorize(def, params, op.colors ? colorsOf(op.colors).map(colorRgb) : [], st);
    const id = addEffectDefCue(d, trackId, s.start, colored.def, colored.params, effectName(def, st.env.lang), s.end - s.start);
    const cue = finishCue(d, id, s.end, { brightness, fadeIn: null, fadeOut: null, label: null });
    checkFlash(d, cue);
  }
}

/** 时刻所在镜头的主色（量化后）。 */
function shotColor(analysis: TimelineAnalysis, atMs: number): ColorValue {
  const shot = analysis.shots.find((s) => atMs >= s.startMs && atMs < s.endMs) ?? analysis.shots.find((s) => s.startMs >= atMs) ?? analysis.shots.at(-1);
  return { kind: "rgb", rgb: quantizeRgb(shot ? shot.rgb : [255, 255, 255]) };
}

/** 给已有片段换颜色：特效片段改特效颜色（保留特效），其它片段改颜色层。 */
function recolor(d: ShowProject, cue: Cue, colors: ColorValue[], st: RunState): void {
  const rgbs = colors.map(colorRgb);
  if (cue.kind === "look" && cue.fx) {
    const { def, params } = colorize(cue.fx.def, cue.fx.params, rgbs, st);
    cue.fx = { def, params };
    setFxParams(d, [cue.id], {});
    return;
  }
  if (cue.kind === "look") {
    const n = trackFixtureIds(d, d.tracks.find((t) => t.id === cue.trackId) ?? { id: "", target: { kind: "scene" }, mute: false, solo: false, lock: false }).length;
    updateLooks(d, [cue.id], (look, c) => {
      look.color = { kind: "value", value: colors[0] };
      if (colors.length > 1 && n > 1) c.spread = { ...c.spread, colors: { colors, blend: "step" } };
      else if (c.spread?.colors) delete c.spread.colors;
    });
    return;
  }
  if (cue.kind === "static") {
    updateCues(d, [cue.id], { rgb: rgbs[0] });
    return;
  }
  if (cue.kind === "effect") {
    cue.colors = rgbs.slice(0, 4);
    return;
  }
  st.warn(`clip '${st.aliases.toAlias.get(cue.id)}' is a scene clip; recolor it per fixture instead`);
}

/** 已有片段加速 / 减速。 */
function speedUp(d: ShowProject, cue: Cue, mult: number): void {
  if (cue.kind === "look" && cue.fx) {
    setFxParams(d, [cue.id], { period: fasterPeriod(cue.fx.params.period, mult) });
    return;
  }
  if (cue.kind === "look") {
    updateLooks(d, [cue.id], (look) => {
      fasterParam(look.intensity, mult);
      fasterParam(look.color, mult);
      for (const p of Object.values(look.attrs ?? {})) fasterParam(p, mult);
    });
    return;
  }
  if (cue.kind === "effect") {
    cue.period = fasterPeriod(cue.period, mult);
  }
}

/**
 * 在草稿上执行一批操作。遇到错误的操作跳过（不影响其它操作），错误与警告记进问题列表。
 *
 * @param d 工程草稿。
 * @param ops 操作（已通过结构校验）。
 * @param env 外部数据。
 * @param aliases 基于操作所针对的那份工程生成的别名表。
 * @returns 问题列表。
 */
export function applyOps(
  d: ShowProject,
  ops: readonly AiOp[],
  env: CompileEnv,
  aliases: AliasMap,
  after?: (index: number, draft: ShowProject) => void,
): OpIssue[] {
  const issues: OpIssue[] = [];
  let index = 0;
  const st: RunState = {
    env,
    aliases,
    time: { project: d, aliases, playheadMs: env.playheadMs },
    newGroups: new Map(),
    newFixtures: new Map(),
    special: new Map(),
    warn: (message) => issues.push({ index, level: "warning", message }),
  };
  for (const op of ops) {
    try {
      runOp(d, op, st);
    } catch (e) {
      if (!(e instanceof OpError)) throw e;
      issues.push({ index, level: "error", message: e.message });
    }
    after?.(index, d);
    index += 1;
  }
  return issues;
}

/** 一条操作对片段的影响（改动虚影与逐条拒绝用）。 */
export interface OpEffect {
  /** 新增的片段 */
  added: string[];
  /** 修改的片段（时间、外观、亮度…任一字段变了） */
  changed: string[];
  /** 删除的片段 */
  removed: string[];
  /** 依赖的更早的操作（下标）：用了它新建的分组 / 灯具，或改了它新增 / 改过的片段 */
  deps: number[];
}

/** 操作里引用的 `new_*` 名字。 */
function newRefs(op: AiOp): string[] {
  return [...JSON.stringify(op).matchAll(/"(new_[a-z0-9_]{1,24})"/g)].map((m) => m[1]);
}

/** 操作新建的 `new_*` 名字（`createGroup` / `addFixtures` 的 `as`）。 */
function newDefs(op: AiOp): string | null {
  return (op.op === "createGroup" || op.op === "addFixtures") && op.as ? op.as : null;
}

/**
 * 逐条记录每条操作对片段的影响与操作之间的依赖（在 `applyOps` 的每条操作之后调用）。
 *
 * @param project 运行前的工程。
 * @param ops 操作。
 * @returns 回调与结果（与 `ops` 一一对应）。
 */
function effectTracker(project: ShowProject, ops: readonly AiOp[]): { after: (i: number, draft: ShowProject) => void; effects: OpEffect[] } {
  const effects: OpEffect[] = [];
  // 每个片段最后是被哪条操作新增 / 修改的
  const touchedBy = new Map<string, number>();
  const definedBy = new Map<string, number>();
  let prev = new Map(project.cues.map((c) => [c.id, JSON.stringify(c)]));
  return {
    effects,
    after: (i, draft) => {
      const now = new Map(current(draft).cues.map((c) => [c.id, JSON.stringify(c)]));
      const added: string[] = [];
      const changed: string[] = [];
      const removed: string[] = [];
      for (const [id, text] of now) {
        const before = prev.get(id);
        if (before === undefined) added.push(id);
        else if (before !== text) changed.push(id);
      }
      for (const id of prev.keys()) if (!now.has(id)) removed.push(id);
      const deps = new Set<number>();
      for (const id of [...changed, ...removed]) {
        const by = touchedBy.get(id);
        if (by !== undefined) deps.add(by);
      }
      for (const name of newRefs(ops[i])) {
        const by = definedBy.get(name);
        if (by !== undefined && by !== i) deps.add(by);
      }
      for (const id of [...added, ...changed]) touchedBy.set(id, i);
      const def = newDefs(ops[i]);
      if (def) definedBy.set(def, i);
      effects.push({ added, changed, removed, deps: [...deps].sort((a, b) => a - b) });
      prev = now;
    },
  };
}

/**
 * 试运行一批操作（不改动传入的工程）：执行、做结构与引用完整性校验、判断是否敏感。
 *
 * @param project 当前工程。
 * @param ops 操作。
 * @param env 外部数据。
 * @param aliases 别名表；省略时按 `project` 生成（与发给模型的上下文一致）。
 * @param options `effects` 为真时同时记录每条操作对片段的影响（与结果工程是同一次运行，新片段 id 一致）。
 * @returns 结果工程、问题列表、是否失败、是否敏感（与每条操作的影响）。
 */
export function planOps(
  project: ShowProject,
  ops: readonly AiOp[],
  env: CompileEnv,
  aliases: AliasMap,
  options: { effects?: boolean } = {},
): OpsPlan & { effects?: OpEffect[] } {
  let issues: OpIssue[] = [];
  const tracker = options.effects ? effectTracker(project, ops) : null;
  const next = produce(project, (d) => {
    issues = applyOps(d, ops, env, aliases, tracker?.after);
  });
  if (!issues.some((i) => i.level === "error")) {
    const shape = projectSchema.safeParse(next);
    if (!shape.success) {
      issues.push({ index: -1, level: "error", message: `the result is not a valid show: ${shape.error.issues[0]?.path.join(".")} ${shape.error.issues[0]?.message}` });
    }
    const broken = projectIntegrityIssues(next);
    if (broken.length > 0) issues.push({ index: -1, level: "error", message: `the result has broken references (${broken[0].code})` });
  }
  const before = new Set(project.cues.map((c) => c.id));
  const kept = next.cues.filter((c) => before.has(c.id)).length;
  const sensitive = ops.some((o) => SENSITIVE_OPS.has(o.op)) || before.size - kept > MAX_SILENT_DELETES;
  return { next, issues, failed: issues.some((i) => i.level === "error"), sensitive, ...(tracker ? { effects: tracker.effects } : {}) };
}

/**
 * 把问题列表写成回传给模型的文字。
 *
 * @param issues 问题。
 * @param ops 操作（标出是哪一条）。
 * @returns 文字；没有问题时为空串。
 */
export function issuesText(issues: readonly OpIssue[], ops: readonly AiOp[]): string {
  return issues
    .map((i) => `${i.level.toUpperCase()} ${i.index >= 0 ? `ops[${i.index}] (${ops[i.index]?.op})` : "batch"}: ${i.message}`)
    .join("\n");
}
