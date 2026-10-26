import type { ConfigPatch, DeviceConfig } from "./types";

/** 表单里编辑的配置：设备配置去掉只读的 `tokenSet`（Token 另有独立字段）。 */
export type ConfigDraft = Omit<DeviceConfig, "tokenSet">;

/** 校验错误：字段 → i18n 键。 */
export type ConfigErrors = Partial<Record<keyof ConfigDraft, string>>;

/** 网络接入相关字段：改动后需重启生效。 */
export const NET_FIELDS: ReadonlyArray<keyof ConfigDraft> = ["dhcp", "ip", "netmask", "gateway", "hostname"];

/**
 * 由设备配置得到可编辑的草稿。
 *
 * # Arguments
 *
 * * `c` - 设备返回的配置。
 *
 * # Returns
 *
 * 去掉 `tokenSet` 的副本。
 */
export function toDraft(c: DeviceConfig): ConfigDraft {
  const { tokenSet: _tokenSet, ...rest } = c;
  return { ...rest };
}

/** 按固件 `parse_ipv4` 的规则判断：恰好 4 段，每段 1~3 位纯数字且不超过 255。 */
export function isIpv4(s: string): boolean {
  const parts = s.split(".");
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

const intIn = (v: number, min: number, max: number) => Number.isInteger(v) && v >= min && v <= max;

/**
 * 校验配置草稿（规则镜像固件 `config_validate.hpp`，任一非法固件会整体拒绝）。
 *
 * 静态地址（IP / 掩码 / 网关）只在关闭 DHCP 时校验；关闭 DHCP 时 IP 不能为 `0.0.0.0`。
 *
 * # Arguments
 *
 * * `d` - 草稿。
 *
 * # Returns
 *
 * 字段到 i18n 键的错误表；全部合法时为空对象。
 */
export function validateConfig(d: ConfigDraft): ConfigErrors {
  const e: ConfigErrors = {};
  if (!intIn(d.sacnPriority, 0, 200)) e.sacnPriority = "network.config.err.sacnPriority";
  if (!intIn(d.keepaliveMs, 0, 600_000)) e.keepaliveMs = "network.config.err.keepaliveMs";
  if (!intIn(d.forwardUniStart, 0, 32_767)) e.forwardUniStart = "network.config.err.forwardUniStart";
  if (!intIn(d.forwardUniCount, 1, 512)) e.forwardUniCount = "network.config.err.forwardUniCount";

  const nameBytes = new TextEncoder().encode(d.sourceName).length;
  // eslint-disable-next-line no-control-regex
  if (nameBytes < 1 || nameBytes > 63 || /[\u0000-\u001f]/.test(d.sourceName)) {
    e.sourceName = "network.config.err.sourceName";
  }

  const h = d.hostname;
  if (h.length < 1 || h.length > 63 || !/^[A-Za-z0-9-]+$/.test(h) || h.startsWith("-") || h.endsWith("-")) {
    e.hostname = "network.config.err.hostname";
  }

  if (!d.dhcp) {
    if (!isIpv4(d.ip)) e.ip = "network.config.err.ipv4";
    else if (d.ip === "0.0.0.0") e.ip = "network.config.err.ipZero";
    if (!isIpv4(d.netmask)) e.netmask = "network.config.err.ipv4";
    if (!isIpv4(d.gateway)) e.gateway = "network.config.err.ipv4";
  }
  return e;
}

/**
 * 计算与原配置相比改动过的字段，组成补丁（固件只更新出现的字段）。
 *
 * # Arguments
 *
 * * `original` - 设备当前配置的草稿形态。
 * * `draft` - 用户编辑后的草稿。
 *
 * # Returns
 *
 * 只含改动字段的补丁；没有改动时为空对象。
 */
export function diffConfig(original: ConfigDraft, draft: ConfigDraft): ConfigPatch {
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(draft) as Array<keyof ConfigDraft>) {
    if (draft[key] !== original[key]) patch[key] = draft[key];
  }
  return patch as ConfigPatch;
}

/**
 * 补丁是否包含需要重启才生效的网络字段。
 *
 * # Arguments
 *
 * * `patch` - 配置补丁。
 */
export function patchNeedsReboot(patch: ConfigPatch): boolean {
  return NET_FIELDS.some((k) => k in patch);
}
