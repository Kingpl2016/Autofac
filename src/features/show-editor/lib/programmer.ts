import { layoutOf } from "@/features/fixtures";
import { hsvToRgb, rgbToHsv } from "./colorMath";
import { gapAround, MIN_CUE_MS } from "./cueOps";
import { newId } from "./ids";
import { parseRef, pixelRefsOf } from "./fixtureRef";
import { ATTR_KEYS, mergeLayers } from "./layers";
import { fixed, paramHead } from "./looks";
import type { AttrKey, ColorValue, Look, SceneClip, ShowProject, Track } from "./project";
import { clamp } from "@/shared/lib/math";
import { snapToFrame } from "./time";

/**
 * 编程器（Programmer）：在“同一帧”给多台灯具分别设定值的工作区，类似调光台的编程器。
 *
 * 编程器里的值不属于工程（不进撤销历史、不保存），预览时叠在工程之上（最后、最高优先级），
 * 满意后“记录”成场景片段（一个片段里多台灯各自的外观）或每台灯的外观片段。
 */

/** 编程器内容：灯具 id → 只写出“参与”的层的外观。 */
export type ProgrammerValues = Readonly<Record<string, Look>>;

/** 预览用的临时轨道 id（不会出现在工程里）。 */
export const PROGRAMMER_TRACK_ID = "__programmer__";

/**
 * 编程器是否有内容。
 *
 * @param values 编程器内容。
 * @returns 至少一台灯具写了某个层时为 `true`。
 */
export function hasProgrammerValues(values: ProgrammerValues): boolean {
  return Object.values(values).some((l) => l.intensity || l.color || Object.keys(l.attrs ?? {}).length > 0);
}

/**
 * 给一批灯具设强度（0~100%）。
 *
 * @param values 编程器内容。
 * @param ids 灯具。
 * @param percent 强度。
 * @returns 新内容。
 */
export function programIntensity(values: ProgrammerValues, ids: readonly string[], percent: number): Record<string, Look> {
  const next: Record<string, Look> = { ...values };
  for (const id of ids) next[id] = { ...next[id], intensity: fixed(clamp(percent, 0, 100)) };
  return next;
}

/**
 * 在每台灯当前强度的基础上加减（没设过强度的从 0 开始），结果限制在 0~100%。
 *
 * @param values 编程器内容。
 * @param ids 灯具。
 * @param delta 增量（百分点，可为负）。
 * @returns 新内容。
 */
export function programIntensityBy(values: ProgrammerValues, ids: readonly string[], delta: number): Record<string, Look> {
  const next: Record<string, Look> = { ...values };
  for (const id of ids) {
    const base = paramHead(next[id]?.intensity) ?? 0;
    next[id] = { ...next[id], intensity: fixed(clamp(base + delta, 0, 100)) };
  }
  return next;
}

/**
 * 给一批灯具设颜色（意图色）。
 *
 * @param values 编程器内容。
 * @param ids 灯具。
 * @param color 颜色。
 * @returns 新内容。
 */
export function programColor(values: ProgrammerValues, ids: readonly string[], color: ColorValue): Record<string, Look> {
  const next: Record<string, Look> = { ...values };
  for (const id of ids) next[id] = { ...next[id], color: fixed(color) };
  return next;
}

/**
 * 给一批灯具设一个非颜色属性（0~1 DMX 分数）。
 *
 * @param values 编程器内容。
 * @param ids 灯具。
 * @param key 属性。
 * @param fraction 取值。
 * @returns 新内容。
 */
export function programAttr(
  values: ProgrammerValues,
  ids: readonly string[],
  key: AttrKey,
  fraction: number,
): Record<string, Look> {
  const next: Record<string, Look> = { ...values };
  for (const id of ids) {
    const prev = next[id] ?? {};
    next[id] = { ...prev, attrs: { ...prev.attrs, [key]: fixed(clamp(fraction, 0, 1)) } };
  }
  return next;
}

/**
 * 从编程器里去掉一批灯具的某一层（`layer` 省略时去掉全部层，即 grandMA 的 Knockout）。
 *
 * @param values 编程器内容。
 * @param ids 灯具；省略为全部。
 * @param layer 层。
 * @returns 新内容。
 */
