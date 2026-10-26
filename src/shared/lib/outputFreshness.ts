/** 超过该时长没有收到 `engine:output` 事件，就认为输出统计已过期。 */
export const STALE_AFTER_MS = 5000;

/**
 * 判断输出统计是否过期。
 *
 * @param receivedAt 最近一次收到事件的时间戳；`null` 表示还没收到过。
 * @param now 当前时间戳。
 * @returns 已收到过事件、且距今不少于 {@link STALE_AFTER_MS} 时为 `true`。
 */
export function isOutputStale(receivedAt: number | null, now: number): boolean {
  return receivedAt !== null && now - receivedAt >= STALE_AFTER_MS;
}

/**
 * 把事件里的“距事件生成多久”换算成“距现在多久”。
 *
 * @param agoMs 事件生成时刻的“距今毫秒数”；`null` 原样返回。
 * @param receivedAt 收到事件的时间戳；`null` 时不做补偿。
 * @param now 当前时间戳。
 * @returns 补偿了事件在途时间的毫秒数。
 */
export function ageNow(
  agoMs: number | null,
  receivedAt: number | null,
  now: number,
): number | null {
  if (agoMs === null) return null;
  if (receivedAt === null) return agoMs;
  return agoMs + Math.max(0, now - receivedAt);
}