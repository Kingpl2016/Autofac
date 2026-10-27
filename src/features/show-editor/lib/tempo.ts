import type { Tempo } from "./project";

/** BPM 的合法范围。 */
export const MIN_BPM = 20;
export const MAX_BPM = 300;

/** 两次敲击间隔超过这个时间（毫秒）就认为是重新开始计拍。 */
export const TAP_RESET_MS = 2000;

/** 计算 BPM 最多参考最近几次敲击。 */
const TAP_WINDOW = 8;

/** 时间线上的一拍。 */
export interface Beat {
  /** 拍点时间（毫秒） */
  timeMs: number;
  /** 拍序号（从 `offsetMs` 处的第 0 拍起算，可为负） */
  index: number;
  /** 是否为小节线（每 `beatsPerBar` 拍一次） */
  isBar: boolean;
}

/**
 * 一拍的时长。
 *
 * @param bpm 每分钟拍数。
 * @returns 毫秒。
 */
export function beatDurationMs(bpm: number): number {
  return 60_000 / bpm;
}

/**
 * 列出 `[fromMs, toMs]` 内的拍点。
 *
 * @param tempo 节拍设置。
 * @param fromMs 区间起点（毫秒）。
 * @param toMs 区间终点（毫秒）。
 * @param max 最多返回多少拍，防止缩得很小时生成海量线条。
 * @returns 按时间升序的拍点；时间小于 0 的拍点不返回。
 */
export function beatsBetween(tempo: Tempo, fromMs: number, toMs: number, max = 4000): Beat[] {
  const dur = beatDurationMs(tempo.bpm);
  const first = Math.ceil((Math.max(0, fromMs) - tempo.offsetMs) / dur);
  const last = Math.floor((toMs - tempo.offsetMs) / dur);
  const beats: Beat[] = [];
  for (let k = first; k <= last && beats.length < max; k += 1) {
    const timeMs = Math.round(tempo.offsetMs + k * dur);
    if (timeMs < 0) continue;
    const inBar = ((k % tempo.beatsPerBar) + tempo.beatsPerBar) % tempo.beatsPerBar;
    beats.push({ timeMs, index: k, isBar: inBar === 0 });
  }
  return beats;
}

/**
 * 由一串敲击时刻估算 BPM（Tap Tempo）。
 *
 * 只使用最近一次“连续敲击”（相邻间隔不超过 [`TAP_RESET_MS`]）里最后 8 次，取平均间隔。
 *
 * @param tapsMs 敲击时刻（毫秒，按先后顺序）。
 * @returns BPM，保留一位小数并夹在合法范围内；不足两次连续敲击时为 `null`。
 */
export function tapTempo(tapsMs: readonly number[]): number | null {
  let start = 0;
  for (let i = 1; i < tapsMs.length; i += 1) {
    if (tapsMs[i] - tapsMs[i - 1] > TAP_RESET_MS) start = i;
  }
  const run = tapsMs.slice(start).slice(-TAP_WINDOW);
  if (run.length < 2) return null;
  const interval = (run[run.length - 1] - run[0]) / (run.length - 1);
  if (interval <= 0) return null;
  const bpm = Math.round((60_000 / interval) * 10) / 10;
  return Math.min(MAX_BPM, Math.max(MIN_BPM, bpm));
}

/**
 * 把“拍数”换算成毫秒（特效按拍设置周期时用）。
 *
 * @param beats 拍数。
 * @param bpm 每分钟拍数。
 */
export function beatsToMs(beats: number, bpm: number): number {
  return Math.round(beats * beatDurationMs(bpm));
}
