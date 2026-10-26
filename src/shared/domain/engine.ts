/** 引擎事件与快照的共享类型（对应 Rust runtime / signal-engine DTO）。 */

export type Protocol = "artNet" | "sacn";

/** 某个 Universe 内单个来源的统计。 */
export interface UniverseSource {
  /** 源 IP（未知来源为 `0.0.0.0`）。 */
  ip: string;
  /** 该来源在此 Universe 上的累计包数。 */
  packets: number;
  /** 该来源在此 Universe 上的每秒包数（约 1 秒窗口）。 */
  packetRate: number;
}

export interface UniverseSnapshot {
  universe: number;
  protocol: Protocol | null;
  sourceIps: string[];
  sourceCount: number;
  activeChannels: number;
  conflictChannels: number;
  totalPackets: number;
  /** 此 Universe 每秒包数（约 1 秒窗口）。 */
  packetRate: number;
  /** 各来源统计（按 IP 字符串升序）。 */
  sources: UniverseSource[];
}

export interface EngineStats {
  activeUniverses: number;
  totalPackets: number;
  packetRate: number;
  uptimeSec: number;
  /** 本进程物理内存占用（字节）；无法获取时为 0。 */
  memoryBytes: number;
}

/** 输出总体状态（对应 Rust `OutputState`）。 */
export type OutputState = "idle" | "sending" | "dropping" | "error";

/** 发送套接字状态（对应 Rust `SenderState`）。 */
export type SenderState = "ready" | "reconnecting" | "down";

/** 单个转发目的地的输出统计。 */
export interface DestinationOutput {
  /** 目的地 id（与转发表条目 id 一致）。 */
  id: string;
  /** 累计发出的包数。 */
  sent: number;
  /** 累计发送错误数。 */
  errors: number;
  /** 累计被限速丢弃的帧数。 */
  dropped: number;
  /** 每秒发出包数（约 1 秒窗口）。 */
  sentRate: number;
  /** 最近一次发出距事件生成时刻的毫秒数；从未发出为 null。 */
  lastSendAgoMs: number | null;
}

/** `engine:output` 事件载荷（约 2Hz）。 */
export interface OutputPayload {
  state: OutputState;
  /** 会话累计发出的包数。 */
  sent: number;
  /** 会话累计发送错误数。 */
  sendErrors: number;
  /** 会话累计被限速丢弃的帧数。 */
  dropped: number;
  /** 全部目的地合计的每秒发出包数。 */
  sentRate: number;
  /** 最近一次发送错误的描述。 */
  lastError: string | null;
  /** 最近一次发送错误距事件生成时刻的毫秒数。 */
  lastErrorAgoMs: number | null;
  /** 发送套接字状态。 */
  sender: SenderState;
  /** 各目的地统计。 */
  destinations: DestinationOutput[];
}