import { current, isDraft } from "immer";

import { MIN_PERIOD_MS } from "./effects";
import {
  cloneParams,
  MAX_EFFECT_COLORS,
  MAX_PERIOD_BEATS,
  MAX_PERIOD_MS,
  MIN_PERIOD_BEATS,
  type EffectParams,
  type EffectPreset,
} from "./effectPresets";
import { newId } from "./ids";
import {
  type Cue,
  type Easing,
  type EffectCue,
  type Look,
  type Param,
  type Rgb,
  type ShowProject,
  type Spread,
  type StaticCue,
  type Track,
} from "./project";
import { clamp, snapToFrame } from "./time";

/**
 * 对时间线上 Cue 的纯编辑操作。
 *
 * 与 `ops.ts` 一样直接修改 immer 草稿。核心规则：
 * - 同一条轨道上的 Cue 不重叠；
 * - Cue 在 `[0, durationMs]` 之内，最短 [`MIN_CUE_MS`]；
 * - 淡入 + 淡出不超过 Cue 的长度（缩短 Cue 时按比例收缩）；
 * - 被锁定的轨道上的 Cue 不能被改动。
 */

/** Cue 的最短长度（毫秒）。 */
export const MIN_CUE_MS = 100;

/** 双击空白处新建 Cue 的默认长度（毫秒）。 */
export const DEFAULT_CUE_MS = 2000;

/** 新建静态 Cue 的默认外观。 */
export interface CueStyle {
  rgb: Rgb;
  brightness: number;
  fadeInMs: number;
  fadeOutMs: number;
  easing: Easing;
}

/** 默认外观：全亮白光、无淡入淡出。 */
export const DEFAULT_CUE_STYLE: CueStyle = {
  rgb: [255, 255, 255],
  brightness: 100,
  fadeInMs: 0,
  fadeOutMs: 0,
  easing: "linear",
};

/** 剪贴板里的一个 Cue：保存样式和相对于这组 Cue 最早起点的偏移。 */
export interface ClipCue {
  trackId: string;
  /** 相对最早起点的偏移（毫秒） */
  offsetMs: number;
  /** 长度（毫秒） */
  lengthMs: number;
  /** 除 id / 轨道 / 起止时间之外的全部属性 */
  cue: Omit<Cue, "id" | "trackId" | "startMs" | "endMs">;
}

/**
 * 某条轨道上，包含 `atMs` 这个时刻的空隙边界。
 *
 * @param project 工程（只读）。
 * @param trackId 轨道 id。
 * @param atMs 时刻（毫秒）。
 * @param excludeIds 计算时忽略的 Cue（例如正在被拖动的那一个）。
 * @returns `[下界, 上界]`：前一个 Cue 的终点（或 0）到后一个 Cue 的起点（或工程时长）；
 *   `atMs` 落在某个 Cue 内部时为 `null`。
 */
export function gapAround(
  project: Pick<ShowProject, "cues" | "durationMs">,
  trackId: string,
  atMs: number,
  excludeIds: ReadonlySet<string> = new Set(),
): [number, number] | null {
  let lower = 0;
  let upper = project.durationMs;
  for (const c of project.cues) {
    if (c.trackId !== trackId || excludeIds.has(c.id)) continue;
    if (atMs >= c.startMs && atMs < c.endMs) return null;
    if (c.endMs <= atMs) lower = Math.max(lower, c.endMs);
    if (c.startMs >= atMs) upper = Math.min(upper, c.startMs);
  }
  return [lower, upper];
}

/**
 * 轨道是否存在且未被锁定。
 *
 * @param project 工程（只读）。
 * @param trackId 轨道 id。
 */
function editableTrack(project: Pick<ShowProject, "tracks">, trackId: string): boolean {
  const track = project.tracks.find((t) => t.id === trackId);
  return track !== undefined && !track.lock;
}

/**
 * 缩短 Cue 后让淡入淡出仍然装得下：超出时两者按比例收缩。
 *
 * @param cue 要修正的 Cue（原地修改）。
 */
