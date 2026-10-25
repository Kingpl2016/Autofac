/** Dashboard 展示用的格式化辅助。 */

/**
 * 将秒数格式化为 `h:mm:ss` 或 `mm:ss`。
 *
 * @param sec 秒数。
 * @returns 可读时长字符串。
 */
export function formatUptime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
