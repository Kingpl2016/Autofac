/** 设备发现相关类型（对应 Rust discovery::Device）。 */

export type DeviceCategory =
  | "artNet"
  | "sacn"
  | "cluster"
  | "computer"
  | "network";

/** 端口方向：输入口把外部 DMX 送上网络，输出口把网络数据输出为 DMX。 */
export type PortDirection = "input" | "output";

/** 设备样式码（Art-Net `Style`）的稳定标识。 */
export type DeviceStyle =
  | "node"
  | "controller"
  | "media"
  | "route"
  | "backup"
  | "config"
  | "visual";

/** 节点上报的单个端口（对应 Rust `artnet_net::artnet::NodePort`）。 */
export interface NodePort {
  /** 端口序号，从 0 起；多 bind 设备跨 bind 唯一。 */
  index: number;
  direction: PortDirection;
  /** 15 位 Port-Address。 */
  universe: number;
  /** 当前是否有数据流。 */
  active: boolean;
}

export interface Device {
  ip: string;
  hostname: string | null;
  customName: string | null;
  mac: string | null;
  category: DeviceCategory;
  artnetPorts: number | null;
  online: boolean;
  lastSeenMs: number;
  /** 以下为 ArtPollReply 扩展字段；旧后端或非 Art-Net 设备可能缺省。 */
  shortName?: string | null;
  nodeReport?: string | null;
  firmware?: string | null;
  manufacturer?: string | null;
  oem?: number | null;
  style?: DeviceStyle | null;
  ports?: NodePort[];
}