export function normalizeFades(cue: Cue): void {
  const length = cue.endMs - cue.startMs;
  const total = cue.fadeInMs + cue.fadeOutMs;
  if (total <= length) return;
  const scale = length / total;
  cue.fadeInMs = Math.floor(cue.fadeInMs * scale);
  cue.fadeOutMs = Math.floor(cue.fadeOutMs * scale);
}

/**
 * 在轨道上新建一个静态 Cue。
 *
 * 起点对齐到帧；长度取 `lengthMs`，但不会越过后一个 Cue 或工程末尾。
 *
 * @param draft 工程草稿。
 * @param trackId 目标轨道。
 * @param startMs 期望起点（毫秒）。
 * @param options 可选的长度与外观。
 * @returns 新 Cue 的 id；轨道不存在 / 被锁定、起点落在已有 Cue 内、或空隙不足 [`MIN_CUE_MS`] 时为 `null`。
 */
export function addStaticCue(
  draft: ShowProject,
  trackId: string,
  startMs: number,
  options: Partial<CueStyle> & { lengthMs?: number } = {},
): string | null {
  if (!editableTrack(draft, trackId)) return null;
  const start = clamp(snapToFrame(startMs), 0, draft.durationMs);
  const gap = gapAround(draft, trackId, start);
  if (!gap) return null;
  const end = Math.min(start + (options.lengthMs ?? DEFAULT_CUE_MS), gap[1]);
  if (end - start < MIN_CUE_MS) return null;
  const style = { ...DEFAULT_CUE_STYLE, ...options };
  const cue: StaticCue = {
    id: newId(),
    trackId,
    kind: "static",
    startMs: start,
    endMs: end,
    rgb: [...style.rgb],
    brightness: style.brightness,
    fadeInMs: style.fadeInMs,
    fadeOutMs: style.fadeOutMs,
    easing: style.easing,
  };
  normalizeFades(cue);
  draft.cues.push(cue);
  return cue.id;
}

/**
 * 在轨道上新建一个特效 Cue。
 *
 * 规则同 [`addStaticCue`]：起点对齐到帧，长度取预设长度但不越过后一个 Cue 或工程末尾。
 *
 * @param draft 工程草稿。
 * @param trackId 目标轨道。
 * @param startMs 期望起点（毫秒）。
 * @param preset 特效预设（参数会被深拷贝）。
 * @param options 可选的长度、亮度与淡入淡出覆盖。
 * @returns 新 Cue 的 id；轨道不存在 / 被锁定、起点落在已有 Cue 内、或空隙不足时为 `null`。
 */
export function addEffectCue(
  draft: ShowProject,
  trackId: string,
  startMs: number,
  preset: Pick<EffectPreset, "lengthMs" | "params">,
  options: Partial<Pick<CueStyle, "brightness" | "fadeInMs" | "fadeOutMs" | "easing">> & { lengthMs?: number } = {},
): string | null {
  if (!editableTrack(draft, trackId)) return null;
  const start = clamp(snapToFrame(startMs), 0, draft.durationMs);
  const gap = gapAround(draft, trackId, start);
  if (!gap) return null;
  const end = Math.min(start + (options.lengthMs ?? preset.lengthMs), gap[1]);
  if (end - start < MIN_CUE_MS) return null;
  const cue: EffectCue = {
    id: newId(),
    trackId,
    kind: "effect",
    startMs: start,
    endMs: end,
    brightness: options.brightness ?? DEFAULT_CUE_STYLE.brightness,
    fadeInMs: options.fadeInMs ?? 0,
    fadeOutMs: options.fadeOutMs ?? 0,
    easing: options.easing ?? DEFAULT_CUE_STYLE.easing,
    ...cloneParams(preset.params),
  };
  normalizeFades(cue);
  draft.cues.push(cue);
  return cue.id;
}

/** 对一批特效 Cue 统一修改的参数；省略的字段保持不变。 */
export type EffectPatch = Partial<EffectParams>;

/**
 * 批量修改特效 Cue 的参数（静态 Cue 与锁定轨道上的 Cue 不受影响）。
 *
 * 取值会被规整：颜色 1~4 个、分量取整夹在 0~255；周期按毫秒取整夹在 33 ms~10 分钟，
 * 按拍数保留两位小数夹在 0.25~128 拍；扩散 0~1；亮度范围夹在 0~100 且下限不超过上限；
 * 随机种子取非负整数（32 位）。非法的颜色列表（空）整项被忽略。
 *
 * @param draft 工程草稿。
 * @param ids 要修改的 Cue。
 * @param patch 要修改的参数。
 * @returns 实际被修改的特效 Cue 数量。
 */