export function knockout(
  values: ProgrammerValues,
  ids?: readonly string[],
  layer?: "intensity" | "color" | AttrKey,
): Record<string, Look> {
  const next: Record<string, Look> = { ...values };
  for (const id of ids ?? Object.keys(values)) {
    const look = next[id];
    if (!look) continue;
    if (!layer) {
      delete next[id];
      continue;
    }
    const copy: Look = { ...look, attrs: { ...look.attrs } };
    if (layer === "intensity") delete copy.intensity;
    else if (layer === "color") delete copy.color;
    else delete copy.attrs?.[layer];
    if (copy.attrs && Object.keys(copy.attrs).length === 0) delete copy.attrs;
    if (!copy.intensity && !copy.color && !copy.attrs) delete next[id];
    else next[id] = copy;
  }
  return next;
}

/**
 * 把编程器内容转成场景条目：只保留工程里存在、且有内容的灯具与像素，按工程顺序（每台灯先整灯、再各像素）。
 *
 * @param project 工程（只读）。
 * @param values 编程器内容（键为灯具或像素引用）。
 * @returns 场景条目。
 */
function entriesOf(project: Pick<ShowProject, "fixtures" | "fixtureModels">, values: ProgrammerValues): SceneClip["entries"] {
  return project.fixtures
    .flatMap((f) => [f.id, ...pixelRefsOf(project, f)])
    .filter((id) => {
      const l = values[id];
      return l && (l.intensity || l.color || Object.keys(l.attrs ?? {}).length > 0);
    })
    .map((id) => ({ fixtureId: id, look: structuredClone(values[id]) }));
}

/**
 * 把编程器叠在工程之上：加一条临时的置顶层场景轨道（`onTop`），片段覆盖整个节目。
 *
 * 置顶层的颜色 / 属性在所有其它片段之后应用，所以总是胜出；强度仍是 HTP（与调光台的编程器一致）。
 * 预览与“实时输出”共用：编程器内容不变时编译结果可以复用（拖动播放头不用重新编译）。
 *
 * @param project 工程。
 * @param values 编程器内容。
 * @returns 新工程（编程器为空时原样返回）。
 */
export function withProgrammer(project: ShowProject, values: ProgrammerValues): ShowProject {
  const entries = entriesOf(project, values);
  if (entries.length === 0 || project.durationMs <= 0) return project;
  // 有独奏轨道时引擎只输出独奏轨道：编程器轨道也要独奏，否则看不到
  const soloing = project.tracks.some((t) => t.solo);
  const track: Track = {
    id: PROGRAMMER_TRACK_ID,
    target: { kind: "scene" },
    mute: false,
    solo: soloing,
    lock: true,
    onTop: true,
  };
  const clip: SceneClip = {
    id: "__programmer_clip__",
    kind: "scene",
    trackId: PROGRAMMER_TRACK_ID,
    startMs: 0,
    endMs: project.durationMs,
    brightness: 100,
    fadeInMs: 0,
    fadeOutMs: 0,
    easing: "linear",
    entries,
  };
  return { ...project, tracks: [...project.tracks, track], cues: [...project.cues, clip] };
}

/** 记录选项。 */
export interface RecordOptions {
  /** 淡入时长（毫秒）；超过片段长度时截短为片段长度 */
  fadeInMs?: number;
}

/**
 * 记录片段的淡入时长。
 *
 * @param opts 记录选项。
 * @param length 片段长度。
 * @returns 0 ~ 片段长度之间的整数毫秒。
 */
function fadeIn(opts: RecordOptions, length: number): number {
  return Math.round(clamp(opts.fadeInMs ?? 0, 0, Math.max(0, length)));
}

/** 记录的结果。 */
export interface RecordResult {
  /** 新建的片段 */
  cueIds: string[];
  /** 新建的轨道（记录场景时没有场景轨道会自动建一条） */
  trackIds: string[];
  /** 因为位置被占用而跳过的灯具 */
  skipped: string[];
}

/**
 * 把编程器记录成一个场景片段：一个片段里多台灯具各自的外观（同一帧设置多个灯具）。
 *
 * 放在第一条未锁定、且 `startMs` 处有空位的场景轨道上；没有时新建一条。长度不会越过后一个片段。
 *
 * @param draft 工程草稿。
 * @param values 编程器内容。
 * @param startMs 起点（对齐到帧）。
 * @param lengthMs 期望长度。
 * @param trackName 新建场景轨道时用的名字。
 * @param opts 记录选项。
 * @returns 结果；编程器为空或放不下时 `cueIds` 为空。
 */
