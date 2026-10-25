/**
 * 校验 IPv4 文本（四段 0~255 的十进制数）。
 *
 * @param text 用户输入。
 * @returns 合法返回 true。
 */
export function isValidIpv4(text: string): boolean {
  const parts = text.trim().split(".");
  return (
    parts.length === 4 &&
    parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
  );
}