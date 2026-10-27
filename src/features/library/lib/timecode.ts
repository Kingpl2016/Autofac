const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/**
 * 把微秒格式化为时间码：`m:ss.mmm`，一小时以上为 `h:mm:ss.mmm`。
 *
 * @param us 微秒（负数按 0 处理）。
 */
export function formatTimecode(us: number): string {
  const totalMs = Math.max(0, Math.round(us / 1000));
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}.${pad(ms, 3)}` : `${m}:${pad(s)}.${pad(ms, 3)}`;
}

/**
 * 解析用户输入的时间码，支持 `ss`、`ss.mmm`、`m:ss(.mmm)`、`h:mm:ss(.mmm)`；
 * 小数点也可以写成逗号。分、秒字段在有上级字段时须小于 60。
 *
 * @param text 输入文本。
 * @returns 微秒；无法解析时为 `null`。
 */
export function parseTimecode(text: string): number | null {
  const m = /^\s*(?:(?:(\d+):)?(\d+):)?(\d+)(?:[.,](\d{1,3}))?\s*$/.exec(text);
  if (!m) return null;
  const [, hh, mm, ss, frac] = m;
  const h = hh ? Number(hh) : 0;
  const min = mm ? Number(mm) : 0;
  const sec = Number(ss);
  if ((mm !== undefined && sec >= 60) || (hh !== undefined && min >= 60)) return null;
  const ms = frac ? Number(frac.padEnd(3, "0")) : 0;
  return ((h * 3600 + min * 60 + sec) * 1000 + ms) * 1000;
}