export function recordScene(
  draft: ShowProject,
  values: ProgrammerValues,
  startMs: number,
  lengthMs: number,
  trackName: string,
  opts: RecordOptions = {},
): RecordResult {
  const result: RecordResult = { cueIds: [], trackIds: [], skipped: [] };
  const entries = entriesOf(draft, values);
  if (entries.length === 0) return result;
  const start = clamp(snapToFrame(startMs), 0, draft.durationMs);
  let track = draft.tracks.find((t) => t.target.kind === "scene" && !t.lock && gapAround(draft, t.id, start) !== null);
  if (!track) {
    track = { id: newId(), target: { kind: "scene" }, mute: false, solo: false, lock: false, name: trackName };
    draft.tracks.push(track);
    result.trackIds.push(track.id);
  }
  const gap = gapAround(draft, track.id, start) ?? [start, start];
  const end = Math.min(snapToFrame(start + lengthMs), gap[1]);
  if (end - start < MIN_CUE_MS) return result;
  const clip: SceneClip = {
    id: newId(),
    kind: "scene",
    trackId: track.id,
    startMs: start,
    endMs: end,
    brightness: 100,
    fadeInMs: fadeIn(opts, end - start),
    fadeOutMs: 0,
    easing: "linear",
    entries,
  };
  draft.cues.push(clip);
  result.cueIds.push(clip.id);
  return result;
}

/**
 * 把编程器记录成每台灯具自己轨道上的外观片段。
 *
 * @param draft 工程草稿。
 * @param values 编程器内容。
 * @param startMs 起点（对齐到帧）。
 * @param lengthMs 期望长度。
 * @param opts 记录选项。
 * @returns 结果；轨道锁定或起点处已有片段的灯具列在 `skipped`。
 */
export function recordLooks(
  draft: ShowProject,
  values: ProgrammerValues,
  startMs: number,
  lengthMs: number,
  opts: RecordOptions = {},
): RecordResult {
  const result: RecordResult = { cueIds: [], trackIds: [], skipped: [] };
  const start = clamp(snapToFrame(startMs), 0, draft.durationMs);
  for (const { fixtureId, look } of entriesOf(draft, values)) {
    const track = draft.tracks.find((t) => t.target.kind === "fixture" && t.target.id === fixtureId && !t.lock);
    const gap = track ? gapAround(draft, track.id, start) : null;
    const end = gap ? Math.min(snapToFrame(start + lengthMs), gap[1]) : start;
    if (!track || !gap || end - start < MIN_CUE_MS) {
      result.skipped.push(fixtureId);
      continue;
    }
    const id = newId();
    draft.cues.push({
      id,
      kind: "look",
      trackId: track.id,
      startMs: start,
      endMs: end,
      brightness: 100,
      fadeInMs: fadeIn(opts, end - start),
      fadeOutMs: 0,
      easing: "linear",
      look,
    });
    result.cueIds.push(id);
  }
  return result;
}

/**
 * 黑场：全部轨道静音（灯具保持默认值，通道锁定 Park 仍然生效）。
 *
 * @param project 工程。
 * @returns 新工程（只改轨道的静音 / 独奏）。
 */
export function blackoutProject(project: ShowProject): ShowProject {
  return { ...project, tracks: project.tracks.map((t) => ({ ...t, mute: true, solo: false })) };
}

// ---------------------------------------------------------------------------
// 分布（grandMA3 的 Align / Fan）
// ---------------------------------------------------------------------------

/**
 * 分布方式（与 grandMA3 的 Align 模式对应）。每台灯的取值为 `A + (B − A) × w`，`t` 为它在选择里的位置（0~1）：
 *
 * - `/`：以中间为轴对称展开，`w = 2t − 1`（中间一台为 A，最后一台为 B，第一台与 B 关于 A 对称）；
 * - `<`：从第一台起，`w = 1 − t`（第一台为 B，逐台回到 A）；
 * - `>`：从最后一台起，`w = t`（第一台为 A，最后一台为 B）；
 * - `><`：中间最大，`w = 1 − |2t − 1|`（两端为 A，中间为 B）；
 * - `<>`：两端最大，`w = |2t − 1|`（中间为 A，两端为 B）。
 */
