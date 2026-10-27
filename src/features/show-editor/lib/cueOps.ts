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
  type Rgb,
  type ShowProject,
  type StaticCue,
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
 * 轨道上按起点排序的 Cue。
 *
 * @param project 工程（只读）。
 * @param trackId 轨道 id。
 */
export function cuesOfTrack(project: Pick<ShowProject, "cues">, trackId: string): Cue[] {
  return project.cues.filter((c) => c.trackId === trackId).sort((a, b) => a.startMs - b.startMs);
}
