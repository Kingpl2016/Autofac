/** 设备发现相关类型：由 Rust `discovery::Device` 等经 ts-rs 生成（`npm run gen:types`）。 */

import type { Device } from "@/bindings/Device";

export type { Device };
export type { DeviceCategory } from "@/bindings/DeviceCategory";
/** 节点上报的单个端口（Rust `artnet_net::artnet::NodePort`）。 */
export type { NodePort } from "@/bindings/NodePort";

/** 设备样式码（Art-Net `Style`）的稳定标识。 */
export type DeviceStyle = NonNullable<Device["style"]>;

/**
 * 设备的展示名：自定义名 > 主机名 > 短名 > IP。
 *
 * @param d 设备。
 * @returns 用于展示与按名称排序的字符串。
 */
export function displayName(d: Pick<Device, "ip" | "customName" | "hostname" | "shortName">): string {
  return d.customName || d.hostname || d.shortName || d.ip;
}