export const FAN_MODES = ["/", "<", ">", "><", "<>"] as const;

/** 分布方式。 */
export type FanMode = (typeof FAN_MODES)[number];

/**
 * 分布过渡（grandMA3 的 Align Transition）：`linear` 等距，`sine` 两端密中间疏，`slow` 先小后大，`fast` 先大后小。
 */
export const FAN_TRANSITIONS = ["linear", "sine", "slow", "fast"] as const;

/** 分布过渡。 */
export type FanTransition = (typeof FAN_TRANSITIONS)[number];

/**
 * 按过渡曲线变换权重的大小（保留正负号）。
 *
 * @param w 权重（-1~1）。
 * @param transition 过渡。
 * @returns 变换后的权重。
 */
function shapeWeight(w: number, transition: FanTransition): number {
  const a = Math.abs(w);
  const s =
    transition === "sine" ? (1 - Math.cos(Math.PI * a)) / 2 : transition === "slow" ? a * a : transition === "fast" ? 1 - (1 - a) * (1 - a) : a;
  return Math.sign(w) * s;
}

/**
 * 分布的权重：第 `i` 台灯取 `A + (B − A) × w[i]`。
 *
 * @param count 灯具数。
 * @param mode 分布方式。
 * @param transition 过渡。
 * @returns 每台灯的权重；只有 1 台时为 `[1]`（直接取 B）。
 */
export function fanWeights(count: number, mode: FanMode, transition: FanTransition = "linear"): number[] {
  if (count <= 0) return [];
  if (count === 1) return [1];
  return Array.from({ length: count }, (_, i) => {
    const t = i / (count - 1);
    const w =
      mode === "/" ? 2 * t - 1 : mode === "<" ? 1 - t : mode === ">" ? t : mode === "><" ? 1 - Math.abs(2 * t - 1) : Math.abs(2 * t - 1);
    // 浮点误差：让端点与中点是精确值
    return shapeWeight(Math.round(w * 1e9) / 1e9, transition);
  });
}

/**
 * 分布的取值：`A + (B − A) × w`。
 *
 * @param count 灯具数。
 * @param from 起点值 A。
 * @param to 终点值 B。
 * @param mode 分布方式。
 * @param transition 过渡。
 * @returns 每台灯的取值（未限制范围，由调用方按层夹紧）。
 */
export function fanValues(count: number, from: number, to: number, mode: FanMode, transition: FanTransition = "linear"): number[] {
  return fanWeights(count, mode, transition).map((w) => from + (to - from) * w);
}

/** 分布作用的层：强度（0~100）、色相（0~360°）或属性（0~1）。 */
export type FanLayer = "intensity" | "hue" | AttrKey;

/**
 * 按选择顺序给一批灯具分布一个层的取值，写入编程器。
 *
 * - 强度：0~100%；
 * - 色相：0~360°，保留各灯当前颜色的饱和度与明度（没有彩色时用满饱和、满明度）；
 * - 属性：0~1，`supports` 判断为不支持的灯跳过（但仍占一个分布位置，与调光台一致）。
 *
 * @param values 编程器内容。
 * @param ids 灯具（选择顺序）。
 * @param layer 层。
 * @param from 起点值 A。
 * @param to 终点值 B。
 * @param mode 分布方式。
 * @param transition 过渡。
 * @param supports 某台灯是否有这个属性（只对属性层使用）；省略时都写。
 * @returns 新内容。
 */
export function programFan(
  values: ProgrammerValues,
  ids: readonly string[],
  layer: FanLayer,
  from: number,
  to: number,
  mode: FanMode,
  transition: FanTransition = "linear",
  supports: (id: string) => boolean = () => true,
): Record<string, Look> {
  const next: Record<string, Look> = { ...values };
  const list = fanValues(ids.length, from, to, mode, transition);
  ids.forEach((id, i) => {
    const v = list[i];
    const prev = next[id] ?? {};
    if (layer === "intensity") {
      next[id] = { ...prev, intensity: fixed(Math.round(clamp(v, 0, 100) * 100) / 100) };
    } else if (layer === "hue") {
      const current = paramHead(prev.color);
      const hsv = current?.kind === "rgb" ? rgbToHsv(current.rgb) : null;
      const s = hsv && hsv.s > 0 ? hsv.s : 1;
      const val = hsv && hsv.v > 0 ? hsv.v : 1;
      const h = ((v % 360) + 360) % 360;
      const white = current?.kind === "rgb" ? current.white : undefined;
      next[id] = { ...prev, color: fixed({ kind: "rgb", rgb: hsvToRgb({ h, s, v: val }), ...(white ? { white } : {}) }) };
    } else if (supports(id)) {
      next[id] = { ...prev, attrs: { ...prev.attrs, [layer]: fixed(Math.round(clamp(v, 0, 1) * 1e4) / 1e4) } };
    }
  });
  return next;
}

