/** 表单的本地校验（规则镜像 Rust `netdev::validate`），返回 i18n 键；通过返回 `null`。 */

/**
 * 校验主机：IPv4 或主机名（字母数字、点、连字符），不得带协议 / 端口 / 路径。
 *
 * # Arguments
 *
 * * `host` - 用户输入。
 *
 * # Returns
 *
 * 校验失败时的 i18n 键；通过返回 `null`。
 */
export function validateHost(host: string): string | null {
  const h = host.trim();
  if (!h) return "network.form.hostRequired";
  const shape = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(h) && !h.includes("..");
  if (!shape) return "network.form.hostInvalid";
  if (/^[0-9.]+$/.test(h)) {
    const parts = h.split(".");
    const ok = parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
    if (!ok) return "network.form.hostInvalid";
  }
  return null;
}

/**
 * 校验端口（1~65535 的整数）。
 *
 * # Arguments
 *
 * * `port` - 端口。
 *
 * # Returns
 *
 * 失败的 i18n 键，或 `null`。
 */
export function validatePort(port: number): string | null {
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? null : "network.form.portInvalid";
}

/**
 * 校验设备名称（至多 40 个字符，可为空）。
 *
 * # Arguments
 *
 * * `name` - 名称。
 *
 * # Returns
 *
 * 失败的 i18n 键，或 `null`。
 */
export function validateName(name: string): string | null {
  return [...name.trim()].length <= 40 ? null : "network.form.nameTooLong";
}

/**
 * 校验设备上的节目文件名（规则镜像固件）：以 `.artrec` 结尾、UTF-8 不超过 128 字节、
 * 不含路径分隔符、`..` 与控制字符。
 *
 * # Arguments
 *
 * * `name` - 文件名。
 *
 * # Returns
 *
 * 失败的 i18n 键，或 `null`。
 */
export function validateProgramFileName(name: string): string | null {
  if (name === "") return "network.files.nameEmpty";
  if (new TextEncoder().encode(name).length > 128) return "network.files.nameTooLong";
  // eslint-disable-next-line no-control-regex
  if (/[/\\]/.test(name) || name.includes("..") || /[\u0000-\u001f\u007f]/.test(name)) {
    return "network.files.nameChars";
  }
  if (!/\.artrec$/i.test(name) || name.length === ".artrec".length) return "network.files.nameExt";
  return null;
}

/**
 * 校验 Bearer Token：空串（不设置 / 清除）或 8~64 位可见 ASCII。
 *
 * # Arguments
 *
 * * `token` - Token 明文。
 *
 * # Returns
 *
 * 失败的 i18n 键，或 `null`。
 */
export function validateToken(token: string): string | null {
  if (token === "") return null;
  return /^[\x21-\x7e]{8,64}$/.test(token) ? null : "network.form.tokenInvalid";
}
