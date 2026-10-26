/** 有信号的边数量超过该值时不再画流动粒子，避免大图下动画拖慢页面。 */
export const PARTICLE_ACTIVE_EDGE_LIMIT = 80;

/** 粒子沿边移动的速度（像素 / 秒）。基于时间而不是帧数，高刷新率屏幕上也一样快。 */
export const PARTICLE_SPEED = 120;

/** 单趟时长的上下限（秒），避免极短的边闪烁、极长的边几乎不动。 */
const MIN_TRIP_S = 1.5;
const MAX_TRIP_S = 6;

/**
 * 是否绘制流动粒子。
 *
 * @param reducedMotion 用户是否开启了“减少动态效果”。
 * @param activeEdges 当前有信号的边数。
 * @returns 减少动态效果时一律不画；有信号的边过多时同样不画。
 */
export function shouldAnimateParticles(reducedMotion: boolean, activeEdges: number): boolean {
  return !reducedMotion && activeEdges <= PARTICLE_ACTIVE_EDGE_LIMIT;
}

/**
 * 粒子沿一条边走完全程所需的秒数，与边的水平跨度成正比（速度恒定）。
 *
 * @param distance 边起点到终点的水平距离（像素）；取绝对值。
 * @returns 秒数，限制在 1.5 到 6 之间。
 */
export function particleDuration(distance: number): number {
  const d = Math.abs(Number.isFinite(distance) ? distance : 0);
  return Math.min(MAX_TRIP_S, Math.max(MIN_TRIP_S, d / PARTICLE_SPEED));
}