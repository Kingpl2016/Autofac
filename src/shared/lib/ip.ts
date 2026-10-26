/** IP 地址相关的通用辅助。 */

/** 解析点分十进制 IPv4；不是合法 IPv4 时返回 `null`。 */
function parseIpv4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN));
  return nums.every((n) => n >= 0 && n <= 255) ? nums : null;
}

/**
 * IP 地址的自然排序比较器：IPv4 按数值逐段比较（`10.0.0.2` 排在 `10.0.0.10` 之前），
 * IPv4 排在其它字符串之前，其它字符串按字典序。
 *
 * @param a 第一个 IP 字符串。
 * @param b 第二个 IP 字符串。
 * @returns 负数表示 `a` 在前，正数表示 `b` 在前，0 表示相同。
 */
export function compareIp(a: string, b: string): number {
  const pa = parseIpv4(a);
  const pb = parseIpv4(b);
  if (pa && pb) {
    for (let i = 0; i < 4; i += 1) {
      if (pa[i] !== pb[i]) return pa[i] - pb[i];
    }
    return 0;
  }
  if (pa) return -1;
  if (pb) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
/**
 * 校验 IPv4 文本（四段 0~255 的十进制数，允许首尾空白）。
 *
 * @param text 用户输入。
 * @returns 合法返回 true。
 */
export function isValidIpv4(text: string): boolean {
  const parts = text.trim().split(".");
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}