export function updateEffectCues(draft: ShowProject, ids: readonly string[], patch: EffectPatch): number {
  const wanted = new Set(ids);
  let touched = 0;
  for (const cue of draft.cues) {
    if (cue.kind !== "effect" || !wanted.has(cue.id) || !editableTrack(draft, cue.trackId)) continue;
    if (patch.effect !== undefined) cue.effect = patch.effect;
    if (patch.colors !== undefined && patch.colors.length > 0) {
      cue.colors = patch.colors.slice(0, MAX_EFFECT_COLORS).map(
        (c): Rgb => [
          clamp(Math.round(c[0]), 0, 255),
          clamp(Math.round(c[1]), 0, 255),
          clamp(Math.round(c[2]), 0, 255),
        ],
      );
    }
    if (patch.period !== undefined) {
      cue.period =
        patch.period.kind === "ms"
          ? { kind: "ms", ms: clamp(Math.round(patch.period.ms), MIN_PERIOD_MS, MAX_PERIOD_MS) }
          : {
              kind: "beats",
              beats: clamp(Math.round(patch.period.beats * 100) / 100, MIN_PERIOD_BEATS, MAX_PERIOD_BEATS),
            };
    }
    if (patch.phaseSpread !== undefined) cue.phaseSpread = clamp(patch.phaseSpread, 0, 1);
    if (patch.direction !== undefined) cue.direction = patch.direction < 0 ? -1 : 1;
    if (patch.range !== undefined) {
      const a = clamp(Math.round(patch.range[0]), 0, 100);
      const b = clamp(Math.round(patch.range[1]), 0, 100);
      cue.range = [Math.min(a, b), Math.max(a, b)];
    }
    if (patch.seed !== undefined) cue.seed = Math.floor(Math.abs(patch.seed)) >>> 0;
    touched += 1;
  }
  return touched;
}
/**
 * 修改 Cue 的起止时间（移动或拉伸）。
 *
 * 时间会对齐到帧并夹在 `[0, durationMs]`；与同轨其他 Cue 重叠、短于 [`MIN_CUE_MS`]
 * 或轨道被锁定时整个修改被拒绝，Cue 保持原样。
 *
 * @param draft 工程草稿。
 * @param id Cue id。
 * @param startMs 新起点。
 * @param endMs 新终点。
 * @returns 是否修改成功。
 */
export function setCueTimes(draft: ShowProject, id: string, startMs: number, endMs: number): boolean {
  const cue = draft.cues.find((c) => c.id === id);
  if (!cue || !editableTrack(draft, cue.trackId)) return false;
  const start = clamp(snapToFrame(startMs), 0, draft.durationMs);
  const end = clamp(snapToFrame(endMs), 0, draft.durationMs);
  if (end - start < MIN_CUE_MS) return false;
  const overlaps = draft.cues.some(
    (c) => c.id !== id && c.trackId === cue.trackId && c.startMs < end && start < c.endMs,
  );
  if (overlaps) return false;
  cue.startMs = start;
  cue.endMs = end;
  normalizeFades(cue);
  return true;
}

/**
 * 删除 Cue（锁定轨道上的 Cue 保留）。
 *
 * @param draft 工程草稿。
 * @param ids 要删除的 Cue id。
 * @returns 实际删除的数量。
 */
export function removeCues(draft: ShowProject, ids: readonly string[]): number {
  const gone = new Set(ids);
  const before = draft.cues.length;
  draft.cues = draft.cues.filter((c) => !(gone.has(c.id) && editableTrack(draft, c.trackId)));
  return before - draft.cues.length;
}

/**
 * 复制 Cue 到剪贴板结构。
 *
 * @param project 工程（只读）。
 * @param ids 要复制的 Cue id。
 * @returns 按起点排序的剪贴板内容；没有可复制的 Cue 时为空数组。
 */
