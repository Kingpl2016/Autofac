/** 设备发现相关类型（对应 Rust discovery::Device）。 */

export type DeviceCategory =
  | "artNet"
  | "sacn"
  | "cluster"
  | "computer"
  | "network";

export interface Device {
  ip: string;
  hostname: string | null;
  customName: string | null;
  mac: string | null;
  category: DeviceCategory;
  artnetPorts: number | null;
  online: boolean;
  lastSeenMs: number;
}
