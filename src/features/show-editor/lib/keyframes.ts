import { fixed } from "./looks";
import type { Curve, CycleParam, Keyframe, Look, Param } from "./project";

/** 关键帧编辑接受的参数：普通参数，或颜色序列（没有关键帧；打帧 / 改值时换成关键帧或固定值）。 */
type AnyParam<T> = Param<T> | CycleParam<T>;

/**
 * 关键帧编辑（剪映式）：每个参数旁一个 ◆，在播放头处打 / 删关键帧；参数已有关键帧时，改值自动在播放头处打帧。
 *
 * 只做数据编辑；取值（插值、曲线）由引擎完成（`Engine.sampleNum`），这里不重复实现。
 * 时间都是相对片段起点的毫秒。
 */

/** 两个关键帧在这个距离内视为同一帧（半帧，30 FPS）。 */
export const KEY_EPSILON_MS = 17;

/**
 * 参数的关键帧（固定值 / 曲线没有关键帧）。
 *
 * @param p 参数。
 * @returns 关键帧（按时间升序）。
 */
export function keysOf<T>(p: AnyParam<T> | undefined): Keyframe<T>[] {
  return p?.kind === "keys" ? p.keys : [];
}

/**
 * `uMs` 处是否有关键帧。
 *
 * @param p 参数。
 * @param uMs 片段内时刻。
 * @returns 有时为 `true`。
 */
export function hasKeyAt<T>(p: AnyParam<T> | undefined, uMs: number): boolean {
  return keysOf(p).some((k) => Math.abs(k.tMs - uMs) <= KEY_EPSILON_MS);
}

/** 按时间排序并合并距离过近的关键帧（后写入的胜出）。 */
function normalized<T>(keys: readonly Keyframe<T>[]): Keyframe<T>[] {
  const sorted = [...keys].sort((a, b) => a.tMs - b.tMs);
  const out: Keyframe<T>[] = [];
  for (const k of sorted) {
    const last = out.at(-1);
    if (last && Math.abs(last.tMs - k.tMs) <= KEY_EPSILON_MS) out[out.length - 1] = k;
    else out.push(k);
  }
  return out;
}

/**
 * 在 `uMs` 处设置一个关键帧（已有则改值，保留它的曲线）。固定值 / 曲线参数会变成关键帧参数。
 *
 * @param p 参数（可缺省）。
 * @param uMs 片段内时刻（取整，不小于 0）。
 * @param value 关键帧的值。
 * @param curve 新关键帧到下一帧的插值方式。
 * @returns 新参数。
 */
export function setKeyAt<T>(p: AnyParam<T> | undefined, uMs: number, value: T, curve: Curve = "linear"): Param<T> {
  const t = Math.max(0, Math.round(uMs));
  const keys = keysOf(p);
  const existing = keys.find((k) => Math.abs(k.tMs - t) <= KEY_EPSILON_MS);
  const next = existing
    ? keys.map((k) => (k === existing ? { ...k, value } : k))
    : [...keys, { tMs: t, value, curve }];
  return { kind: "keys", keys: normalized(next) } as Param<T>;
}

/**
 * 删除 `uMs` 处的关键帧；只剩一帧时退回固定值（取剩下那帧的值），一帧都不剩时取被删那帧的值。
 *
 * @param p 参数。
 * @param uMs 片段内时刻。
 * @returns 新参数；那里没有关键帧时原样返回。
 */
export function removeKeyAt<T>(p: Param<T>, uMs: number): Param<T> {
  const keys = keysOf(p);
  const gone = keys.find((k) => Math.abs(k.tMs - uMs) <= KEY_EPSILON_MS);
  if (!gone) return p;
  const rest = keys.filter((k) => k !== gone);
  if (rest.length === 0) return fixed(gone.value);
  if (rest.length === 1) return fixed(rest[0].value);
  return { kind: "keys", keys: rest } as Param<T>;
}

/**
 * 打 / 删关键帧（◆ 按钮）。
 *
 * @param p 参数（可缺省）。
 * @param uMs 片段内时刻。
 * @param current 播放头处当前显示的值（打帧时用它）。
 * @returns 新参数。
 */