// ---------------------------------------------------------------------------
// 高亮（grandMA3 的 Highlight）
// ---------------------------------------------------------------------------

/** 高亮叠加层的临时轨道 id（不会出现在工程里）。 */
export const HIGHLIGHT_TRACK_ID = "__highlight__";

/**
 * 一台灯（或像素）的高亮外观：满亮白光；通道标注了高亮值（OFL 的 `highlightValue`）的属性写高亮值。
 *
 * @param project 工程（只读）。
 * @param ref 灯具或像素引用。
 * @returns 外观；灯具不存在时为 `null`。
 */
export function highlightLook(project: Pick<ShowProject, "fixtures" | "fixtureModels">, ref: string): Look | null {
  const { fixtureId, head } = parseRef(ref);
  const f = project.fixtures.find((x) => x.id === fixtureId);
  if (!f) return null;
  const model = project.fixtureModels.find((m) => m.id === f.modelId);
  const layout = model ? (layoutOf(model, f.modeId) ?? []) : [];
  const attrs: Partial<Record<AttrKey, ReturnType<typeof fixed<number>>>> = {};
  for (const p of layout) {
    if (p.highlightValue === undefined || p.highlightValue === null) continue;
    if (head !== null && (p.head ?? 0) !== head) continue;
    const key = p.function as AttrKey;
    if (!ATTR_KEYS.includes(key) || attrs[key]) continue;
    const raw = p.highlightValue / (p.width === 2 ? 65535 : 255);
    attrs[key] = fixed(clamp(p.invert ? 1 - raw : raw, 0, 1));
  }
  return {
    intensity: fixed(100),
    color: fixed({ kind: "rgb", rgb: [255, 255, 255] }),
    ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
  };
}

/**
 * 把高亮叠在工程之上（在编程器之后：置顶层里最后一条，颜色 / 属性胜过编程器，强度 HTP）。
 *
 * @param project 工程（通常已经叠了编程器）。
 * @param ids 要高亮的灯具或像素引用（一般是当前选择）；为空时原样返回。
 * @returns 新工程。
 */
export function withHighlight(project: ShowProject, ids: readonly string[]): ShowProject {
  if (ids.length === 0 || project.durationMs <= 0) return project;
  const entries = [...new Set(ids)].flatMap((id) => {
    const look = highlightLook(project, id);
    return look ? [{ fixtureId: id, look }] : [];
  });
  if (entries.length === 0) return project;
  const soloing = project.tracks.some((t) => t.solo);
  const track: Track = { id: HIGHLIGHT_TRACK_ID, target: { kind: "scene" }, mute: false, solo: soloing, lock: true, onTop: true };
  const clip: SceneClip = {
    id: "__highlight_clip__",
    kind: "scene",
    trackId: HIGHLIGHT_TRACK_ID,
    startMs: 0,
    endMs: project.durationMs,
    brightness: 100,
    fadeInMs: 0,
    fadeOutMs: 0,
    easing: "linear",
    entries,
  };
  return { ...project, tracks: [...project.tracks, track], cues: [...project.cues, clip] };
}

// ---------------------------------------------------------------------------
// 更新到片段（grandMA3 的 Update）
// ---------------------------------------------------------------------------

/** 更新方式：合并（只改编程器里有的层）或覆盖（片段的外观换成编程器里的）。 */
export type UpdateMode = "merge" | "replace";

/**
 * 把编程器内容更新到选中的片段（一次撤销步骤由调用方的 `update` 保证）。
 *
 * - 外观片段：取轨道上第一台在编程器里有值的灯（灯具轨道就是这台灯；分组轨道取成员里的第一台）的外观；
 * - 场景片段：按条目合并（合并时编程器里新出现的灯追加为新条目；覆盖时条目换成编程器里的全部灯）；
 * - 锁定轨道上的片段、旧式静态 / 特效片段跳过。
 *
 * @param draft 工程草稿。
 * @param values 编程器内容。
 * @param cueIds 要更新的片段。
 * @param mode 更新方式。
 * @param membersOf 轨道成员（灯具或像素引用，按成员顺序）。
 * @returns 实际更新的片段数。
 */
