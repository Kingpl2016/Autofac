/**
 * 信号检测器的类型，与 Rust `signal-gen` / `signal_checker_commands` 的 DTO（camelCase）一一对应。
 */

/** 发送协议。 */
export type SignalProtocol = "artNet" | "sacn";

/** 发送模式：自动（测试图案）/ 手动（逐通道设值）。 */
export type SendMode = "auto" | "manual";

/** 图案分组（界面按分组排布）。 */
export type PatternGroup = "basic" | "wave" | "sweep" | "stress";

/** 全部图案标识，按界面分组顺序排列（与后端 `PatternId::ALL` 一致）。 */
export const PATTERN_IDS = [
  "full-on",
  "blackout",
  "gradient",
  "sine",
  "square",
  "triangle",
  "ramp-up",
  "ramp-down",
  "pulse",
  "chase",
  "rainbow",
  "odd-even",
  "binary",
  "random",
  "strobe",
] as const;

/** 图案标识。 */
export type PatternId = (typeof PATTERN_IDS)[number];

/** 图案元数据。文案由前端按 `id` 本地化。 */
export interface PatternInfo {
  id: PatternId;
  group: PatternGroup;
  /** 静态图案与时间无关，速度控件对它无效 */
  isStatic: boolean;
  /** 会高频明暗闪烁，需要光敏风险提示 */
  isFlashing: boolean;
}

/** 用户填写的发送配置。 */
export interface SignalConfig {
  targetIp: string;
  port: number;
  protocol: SignalProtocol;
  /** Universe 范围记法，如 `0-50` 或 `0-20,30,40-45` */
  universes: string;
}

/** 发送器状态快照（每 200ms 推送一次）。 */
export interface SenderStatus {
  running: boolean;
  mode: SendMode;
  pattern: PatternId;
  speed: number;
  packetsSent: number;
  sendErrors: number;
  /** 实测发送频率（Hz，每秒刷新一次；未运行为 0） */
  measuredHz: number;
  universeCount: number;
  /** 当前生效的 Universe 列表（升序） */
  universes: number[];
  /** 最近一次生效的配置 */
  config: SignalConfig;
  lastError: string | null;
}

/** 配置校验错误（后端 `ConfigError`，按 `code` 区分）。 */
export type ConfigError =
  | { code: "invalidIp"; value: string }
  | { code: "invalidPort" }
  | { code: "emptyRange" }
  | { code: "invalidRange"; fragment: string }
  | { code: "outOfRange"; universe: number; min: number; max: number }
  | { code: "tooMany"; count: number; max: number };

/** 手动数据错误（后端 `ManualError`）。 */
export type ManualError = { code: "channelOutOfRange"; channel: number };

/** 发送器错误（后端 `SenderError`）。 */
export type SenderError = { code: "socket"; message: string };

/** 目标 IP 候选项。 */
export interface TargetOption {
  ip: string;
  /** 网卡名或设备名；本机回环与广播地址没有 */
  name: string | null;
  /** 是否在线（仅设备有意义） */
  online: boolean | null;
}

/** 按来源分组的目标候选项。 */
export interface TargetGroups {
  local: TargetOption[];
  interfaces: TargetOption[];
  devices: TargetOption[];
  broadcasts: TargetOption[];
}

/** 界面做"发送前确认"与"自测提示"所需的运行环境快照（后端 `CheckerContext`）。 */
export interface CheckerContext {
  /** 应用运行模式；播放器模式下实时接收已停止 */
  appMode: "live" | "player";
  /** 单网卡模式下接收所绑定的接口（`0.0.0.0` 表示全部接口） */
  receiveInterface: string;
  /** 多网卡模式下接收分别绑定在各网卡的 IP 上 */
  multiNic: boolean;
  /** 转发表里启用的目的地数量 */
  forwardingEnabled: number;
  /** 本机全部 IPv4 地址（含回环） */
  localIps: string[];
}

/** `signal-checker:error` 事件载荷。 */
export interface SendErrorEvent {
  universe: number | null;
  message: string;
}

/** `signal-checker:preview` 事件载荷。 */
export interface PreviewEvent {
  universe: number;
  data: number[];
}

/** 协议默认端口。 */
export const DEFAULT_PORT: Record<SignalProtocol, number> = {
  artNet: 6454,
  sacn: 5568,
};

/** 一次最多同时发送的 Universe 数（与后端 `MAX_UNIVERSES` 一致）。 */
export const MAX_UNIVERSES = 100;

/** 一个 Universe 的通道数。 */
export const CHANNELS = 512;
