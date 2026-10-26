/**
 * 把字节数组编码为标准 Base64（后端的概览矩阵就是以 Base64 字符串传给前端的）。
 *
 * # Arguments
 *
 * * `bytes` - 待编码的字节。
 *
 * # Returns
 *
 * Base64 文本。
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
