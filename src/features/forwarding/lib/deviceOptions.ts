import { displayName, type Device } from "@/shared/domain/device";
import { compareIp } from "@/shared/lib/ip";
import type { ForwardDestination, ForwardProtocol } from "./types";

/** 目标设备下拉里的分组。 */
export type DeviceGroupId = "artNet" | "sacn" | "other";

/** 一个分组及其设备。 */
export interface DeviceGroup {
  id: DeviceGroupId;
  devices: Device[];
}

/** Art-Net 默认端口。 */
export const ARTNET_PORT = 6454;
/** sACN 默认端口。 */
export const SACN_PORT = 5568;

/**
 * 协议对应的默认端口。
 *
 * @param protocol 转发协议。
 * @returns Art-Net 为 6454，sACN 为 5568。
 */
export function defaultPort(protocol: ForwardProtocol): number {
  return protocol === "sacn" ? SACN_PORT : ARTNET_PORT;
}

function groupOf(d: Device): DeviceGroupId {
  if (d.category === "artNet") return "artNet";
  if (d.category === "sacn") return "sacn";
  return "other";
}

/**
 * 把在线设备按类别分组，供“目标 IP”下拉使用。
 *
 * 只收录在线设备；sACN 关闭时不收录 sACN 设备（它们无法作为目的地）；
 * 空分组不返回；组内先按显示名、再按 IP 自然排序。
 *
 * @param devices 已发现的设备。
 * @param opts.sacnEnabled sACN 总开关。
 * @returns 非空的分组，顺序固定为 Art-Net、sACN、其他。
 */
export function groupOnlineDevices(
  devices: readonly Device[],
  opts: { sacnEnabled: boolean },
): DeviceGroup[] {
  const buckets: Record<DeviceGroupId, Device[]> = { artNet: [], sacn: [], other: [] };
  for (const d of devices) {
    if (!d.online) continue;
    const g = groupOf(d);
    if (g === "sacn" && !opts.sacnEnabled) continue;
    buckets[g].push(d);
  }
  const order: DeviceGroupId[] = ["artNet", "sacn", "other"];
  return order
    .map((id) => ({
      id,
      devices: buckets[id].sort(
        (a, b) => displayName(a).localeCompare(displayName(b)) || compareIp(a.ip, b.ip),
      ),
    }))
    .filter((g) => g.devices.length > 0);
}

/**
 * 切换协议，并让端口跟随新协议的默认值；用户改过端口（不是旧协议的默认端口）时保持不变。
 *
 * @param d 当前草稿。
 * @param protocol 新协议。
 * @returns 新草稿，不修改入参。
 */
export function applyProtocol(d: ForwardDestination, protocol: ForwardProtocol): ForwardDestination {
  if (protocol === d.protocol) return d;
  const port = d.port === defaultPort(d.protocol) ? defaultPort(protocol) : d.port;
  return { ...d, protocol, port };
}

/**
 * 选中一台设备作为目标：填入 IP，名称为空时用设备名，并按设备类别对齐协议与默认端口。
 *
 * @param d 当前草稿。
 * @param device 选中的设备。
 * @param sacnEnabled sACN 总开关；关闭时不会切到 sACN。
 * @returns 新草稿，不修改入参。
 */
export function applyDeviceSelection(
  d: ForwardDestination,
  device: Device,
  sacnEnabled: boolean,
): ForwardDestination {
  let next: ForwardDestination = { ...d, targetIp: device.ip };
  if (!next.name.trim()) next = { ...next, name: displayName(device) };
  if (device.category === "artNet") next = applyProtocol(next, "artNet");
  else if (device.category === "sacn" && sacnEnabled) next = applyProtocol(next, "sacn");
  return next;
}