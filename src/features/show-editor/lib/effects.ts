import type { EffectCue, Tempo } from "./project";

/**
 * 特效相关的界面辅助：周期换算、频率显示与安全提示。
 *
 * 特效的逐灯具求值只在 show-engine（Rust，前端经 WASM 调用）里实现，这里不再镜像。
 */

/** 周期下限（毫秒）：低于一个输出帧没有意义。 */
export const MIN_PERIOD_MS = 33;

/** 没有节拍设置时按拍数换算所用的 BPM。 */
export const FALLBACK_BPM = 120;

/** 频闪的最高建议频率（Hz）：超过会让人不适，界面据此给出提醒。 */
export const MAX_SAFE_STROBE_HZ = 10;

/**
 * 把特效周期换算成毫秒（与后端 `period_ms` 一致）。
 *
 * @param period 周期：毫秒，或按 BPM 的拍数。
 * @param tempo 工程节拍；为空或 BPM 非法时按 {@link FALLBACK_BPM}。
 * @returns 毫秒周期，不小于 {@link MIN_PERIOD_MS}。
 */
export function periodMs(period: EffectCue["period"], tempo: Tempo | null): number {
  let ms: number;
  if (period.kind === "ms") {
    ms = period.ms;
  } else {
    const bpm = tempo && Number.isFinite(tempo.bpm) && tempo.bpm > 0 ? tempo.bpm : FALLBACK_BPM;
    ms = (period.beats * 60_000) / bpm;
  }
  return Number.isFinite(ms) ? Math.max(MIN_PERIOD_MS, ms) : MIN_PERIOD_MS;
}

/**
 * 特效的频率（每秒周期数），用于界面显示和频闪安全提示。
 *
 * @param period 周期。
 * @param tempo 工程节拍。
 * @returns 每秒周期数。
 */
export function effectRateHz(period: EffectCue["period"], tempo: Tempo | null): number {
  return 1000 / periodMs(period, tempo);
}
