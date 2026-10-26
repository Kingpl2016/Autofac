/**
 * 确定性伪随机：同样的输入永远得到同样的结果。
 *
 * 演示数据（图案、抖动、概览矩阵）都要求“可重复”，这样同一个节目每次打开看到的热力图一致，
 * 也不依赖 `Math.random()`。
 */

/**
 * 整数哈希到 `[0, 1)`。
 *
 * # Arguments
 *
 * * `n` - 任意整数种子（超出 32 位会被截断）。
 *
 * # Returns
 *
 * 落在 `[0, 1)` 的伪随机数。
 */
export function hash01(n: number): number {
  let x = (n | 0) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/**
 * 把字符串哈希为整数种子（用于由 IP、路径等文本派生稳定的数值）。
 *
 * # Arguments
 *
 * * `text` - 任意文本。
 *
 * # Returns
 *
 * 32 位非负整数。
 */
export function hashText(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 一维平滑值噪声（三次插值），输出 `[0, 1]`。
 *
 * # Arguments
 *
 * * `x` - 连续坐标。
 * * `seed` - 噪声种子。
 *
 * # Returns
 *
 * 随 `x` 连续变化的噪声值。
 */
export function smoothNoise(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const a = hash01(Math.imul(i, 374761393) + seed);
  const b = hash01(Math.imul(i + 1, 374761393) + seed);
  const u = f * f * (3 - 2 * f);
  return a + (b - a) * u;
}

/**
 * 围绕基准值的平滑抖动：在 `[base*(1-ratio), base*(1+ratio)]` 内缓慢波动。
 *
 * # Arguments
 *
 * * `base` - 基准值。
 * * `ratio` - 相对波动幅度（如 `0.05` 为 ±5%）。
 * * `tSec` - 时间（秒）。
 * * `seed` - 区分不同数据流的种子。
 *
 * # Returns
 *
 * 抖动后的值。
 */
export function wobble(base: number, ratio: number, tSec: number, seed: number): number {
  return base * (1 + (smoothNoise(tSec * 0.8, seed) - 0.5) * 2 * ratio);
}