export function copyCues(project: Pick<ShowProject, "cues">, ids: readonly string[]): ClipCue[] {
  const wanted = new Set(ids);
  const picked = project.cues.filter((c) => wanted.has(c.id)).sort((a, b) => a.startMs - b.startMs);
  if (picked.length === 0) return [];
  const origin = picked[0].startMs;
  return picked.map((c) => {
    const { id: _id, trackId, startMs, endMs, ...rest } = structuredClone(c);
    return { trackId, offsetMs: startMs - origin, lengthMs: endMs - startMs, cue: rest };
  });
}

/**
 * 把剪贴板里的 Cue 粘贴到 `atMs` 处。
 *
 * 保持相对位置和原来的轨道；某条轨道在目标位置被占用时，向后挪到下一个放得下的位置，
 * 实在放不下（或轨道已被删除 / 锁定）就跳过那个 Cue。
 *
 * @param draft 工程草稿。
 * @param clip 剪贴板内容（见 [`copyCues`]）。
 * @param atMs 粘贴起点（毫秒）。
 * @returns 新建 Cue 的 id。
 */
export function pasteCues(draft: ShowProject, clip: readonly ClipCue[], atMs: number): string[] {
  const created: string[] = [];
  for (const item of clip) {
    if (!editableTrack(draft, item.trackId)) continue;
    let start = clamp(snapToFrame(atMs + item.offsetMs), 0, draft.durationMs);
    // 落在已有 Cue 里：挪到它的终点
    const blocker = draft.cues.find(
      (c) => c.trackId === item.trackId && start >= c.startMs && start < c.endMs,
    );
    if (blocker) start = blocker.endMs;
    const end = start + item.lengthMs;
    if (end > draft.durationMs) continue;
    const gap = gapAround(draft, item.trackId, start);
    if (!gap || end > gap[1]) continue;
    const cue = { ...structuredClone(item.cue), id: newId(), trackId: item.trackId, startMs: start, endMs: end } as Cue;
    draft.cues.push(cue);
    created.push(cue.id);
  }
  return created;
}

/**
 * 把来自同一条轨道的剪贴板内容分别粘贴到多条轨道上（多轨编辑）。剪贴板跨多条轨道时退回 [`pasteCues`]
 * （保持原来的轨道）。轨道类型不接受该片段（场景片段 ↔ 灯具 / 分组轨道）时跳过。
 *
 * @param draft 工程草稿。
 * @param clip 剪贴板内容。
 * @param atMs 粘贴起点。
 * @param trackIds 目标轨道。
 * @returns 新建片段的 id。
 */
export function pasteCuesToTracks(
  draft: ShowProject,
  clip: readonly ClipCue[],
  atMs: number,
  trackIds: readonly string[],
): string[] {
  const sources = new Set(clip.map((c) => c.trackId));
  if (sources.size !== 1 || trackIds.length === 0) return pasteCues(draft, clip, atMs);
  const created: string[] = [];
  for (const trackId of trackIds) {
    const track = draft.tracks.find((t) => t.id === trackId);
    if (!track) continue;
    const items = clip.filter((c) => trackAccepts(track, c.cue)).map((c) => ({ ...c, trackId }));
    created.push(...pasteCues(draft, items, atMs));
  }
  return created;
}

/** 对一批 Cue 统一修改的属性；省略的字段保持不变。 */
export interface CuePatch {
  /** 颜色，仅对静态 Cue 生效 */
  rgb?: Rgb;
  /** 亮度 0~100 */
  brightness?: number;
  fadeInMs?: number;
  fadeOutMs?: number;
  easing?: Easing;
}

/**
 * 批量修改 Cue 的外观。
 *
 * - 亮度夹在 0~100，颜色分量夹在 0~255 并取整，只作用于静态 Cue；
 * - 淡入淡出不会超过 Cue 的长度：先按给定值夹取，淡入 + 淡出超长时优先保证本次修改的那一项；
 * - 锁定轨道上的 Cue 不受影响。
 *
 * @param draft 工程草稿。
 * @param ids 要修改的 Cue。
 * @param patch 要修改的属性。
 * @returns 实际被修改的 Cue 数量。
 */
