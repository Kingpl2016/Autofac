/**
 * 网络设备（ESP32-P4 核心板）相关类型。
 *
 * 数据结构由 Rust `netdev` crate 的 DTO 经 ts-rs 生成（`src/bindings`，运行 `npm run gen:types` 更新），
 * 这里只按前端习惯起别名，并补充前端用到的常量。不要在这里手写与后端对应的结构。
 */

export type { DeviceView as NetDevice } from "@/bindings/DeviceView";
export type { DeviceInput as NetDeviceInput } from "@/bindings/DeviceInput";
export type { SavedDevice } from "@/bindings/SavedDevice";
export type { PlayerBrief } from "@/bindings/PlayerBrief";
export type { DeviceStatus } from "@/bindings/DeviceStatus";
export type { PlayerStatus } from "@/bindings/PlayerStatus";
export type { FileEntry as NetFile } from "@/bindings/FileEntry";
export type { UploadReceipt } from "@/bindings/UploadReceipt";
export type { DeviceConfig } from "@/bindings/DeviceConfig";
export type { ConfigPatch } from "@/bindings/ConfigPatch";
export type { ConfigResult } from "@/bindings/ConfigResult";
export type { TaskDiag } from "@/bindings/TaskDiag";
export type { Diag } from "@/bindings/Diag";
export type { OtaStatus } from "@/bindings/OtaStatus";
export type { OtaReceipt } from "@/bindings/OtaReceipt";
export type { FirmwareInfo } from "@/bindings/FirmwareInfo";
export type { Progress } from "@/bindings/Progress";
export type { ProgramAssign } from "@/bindings/ProgramAssign";

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
