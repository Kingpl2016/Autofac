/**
 * 演示数据文件（`data/*.json`）的结构。
 *
 * JSON 导入后类型会被放宽（字面量变成 `string`），所以各数据文件在 `data/index.ts`
 * 里集中断言为这里的类型，引擎其余部分只依赖这些类型。
 */

import type { Device } from "@/shared/domain/device";
import type { Protocol } from "@/shared/domain/engine";
import type { ForwardingTable } from "@/features/forwarding/lib/types";
import type { NetworkInterface, AppSettings } from "@/features/settings/lib/types";
import type { AppInfo } from "@/features/about/lib/api";
import type { DeviceConfig } from "@/features/network/lib/types";
import type { PatternSpec, UniverseProgram } from "./lib/patterns";

/** `app.json`：应用信息、录制目录、磁盘与目录检查。 */
export interface AppSeed {
  info: AppInfo;
  recordingDir: string;
  disk: { freeBytes: number };
  /** 已知路径的目录检查结果；键为路径 */
  dirChecks: Record<string, DirCheckSeed>;
  /** 其它路径的默认检查结果 */
  unknownDirCheck: DirCheckSeed;
  /** 启动时“恢复出”的孤立录制 */
  recovered: RecoveredSeed[];
}

/** 一个目录的检查结果。 */
export interface DirCheckSeed {
  exists: boolean;
  isDir: boolean;
  writable: boolean;
  freeBytes: number;
}

/** 启动恢复结果的种子。 */
export type RecoveredSeed =
  | { kind: "recovered"; fileName: string; frames: number; durationSec: number }
  | { kind: "failed"; part: string; reason: string };

/** `update.json`：模拟的新版本。 */
export interface UpdateSeed {
  currentVersion: string;
  version: string;
  date: string;
  body: string;
  totalBytes: number;
  /** 模拟“检查更新”的耗时 */
  checkDelayMs: number;
  /** 模拟下载的总耗时 */
  downloadSeconds: number;
}

/** 设备种子：在 `Device` 基础上去掉运行时字段，并带上模拟行为。 */
export type DeviceSeed = Omit<Device, "lastSeenMs" | "online"> & {
  online: boolean;
  /** 离线设备：距引擎基准时刻多久前最后活动 */
  lastSeenAgoSec?: number;
  /** 第 N 次网络扫描时才被发现（1 起）；不填则一开始就已发现 */
  discoverOnScan?: number;
  /** 周期性掉线：每个周期前 70% 在线、后 30% 离线 */
  flapPeriodSec?: number;
};

/** 实时 Universe 的一个来源。 */
export interface LiveSourceSeed {
  ip: string;
  rateHz: number;
}

/** 实时 Universe 种子。 */
export interface LiveUniverseSeed {
  universe: number;
  protocol: Protocol;
  sources: LiveSourceSeed[];
  /** 多来源时的冲突通道数；省略为 0 */
  conflictChannels?: number;
  program: PatternSpec;
}

/** `live.json`：实时信号场景。 */
export interface LiveSeed {
  /** 演示开始时引擎已运行的秒数 */
  baseUptimeSec: number;
  memoryBytes: number;
  universes: LiveUniverseSeed[];
}

/** 输出故障注入。 */
export interface OutputFaultSeed {
  destinationId: string;
  errorsPerSec: number;
  error: string;
  dropBurstEverySec: number;
  dropBurstLenSec: number;
  dropPerSec: number;
}

/** `output.json`。 */
export interface OutputSeed {
  faults: OutputFaultSeed[];
}

/** 一个预置节目。 */
export interface ProgramSeed {
  name: string;
  fileName: string;
  notes: string;
  /** 距演示开始多少分钟前录制 */
  ageMinutes: number;
  durationSec: number;
  rateHz: number;
  sources: string[];
  recovered?: boolean;
  /** 省略为 true；false 表示文件头损坏 */
  valid?: boolean;
  corruptFrames?: number;
  universes: UniverseProgram[];
}

/** `recordings.json`。 */
export interface RecordingsSeed {
  programs: ProgramSeed[];
}

/** 设备 SD 卡上的一个预置节目文件。 */
export interface NetdevFileSeed {
  name: string;
  size: number;
  /** 已分配的节目号；null 表示尚未分配 */
  program: number | null;
  durationMs: number;
}

/** 网络上存在的一台设备（核心板）。 */
export interface NetdevMachineSeed {
  host: string;
  /** 设备上配置的 HTTP Token；null 表示未配置（此时固件拒绝一切写操作） */
  token: string | null;
  /** 是否可达；false 时所有请求超时 */
  reachable: boolean;
  version: string;
  hostname: string;
  workMode: number;
  viaDhcp: boolean;
  sdTotal: number;
  sdFree: number;
  files: NetdevFileSeed[];
}

/** 应用里已保存的设备（含系统凭据里存的 Token）。 */
export interface NetdevSavedSeed {
  id: string;
  name: string;
  host: string;
  port: number;
  localToken: string | null;
}

/** `netdev.json`。 */
export interface NetdevSeed {
  /** 模拟一次 HTTP 往返的耗时（毫秒） */
  latencyMs: number;
  /** 模拟一次文件传输的总耗时（毫秒） */
  transferMs: number;
  /** 模拟设备重启不可达的时长（毫秒） */
  rebootMs: number;
  saved: NetdevSavedSeed[];
  machines: NetdevMachineSeed[];
  /** 所有设备共用的初始配置 */
  config: DeviceConfig;
  logs: string[];
  ota: { running: string; compileTime: string; rollbackEnabled: boolean };
}

/** 一条历史日志。 */
export interface LogHistorySeed {
  agoSec: number;
  level: "info" | "warn" | "error";
  message: string;
}

/** 周期性日志模板。 */
export interface LogPeriodicSeed {
  everySec: number;
  level: "info" | "warn" | "error";
  message: string;
}

/** `logs.json`。 */
export interface LogsSeed {
  history: LogHistorySeed[];
  periodic: LogPeriodicSeed[];
}

/** 全部演示数据。 */
export interface DemoData {
  app: AppSeed;
  settings: AppSettings;
  network: NetworkInterface[];
  update: UpdateSeed;
  devices: DeviceSeed[];
  live: LiveSeed;
  forwarding: ForwardingTable;
  output: OutputSeed;
  recordings: RecordingsSeed;
  netdev: NetdevSeed;
  logs: LogsSeed;
}