export function updateCues(draft: ShowProject, ids: readonly string[], patch: CuePatch): number {
  const wanted = new Set(ids);
  let touched = 0;
  for (const cue of draft.cues) {
    if (!wanted.has(cue.id) || !editableTrack(draft, cue.trackId)) continue;
    const length = cue.endMs - cue.startMs;
    if (patch.brightness !== undefined) cue.brightness = clamp(Math.round(patch.brightness), 0, 100);
    if (patch.easing !== undefined) cue.easing = patch.easing;
    if (patch.rgb !== undefined && cue.kind === "static") {
      cue.rgb = [
        clamp(Math.round(patch.rgb[0]), 0, 255),
        clamp(Math.round(patch.rgb[1]), 0, 255),
        clamp(Math.round(patch.rgb[2]), 0, 255),
      ];
    }
    if (patch.fadeInMs !== undefined) {
      cue.fadeInMs = clamp(Math.round(patch.fadeInMs), 0, Math.max(0, length - cue.fadeOutMs));
    }
    if (patch.fadeOutMs !== undefined) {
      cue.fadeOutMs = clamp(Math.round(patch.fadeOutMs), 0, Math.max(0, length - cue.fadeInMs));
    }
    touched += 1;
  }
  return touched;
}

/**
 * 把一批 Cue 整体平移 `deltaMs`（键盘微调）。
 *
 * 任何一个 Cue 越出 `[0, durationMs]`、压住未被选中的 Cue，或位于锁定轨道上，整次平移都被拒绝。
 *
 * @param draft 工程草稿。
 * @param ids 要平移的 Cue。
 * @param deltaMs 平移量（毫秒，可为负）；每个 Cue 的新起点会对齐到帧。
 * @returns 是否平移成功。
 */
export function nudgeCues(draft: ShowProject, ids: readonly string[], deltaMs: number): boolean {
  const wanted = new Set(ids);
  const moving = draft.cues.filter((c) => wanted.has(c.id));
  if (moving.length === 0 || deltaMs === 0) return false;
  // 每个 Cue 的新起点对齐到帧，长度保持不变，这样连续微调不会积累取整误差
  const placed = new Map<string, [number, number]>();
  for (const c of moving) {
    if (!editableTrack(draft, c.trackId)) return false;
    const start = snapToFrame(c.startMs + deltaMs);
    const end = start + (c.endMs - c.startMs);
    if (start < 0 || end > draft.durationMs) return false;
    const blocked = draft.cues.some(
      (o) => !wanted.has(o.id) && o.trackId === c.trackId && o.startMs < end && start < o.endMs,
    );
    if (blocked) return false;
    placed.set(c.id, [start, end]);
  }
  for (const c of moving) {
    const span = placed.get(c.id);
    if (span) [c.startMs, c.endMs] = span;
  }
  return true;
}

/**
 * 修改外观片段的外观（锁定轨道上的不动）。
 *
 * @param draft 工程草稿。
 * @param ids 片段 id（非外观片段忽略）。
 * @param recipe 在外观草稿上修改。
 * @returns 实际被修改的片段数。
 */
export function updateLooks(
  draft: ShowProject,
  ids: readonly string[],
  recipe: (look: Look, cue: Extract<Cue, { kind: "look" }>) => void,
): number {
  const wanted = new Set(ids);
  let touched = 0;
  for (const cue of draft.cues) {
    if (cue.kind !== "look" || !wanted.has(cue.id) || !editableTrack(draft, cue.trackId)) continue;
    recipe(cue.look, cue);
    if (cue.look.attrs && Object.keys(cue.look.attrs).length === 0) delete cue.look.attrs;
    touched += 1;
  }
  return touched;
}

/**
 * 在轨道上新建一个外观片段（属性特效、预设拖放等）。
 *
 * 起点对齐到帧；长度不会越过后一个片段或节目末尾。场景轨道不接受外观片段。
 *
 * @param draft 工程草稿。
 * @param trackId 目标轨道。
 * @param startMs 期望起点。
 * @param look 外观（会被深拷贝）。
 * @param lengthMs 期望长度。
 * @param spread 多灯分布。
 * @returns 新片段 id；放不下时为 `null`。
 */
