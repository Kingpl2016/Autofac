import { clamp } from "@/shared/lib/math";
import { periodMs } from "./effects";
import type { CycleTiming, Period, Tempo, ValueCurve } from "./project";

/**
 * 数值曲线 / 颜色序列的周期设置（界面辅助）：在“片段内次数”与“按时间计的周期”之间切换时保持速度不变，
 * 解析 / 格式化步进值，规整高级参数。
 *
 * 取值本身只在引擎（show-engine）里实现。
 */

/** 周期的设置方式：片段内次数、毫秒、拍。 */
export type PeriodMode = "cycles" | "ms" | "beats";

/** 周期设置方式（按钮顺序）。 */
export const PERIOD_MODES: readonly PeriodMode[] = ["cycles", "ms", "beats"];

/** 拍数的范围（与工程校验一致）。 */
export const PERIOD_BEATS_RANGE = { min: 0.0625, max: 128 } as const;

/** 毫秒周期的范围（与工程校验一致）。 */
export const PERIOD_MS_RANGE = { min: 20, max: 600_000 } as const;

/** 步进值最多几步。 */
export const MAX_STEPS = 64;

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * 当前的周期设置方式。
 *
 * @param timing 计时。
 * @returns 方式。
 */
export function periodModeOf(timing: Pick<CycleTiming, "period">): PeriodMode {
  return timing.period?.kind ?? "cycles";
}

/**
 * 一个周期的毫秒数（片段内次数按片段长度换算）。
 *
 * @param timing 计时。
 * @param lengthMs 片段长度。
 * @param tempo 工程节拍。
 * @returns 毫秒。
 */
export function cyclePeriodMs(timing: Pick<CycleTiming, "period" | "cycles">, lengthMs: number, tempo: Tempo | null): number {
  if (timing.period) return periodMs(timing.period, tempo);
  return Math.max(1, lengthMs) / Math.max(1, timing.cycles);
}

/**
 * 切换周期设置方式，保持当前速度（换算后取整到两位小数，并夹在允许范围内）。
 *
 * @param timing 当前计时。
 * @param mode 新方式。
 * @param ctx 片段长度与工程节拍。
 * @returns 要合并进计时的字段（`period` 为 `undefined` 表示改回片段内次数）。
 */
export function withPeriodMode(
  timing: Pick<CycleTiming, "period" | "cycles">,
  mode: PeriodMode,
  ctx: { lengthMs: number; tempo: Tempo | null },
): Pick<CycleTiming, "period" | "cycles"> {
  const ms = cyclePeriodMs(timing, ctx.lengthMs, ctx.tempo);
  if (mode === "cycles") return { period: undefined, cycles: clamp(round2(Math.max(1, ctx.lengthMs) / ms), 1, 1000) };
  if (mode === "ms") return { period: { kind: "ms", ms: clamp(Math.round(ms), PERIOD_MS_RANGE.min, PERIOD_MS_RANGE.max) }, cycles: timing.cycles };
  const beatMs = periodMs({ kind: "beats", beats: 1 }, ctx.tempo);
  return {
    period: { kind: "beats", beats: clamp(round2(ms / beatMs), PERIOD_BEATS_RANGE.min, PERIOD_BEATS_RANGE.max) },
    cycles: timing.cycles,
  };
}

/**
 * 规整一个周期（夹在允许范围内）。
 *
 * @param period 周期。
 * @returns 规整后的周期。
 */
export function clampPeriod(period: Period): Period {
  return period.kind === "ms"
    ? { kind: "ms", ms: clamp(Math.round(period.ms), PERIOD_MS_RANGE.min, PERIOD_MS_RANGE.max) }
    : { kind: "beats", beats: clamp(round2(period.beats), PERIOD_BEATS_RANGE.min, PERIOD_BEATS_RANGE.max) };
}

/**
 * 解析步进值：逗号或空格分隔的百分比（0~100），例如 `100, 0, 0, 100`。
 *
 * @param text 输入。
 * @returns 每一步的分数（0~1）；没有合法的数或超过 {@link MAX_STEPS} 步时为 `null`。
 */
export function parseSteps(text: string): number[] | null {
  const parts = text.split(/[\s,，;；]+/).filter((s) => s !== "");
  if (parts.length === 0 || parts.length > MAX_STEPS) return null;
  const out: number[] = [];
  for (const p of parts) {
    const n = Number(p.replace(/%$/, ""));
    if (!Number.isFinite(n)) return null;
    out.push(Math.round(clamp(n, 0, 100) * 100) / 10_000);
  }
  return out;
}

/**
 * 步进值的显示文本（百分比，逗号分隔）。
 *
 * @param steps 每一步的分数。
 * @returns 文本。
 */
export function formatSteps(steps: readonly number[]): string {
  return steps.map((v) => String(Math.round(v * 10_000) / 100)).join(", ");
}

/** 新建步进波形时的默认步进（亮一步、暗三步：沿分组追逐）。 */
export const DEFAULT_STEPS: readonly number[] = [1, 0, 0, 0];

/**
 * 随机种子：0 ~ 2^32-1 的整数。
 *
 * @param random 随机源（测试时注入）。
 * @returns 种子。
 */
export function randomSeed(random: () => number = Math.random): number {
  return Math.floor(random() * 0xffff_ffff) >>> 0;
}

/**
 * 规整曲线的高级参数：过渡、占空比夹在 0~1，步进值不超过 {@link MAX_STEPS} 步，种子为 32 位无符号整数，
 * 周期夹在允许范围内；值为 `undefined` 的可选字段删除（不写进工程）。
 *
 * @param c 曲线。
 * @returns 规整后的曲线（新对象）。
 */
export function sanitizeCurve(c: ValueCurve): ValueCurve {
  const out: ValueCurve = { ...c };
  if (out.transition !== undefined) out.transition = clamp(out.transition, 0, 1);
  if (out.duty !== undefined) out.duty = clamp(out.duty, 0, 1);
  if (out.steps !== undefined) out.steps = out.steps.slice(0, MAX_STEPS).map((v) => clamp(v, 0, 1));
  if (out.seed !== undefined) out.seed = Math.floor(Math.abs(out.seed)) >>> 0;
  if (out.period) out.period = clampPeriod(out.period);
  for (const key of Object.keys(out) as (keyof ValueCurve)[]) if (out[key] === undefined) delete out[key];
  return out;
}