export function updateCuesFromProgrammer(
  draft: ShowProject,
  values: ProgrammerValues,
  cueIds: readonly string[],
  mode: UpdateMode,
  membersOf: (track: Track) => readonly string[],
): number {
  const wanted = new Set(cueIds);
  const tracks = new Map(draft.tracks.map((t) => [t.id, t]));
  const has = (id: string) => {
    const l = values[id];
    return l !== undefined && (l.intensity !== undefined || l.color !== undefined || Object.keys(l.attrs ?? {}).length > 0);
  };
  let n = 0;
  for (const cue of draft.cues) {
    if (!wanted.has(cue.id)) continue;
    const track = tracks.get(cue.trackId);
    if (!track || track.lock) continue;
    if (cue.kind === "look") {
      const source = membersOf(track).find(has);
      if (!source) continue;
      const look = structuredClone(values[source]);
      if (mode === "replace") cue.look = look;
      else mergeLayers(cue.look, look);
      n += 1;
    } else if (cue.kind === "scene") {
      const entries = entriesOf(draft, values);
      if (entries.length === 0) continue;
      if (mode === "replace") {
        cue.entries = entries;
      } else {
        for (const e of entries) {
          const existing = cue.entries.find((x) => x.fixtureId === e.fixtureId);
          if (existing) mergeLayers(existing.look, e.look);
          else cue.entries.push(e);
        }
      }
      n += 1;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// 记录设置
// ---------------------------------------------------------------------------

/** 记录设置（编辑器偏好，记住上次的值）。 */
export interface RecordPrefs {
  /** 长度（毫秒，`unit = "ms"` 时用） */
  lengthMs: number;
  /** 长度单位：毫秒，或按节拍的拍数（工程没有节拍时按毫秒） */
  unit: "ms" | "beats";
  /** 拍数（`unit = "beats"` 时用） */
  beats: number;
  /** 淡入时长（毫秒） */
  fadeInMs: number;
}

/** 记录设置的默认值。 */
export const DEFAULT_RECORD_PREFS: RecordPrefs = { lengthMs: 2000, unit: "ms", beats: 4, fadeInMs: 0 };

/** 记录长度的范围（毫秒）。 */
export const RECORD_LENGTH_RANGE = { min: 100, max: 3_600_000 } as const;

/**
 * 记录片段的长度：按拍时换算成毫秒（需要工程有节拍），否则用毫秒。
 *
 * @param prefs 记录设置。
 * @param tempo 工程节拍；没有时为 `null`。
 * @returns 毫秒（在 `RECORD_LENGTH_RANGE` 内）。
 */
export function recordLengthMs(prefs: RecordPrefs, tempo: { bpm: number } | null): number {
  const ms = prefs.unit === "beats" && tempo && tempo.bpm > 0 ? (prefs.beats * 60_000) / tempo.bpm : prefs.lengthMs;
  return Math.round(clamp(ms, RECORD_LENGTH_RANGE.min, RECORD_LENGTH_RANGE.max));
}

/**
 * 规整从磁盘读回的记录设置（逐字段兜底）。
 *
 * @param raw 未知数据。
 * @param fallback 兜底值。
 * @returns 合法的记录设置。
 */
export function sanitizeRecordPrefs(raw: unknown, fallback: RecordPrefs): RecordPrefs {
  const r = (raw ?? {}) as Partial<Record<keyof RecordPrefs, unknown>>;
  const num = (v: unknown, min: number, max: number, d: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d;
  return {
    lengthMs: Math.round(num(r.lengthMs, RECORD_LENGTH_RANGE.min, RECORD_LENGTH_RANGE.max, fallback.lengthMs)),
    unit: r.unit === "beats" || r.unit === "ms" ? r.unit : fallback.unit,
    beats: num(r.beats, 0.25, 1024, fallback.beats),
    fadeInMs: Math.round(num(r.fadeInMs, 0, RECORD_LENGTH_RANGE.max, fallback.fadeInMs)),
  };
}
