import type { Device } from "@/shared/domain/device";

/** 表格“Art-Net 信息”列要展示的摘要。 */
export interface ArtnetInfo {
  /** 设备上报的不同 Universe 数；没有端口信息时为 `null`。 */
  universes: number | null;
  /** 固件版本；未上报为 `null`。 */
  firmware: string | null;
  /** 是否为集群（HA）对端；此时其它字段无意义。 */
  haPeer: boolean;
}

/**
 * 提取设备的 Art-Net 信息摘要。
 *
 * 只有 Art-Net 节点和集群对端有这一列；sACN、计算机、其它设备返回 `null`（界面显示占位符）。
 * Universe 数按端口上报的 Port-Address 去重计数，同一个 Universe 同时有输入输出口只算一个。
 *
 * @param d 设备。
 * @returns 摘要；不适用时返回 `null`。
 */
export function artnetInfo(d: Device): ArtnetInfo | null {
  if (d.category === "cluster") return { universes: null, firmware: null, haPeer: true };
  if (d.category !== "artNet") return null;
  const unis = new Set((d.ports ?? []).map((p) => p.universe));
  return {
    universes: unis.size > 0 ? unis.size : null,
    firmware: d.firmware?.trim() || null,
    haPeer: false,
  };
}