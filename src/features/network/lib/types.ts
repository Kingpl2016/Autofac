/** 网络设备（ESP32-P4 核心板）相关类型，与 Rust `netdev` crate 的 DTO 一一对应（camelCase）。 */

/** 已保存的设备（含是否保存了 Token，Token 本身不会到前端）。 */
export interface NetDevice {
  id: string;
  name: string;
  host: string;
  port: number;
  hasToken: boolean;
}

/** 新增 / 更新设备的输入；带 `id` 表示更新。 */
export interface NetDeviceInput {
  id?: string;
  name: string;
  host: string;
  port: number;
}

/** 播放摘要（状态接口内嵌）。 */
export interface PlayerBrief {
  /** 0 空闲 / 1 已停止 / 2 播放中 / 3 暂停 */
  state: number;
  programNo: number;
  posMs: number;
  durMs: number;
}

/** 设备状态。 */
export interface DeviceStatus {
  version: string;
  /** 工作模式 0~5 */
  workMode: number;
  ip: string;
  netmask: string;
  gateway: string;
  viaDhcp: boolean;
  linkUp: boolean;
  sdMounted: boolean;
  sdTotal: number | null;
  sdFree: number | null;
  player: PlayerBrief;
}

/** 播放器详细状态。 */
export interface PlayerStatus {
  state: number;
  programNo: number;
  /** 0 关闭 / 1 循环 / 2 连播 */
  repeat: number;
  /** 倍速 ×100，25~200 */
  speedX100: number;
  posMs: number;
  durMs: number;
  universes: number;
  frames: number;
  badFrames: number;
}

/** 设备 SD 卡上的文件。 */
export interface NetFile {
  name: string;
  size: number;
  isDir: boolean;
  /** 已分配的节目号 */
  program: number | null;
}

/** 文件上传回执。 */
export interface UploadReceipt {
  name: string;
  size: number;
  program: number | null;
}

/** 设备配置。 */
export interface DeviceConfig {
  artnetEnabled: boolean;
  sacnEnabled: boolean;
  targetMode: number;
  sacnMulticast: number;
  sacnPriority: number;
  stopBehavior: number;
  keepaliveMs: number;
  sourceName: string;
  uartOutputEnabled: boolean;
  netOutputEnabled: boolean;
  forwardUniStart: number;
  forwardUniCount: number;
  forwardSacn: boolean;
  dhcp: boolean;
  ip: string;
  netmask: string;
  gateway: string;
  hostname: string;
  tokenSet: boolean;
}

/** 配置补丁：只含改动字段；`httpToken` 只写（空串清除）。 */
export type ConfigPatch = Partial<Omit<DeviceConfig, "tokenSet">> & { httpToken?: string };

/** 配置写入结果。 */
export interface ConfigResult {
  ok: boolean;
  netRebootRequired: boolean;
}

/** 堆诊断。 */
export interface HeapDiag {
  free: number;
  minFree: number;
  largestBlock: number;
  psramFree: number;
}

/** 任务诊断。 */
export interface TaskDiag {
  name: string;
  prio: number;
  /** 栈历史最小剩余字节，越小越危险 */
  stackMin: number;
  core: number | null;
  runtime: number;
  cpuPermille: number | null;
}

/** 运行期诊断。 */
export interface Diag {
  heap: HeapDiag;
  tasks: TaskDiag[];
  dmxUart: { ports: number; txTimeouts: number } | null;
  player: { state: number; badFrames: number };
}

/** OTA 状态。 */
export interface OtaStatus {
  running: string;
  version: string;
  compileTime: string;
  pendingVerify: boolean;
  rollbackEnabled: boolean;
}

/** OTA 上传回执。 */
export interface OtaReceipt {
  newVersion: string;
  rebooting: boolean;
}

/** 固件预检结果。 */
export interface FirmwareInfo {
  fileName: string;
  size: number;
  version: string;
  projectName: string;
  buildTime: string;
  buildDate: string;
  idfVersion: string;
}

/** 传输进度。 */
export interface Progress {
  done: number;
  total: number;
  speedBps: number;
}

/** 工作模式编号。 */
export const WORK_MODES = [0, 1, 2, 3, 4, 5] as const;

/** 倍速档位（×100）。 */
export const SPEED_STEPS = [25, 50, 75, 100, 125, 150, 200] as const;

/** 允许播放的工作模式（固件限制：自动与节目）。 */
export const PLAYABLE_MODES: readonly number[] = [0, 4];

/** 节目操作码。 */
export const ProgramAction = {
  Stop: 0,
  Pause: 1,
  PlayOnce: 2,
  PlayLoop: 3,
  Delete: 4,
} as const;

/** 播放器状态码。 */
export const PlayState = {
  Idle: 0,
  Stopped: 1,
  Playing: 2,
  Paused: 3,
} as const;