export function toggleKeyAt<T>(p: AnyParam<T> | undefined, uMs: number, current: T): Param<T> {
  return p?.kind === "keys" && hasKeyAt(p, uMs) ? removeKeyAt(p, uMs) : setKeyAt(p, uMs, current);
}

/**
 * 改值：参数已有关键帧时在播放头处打帧（剪映的自动关键帧），否则改成固定值。
 *
 * @param p 参数（可缺省）。
 * @param uMs 片段内时刻。
 * @param value 新值。
 * @returns 新参数。
 */
export function setValueAt<T>(p: AnyParam<T> | undefined, uMs: number, value: T): Param<T> {
  return p?.kind === "keys" && p.keys.length > 0 ? setKeyAt(p, uMs, value) : fixed(value);
}

/**
 * 修改 `uMs` 所在区段的插值方式（即它之前最近那一帧的 `curve`）。
 *
 * @param p 参数。
 * @param uMs 片段内时刻。
 * @param curve 插值方式。
 * @returns 新参数；没有关键帧时原样返回。
 */
export function setSegmentCurve<T>(p: Param<T>, uMs: number, curve: Curve): Param<T> {
  const keys = keysOf(p);
  if (keys.length === 0) return p;
  let index = 0;
  keys.forEach((k, i) => {
    if (k.tMs <= uMs + KEY_EPSILON_MS) index = i;
  });
  return { kind: "keys", keys: keys.map((k, i) => (i === index ? { ...k, curve } : k)) } as Param<T>;
}

/**
 * `uMs` 所在区段的插值方式。
 *
 * @param p 参数。
 * @param uMs 片段内时刻。
 * @returns 插值方式；没有关键帧时为 `null`。
 */
export function segmentCurve<T>(p: AnyParam<T> | undefined, uMs: number): Curve | null {
  const keys = keysOf(p);
  if (keys.length === 0) return null;
  let curve = keys[0].curve;
  for (const k of keys) if (k.tMs <= uMs + KEY_EPSILON_MS) curve = k.curve;
  return curve;
}

/**
 * 关键帧之间的导航：`uMs` 之前（`-1`）/ 之后（`1`）最近的一帧。
 *
 * @param times 关键帧时刻（升序）。
 * @param uMs 片段内时刻。
 * @param direction 方向。
 * @returns 时刻；没有时为 `null`。
 */
export function adjacentKey(times: readonly number[], uMs: number, direction: 1 | -1): number | null {
  if (direction === 1) return times.find((t) => t > uMs + KEY_EPSILON_MS) ?? null;
  for (let i = times.length - 1; i >= 0; i -= 1) if (times[i] < uMs - KEY_EPSILON_MS) return times[i];
  return null;
}

/**
 * 外观里所有层的关键帧时刻（去重、升序），时间线上画 ◆ 用。
 *
 * @param look 外观。
 * @returns 时刻。
 */
export function lookKeyTimes(look: Look): number[] {
  const times = new Set<number>();
  for (const k of keysOf(look.intensity)) times.add(k.tMs);
  for (const k of keysOf(look.color)) times.add(k.tMs);
  for (const p of Object.values(look.attrs ?? {})) for (const k of keysOf(p)) times.add(k.tMs);
  return [...times].sort((a, b) => a - b);
}

/**
 * `uMs` 处（或之前最近一帧）的关键帧值，用于显示颜色等不在前端插值的参数。
 *
 * @param p 参数。
 * @param uMs 片段内时刻。
 * @returns 值；参数缺省时为 `undefined`。
 */
export function heldValueAt<T>(p: AnyParam<T> | undefined, uMs: number): T | undefined {
  if (!p) return undefined;
  if (p.kind === "value") return p.value;
  if (p.kind === "curve") return undefined;
  // 序列：显示第一个值（逐帧取值在引擎里）
  if (p.kind === "cycle") return p.cycle.colors[0];
  let v = p.keys[0]?.value;
  for (const k of p.keys) if (k.tMs <= uMs + KEY_EPSILON_MS) v = k.value;
  return v;
}