export function addLookCue(
  draft: ShowProject,
  trackId: string,
  startMs: number,
  look: Look,
  lengthMs: number,
  spread?: Spread,
): string | null {
  const track = draft.tracks.find((t) => t.id === trackId);
  if (!track || track.lock || track.target.kind === "scene") return null;
  const start = clamp(snapToFrame(startMs), 0, draft.durationMs);
  const gap = gapAround(draft, trackId, start);
  if (!gap) return null;
  const end = Math.min(start + lengthMs, gap[1]);
  if (end - start < MIN_CUE_MS) return null;
  const cue: Cue = {
    id: newId(),
    kind: "look",
    trackId,
    startMs: start,
    endMs: end,
    brightness: 100,
    fadeInMs: 0,
    fadeOutMs: 0,
    easing: "linear",
    look: structuredClone(look),
    ...(spread ? { spread: structuredClone(spread) } : {}),
  };
  draft.cues.push(cue);
  return cue.id;
}

/**
 * 把一个片段原地换成外观片段（时间、亮度、淡入淡出与轨道不变），用于把旧特效迁移到属性特效。
 *
 * @param draft 工程草稿。
 * @param id 片段 id。
 * @param look 新外观（会被深拷贝）。
 * @param spread 新分布。
 * @returns 是否替换（片段不存在、在场景轨道上或轨道锁定时为 `false`）。
 */
export function replaceWithLook(draft: ShowProject, id: string, look: Look, spread?: Spread): boolean {
  const index = draft.cues.findIndex((c) => c.id === id);
  const cue = draft.cues[index];
  if (!cue || cue.kind === "scene" || !editableTrack(draft, cue.trackId)) return false;
  const { id: cueId, trackId, startMs, endMs, brightness, fadeInMs, fadeOutMs, easing } = cue;
  draft.cues[index] = {
    id: cueId,
    trackId,
    startMs,
    endMs,
    brightness,
    fadeInMs,
    fadeOutMs,
    easing,
    kind: "look",
    look: structuredClone(look),
    ...(spread ? { spread: structuredClone(spread) } : {}),
  };
  return true;
}

/**
 * 设置外观片段的多灯分布（`undefined` 为不分布）。
 *
 * @param draft 工程草稿。
 * @param ids 片段 id（非外观片段忽略）。
 * @param spread 分布。
 * @returns 实际被修改的片段数。
 */
export function setSpread(draft: ShowProject, ids: readonly string[], spread: Spread | undefined): number {
  const wanted = new Set(ids);
  let n = 0;
  for (const cue of draft.cues) {
    if (cue.kind !== "look" || !wanted.has(cue.id) || !editableTrack(draft, cue.trackId)) continue;
    if (spread) cue.spread = structuredClone(spread);
    else delete cue.spread;
    n += 1;
  }
  return n;
}

/**
 * 修改场景片段的条目（锁定轨道上的不动）。条目删空时片段保留（之后可以用编程器重新填）。
 *
 * @param draft 工程草稿。
 * @param id 场景片段 id。
 * @param entries 新条目（会被深拷贝）。
 * @returns 是否修改。
 */
export function setSceneEntries(
  draft: ShowProject,
  id: string,
  entries: readonly { fixtureId: string; look: Look }[],
): boolean {
  const cue = draft.cues.find((c) => c.id === id);
  if (cue?.kind !== "scene" || !editableTrack(draft, cue.trackId)) return false;
  cue.entries = structuredClone([...entries]);
  return true;
}

/**
 * 把静态 Cue 转成外观片段（颜色变成 RGB 意图、强度 100%，亮度 / 淡入淡出 / 时间不变），
 * 之后就能给强度、颜色打关键帧、加属性层。
 *
 * @param draft 工程草稿。
 * @param ids 片段 id（非静态 Cue 忽略）。
 * @returns 转换的数量。
 */
export function convertToLook(draft: ShowProject, ids: readonly string[]): number {
  const wanted = new Set(ids);
  let n = 0;
  draft.cues = draft.cues.map((cue) => {
    if (cue.kind !== "static" || !wanted.has(cue.id) || !editableTrack(draft, cue.trackId)) return cue;
    n += 1;
    const { rgb, ...base } = cue;
    return {
      ...base,
      kind: "look",
      look: { intensity: { kind: "value", value: 100 }, color: { kind: "value", value: { kind: "rgb", rgb: [...rgb] } } },
    } satisfies Cue;
  });
  return n;
}

/** 一个片段的新位置（时间线拖动的结果）。 */
export interface CuePlacement {
  id: string;
  trackId: string;
  startMs: number;
  endMs: number;
}

/**
 * 轨道能否放这个片段：场景片段只能放在场景轨道上，其它片段只能放在灯具 / 分组轨道上。
 *
 * @param track 轨道。
 * @param cue 片段。
 * @returns 能放时为 `true`。
 */
export function trackAccepts(track: Pick<Track, "target">, cue: Pick<Cue, "kind">): boolean {
  return (track.target.kind === "scene") === (cue.kind === "scene");
}

/**
 * 校验一组片段的新位置（不修改工程）。
 *
 * 规则：起止对齐到帧、在 `[0, durationMs]` 内、不短于 [`MIN_CUE_MS`]；源轨道和目标轨道都未锁定且接受该片段；
 * 不与未移动的片段重叠，移动的片段之间也不重叠。
 *
 * @param project 工程（只读）。
 * @param placements 新位置。
 * @returns 对齐后的位置；任何一个不合法时为 `null`。
 */
export function checkPlacements(
  project: Pick<ShowProject, "cues" | "tracks" | "durationMs">,
  placements: readonly CuePlacement[],
): CuePlacement[] | null {
  const moving = new Set(placements.map((p) => p.id));
  const tracks = new Map(project.tracks.map((t) => [t.id, t]));
  const cues = new Map(project.cues.map((c) => [c.id, c]));
  const out: CuePlacement[] = [];
  for (const p of placements) {
    const cue = cues.get(p.id);
    const from = cue ? tracks.get(cue.trackId) : undefined;
    const to = tracks.get(p.trackId);
    if (!cue || !from || !to || from.lock || to.lock || !trackAccepts(to, cue)) return null;
    const startMs = snapToFrame(p.startMs);
    const endMs = snapToFrame(p.endMs);
    if (startMs < 0 || endMs > project.durationMs || endMs - startMs < MIN_CUE_MS) return null;
    out.push({ id: p.id, trackId: p.trackId, startMs, endMs });
  }
  for (const p of out) {
    const hit = project.cues.some(
      (c) => !moving.has(c.id) && c.trackId === p.trackId && c.startMs < p.endMs && p.startMs < c.endMs,
    );
    if (hit) return null;
    const self = out.some((q) => q !== p && q.trackId === p.trackId && q.startMs < p.endMs && p.startMs < q.endMs);
    if (self) return null;
  }
  return out;
}

/**
 * 把一组片段放到新位置（拖动 / 拉伸 / 换轨），整组要么全部生效，要么全部不动。
 *
 * 只改起点而长度也变了（从左边裁剪）时，外观片段的关键帧按新起点重新计时，保持画面在绝对时间上不动。
 *
 * @param draft 工程草稿。
 * @param placements 新位置。
 * @returns 是否生效。
 */
export function placeCues(draft: ShowProject, placements: readonly CuePlacement[]): boolean {
  const checked = checkPlacements(draft, placements);
  if (!checked || checked.length === 0) return false;
  for (const p of checked) {
    const cue = draft.cues.find((c) => c.id === p.id);
    if (!cue) continue;
    const trimmedStart = p.startMs !== cue.startMs && p.endMs - p.startMs !== cue.endMs - cue.startMs;
    if (trimmedStart) {
      const delta = cue.startMs - p.startMs;
      if (cue.kind === "look") shiftLookKeys(cue.look, delta);
      if (cue.kind === "scene") for (const e of cue.entries) shiftLookKeys(e.look, delta);
    }
    cue.trackId = p.trackId;
    cue.startMs = p.startMs;
    cue.endMs = p.endMs;
    normalizeFades(cue);
  }
  return true;
}

/** 把外观里关键帧的时间整体平移（片段被分割后，右半段的关键帧相对新起点）。 */
function shiftLookKeys(look: Look, deltaMs: number): void {
  const shift = <T>(p: Param<T> | undefined) => {
    if (p?.kind !== "keys") return;
    p.keys = p.keys.map((k) => ({ ...k, tMs: Math.max(0, k.tMs + deltaMs) }));
  };
  shift(look.intensity);
  shift(look.color);
  for (const p of Object.values(look.attrs ?? {})) shift(p);
}

/**
 * 在 `atMs` 处把片段一分为二（剪映的“分割”，Ctrl+B）。
 *
 * 只分割包含该时刻、且两段都不短于 [`MIN_CUE_MS`] 的片段；锁定轨道上的不动。
 * 左段保留淡入、去掉淡出，右段去掉淡入、保留淡出；外观片段的关键帧按新起点重新计时。
 *
 * @param draft 工程草稿。
 * @param ids 候选片段。
 * @param atMs 分割时刻（对齐到帧）。
 * @returns 新建的右半段 id。
 */
export function splitCues(draft: ShowProject, ids: readonly string[], atMs: number): string[] {
  const at = snapToFrame(atMs);
  const wanted = new Set(ids);
  const created: string[] = [];
  for (const cue of [...draft.cues]) {
    if (!wanted.has(cue.id) || !editableTrack(draft, cue.trackId)) continue;
    if (at - cue.startMs < MIN_CUE_MS || cue.endMs - at < MIN_CUE_MS) continue;
    // immer 草稿是 Proxy，不能直接 structuredClone，先取出当前快照
    const right = structuredClone(isDraft(cue) ? current(cue) : cue) as Cue;
    right.id = newId();
    right.startMs = at;
    right.fadeInMs = 0;
    cue.endMs = at;
    cue.fadeOutMs = 0;
    normalizeFades(cue);
    normalizeFades(right);
    const offset = at - cue.startMs;
    if (right.kind === "look") shiftLookKeys(right.look, -offset);
    if (right.kind === "scene") for (const e of right.entries) shiftLookKeys(e.look, -offset);
    draft.cues.push(right);
    created.push(right.id);
  }
  return created;
}

/**
 * 波纹删除：删除片段，并把同一轨道上其后的片段前移，填上空出的时间。
 *
 * @param draft 工程草稿。
 * @param ids 要删除的片段。
 * @returns 实际删除的数量。
 */
export function rippleDeleteCues(draft: ShowProject, ids: readonly string[]): number {
  const gone = draft.cues.filter((c) => ids.includes(c.id) && editableTrack(draft, c.trackId));
  for (const g of [...gone].sort((a, b) => b.startMs - a.startMs)) {
    const length = g.endMs - g.startMs;
    draft.cues = draft.cues.filter((c) => c.id !== g.id);
    for (const c of draft.cues) {
      if (c.trackId === g.trackId && c.startMs >= g.endMs) {
        c.startMs -= length;
        c.endMs -= length;
      }
    }
  }
  return gone.length;
}

/**
 * 选中播放头之后的片段（剪映的“选中后面所有”）。
 *
 * @param project 工程（只读）。
 * @param atMs 播放头位置。
 * @param trackId 只看这条轨道；`null` 为全部轨道。
 * @returns 起点不早于 `atMs` 的片段 id。
 */
export function cuesAfter(project: Pick<ShowProject, "cues">, atMs: number, trackId: string | null): string[] {
  return project.cues.filter((c) => c.startMs >= atMs && (trackId === null || c.trackId === trackId)).map((c) => c.id);
}

/**
 * 包含播放头的片段（没有选中片段时，分割作用于它们）。
 *
 * @param project 工程（只读）。
 * @param atMs 播放头位置。
 * @param trackId 只看这条轨道；`null` 为全部轨道。
 * @returns 片段 id。
 */
export function cuesAt(project: Pick<ShowProject, "cues">, atMs: number, trackId: string | null): string[] {
  return project.cues
    .filter((c) => c.startMs < atMs && atMs < c.endMs && (trackId === null || c.trackId === trackId))
    .map((c) => c.id);
}

/**
 * 轨道上按起点排序的 Cue。
 *
 * @param project 工程（只读）。
 * @param trackId 轨道 id。
 */
export function cuesOfTrack(project: Pick<ShowProject, "cues">, trackId: string): Cue[] {
  return project.cues.filter((c) => c.trackId === trackId).sort((a, b) => a.startMs - b.startMs);
}
