import type { ModeStatus } from "@/features/app-mode/lib/types";
import type { AppSettings } from "@/features/settings/lib/types";
import type { EventBus } from "../lib/eventBus";
import type { StreamHub } from "../lib/streamHub";
import type { DemoData } from "../types";

/** 命令参数：与真实 `invoke` 的参数对象一致。 */
export type CommandArgs = Record<string, unknown>;

/** 命令处理器；出错时以字符串错误码 `throw`，与真实后端 reject 的形态一致。 */
export type CommandHandler = (args: CommandArgs) => unknown;

/** 一个领域模块：一组命令加一个可选的周期驱动。 */
export interface DemoModule {
  commands: Record<string, CommandHandler>;
  /** 每个时钟节拍调用一次。 */
  tick?: (t: TickInfo) => void;
}

/** 时钟节拍信息。 */
export interface TickInfo {
  /** 距上次节拍的毫秒数（已限幅，避免窗口挂起后一次跳很大一步）。 */
  dtMs: number;
  /** 演示开始以来的毫秒数。 */
  elapsedMs: number;
}

/** 日志级别。 */
export type LogLevel = "info" | "warn" | "error";

/** 跨模块共享的演示世界：事件总线、时钟、数据与少量需要互相调用的入口。 */
export interface World {
  bus: EventBus;
  /** 二进制 DMX 通道流：实时与回放模块推送到同一组订阅者。 */
  stream: StreamHub;
  data: DemoData;
  /** 当前应用模式（由 mode 模块维护）。 */
  mode: ModeStatus;
  /** 演示开始以来的毫秒数。 */
  elapsedMs(): number;
  /** 引擎运行时长（毫秒），与设备 `lastSeenMs` 同一时间基准。 */
  uptimeMs(): number;
  /** 追加一条系统日志。 */
  log(level: LogLevel, message: string): void;
  /** 模块间的调用入口，装配时由各模块注册。 */
  hooks: {
    isRecording(): boolean;
    playerLoaded(): boolean;
    closePlayer(): void;
    enterPlayerMode(): void;
    /** 当前设置（由 system 模块维护，保存后立即生效）。 */
    settings(): AppSettings;
    /** 当前生效的录制目录（设置里为空时是默认目录）。 */
    recordingDir(): string;
    /** 录制目录所在卷此刻的剩余字节数（录制中会随写入减少）。 */
    currentDiskFree(): number;
    /** 节目库里的节目被重命名（`to` 为新路径）或删除（`to` 为 `null`）。 */
    programMoved(from: string, to: string | null): void;
  };
}

/**
 * 以字符串错误码中止命令。
 *
 * 真实后端的错误是字符串（如 `already_recording`），前端靠它们区分文案，
 * 所以演示后端也用同样的错误码，而不是 `Error` 对象。
 *
 * # Arguments
 *
 * * `code` - 错误码或错误描述。
 */
export function fail(code: string): never {
  throw code;
}

/**
 * 创建一个按时间间隔触发的闸门：首次调用立即放行，之后每满 `periodMs` 放行一次。
 *
 * # Arguments
 *
 * * `periodMs` - 触发间隔（毫秒）。
 *
 * # Returns
 *
 * 函数：传入当前时间（毫秒），返回本次是否放行，以及自上次放行以来的间隔（秒）。
 */
export function createGate(periodMs: number): (nowMs: number) => { fire: boolean; dtSec: number } {
  let last: number | null = null;
  return (nowMs) => {
    if (last === null) {
      last = nowMs;
      return { fire: true, dtSec: periodMs / 1000 };
    }
    if (nowMs - last >= periodMs) {
      const dtSec = (nowMs - last) / 1000;
      last = nowMs;
      return { fire: true, dtSec };
    }
    return { fire: false, dtSec: 0 };
  };
}

/**
 * 延迟指定毫秒（模拟 IPC 往返与后端耗时）。
 *
 * # Arguments
 *
 * * `ms` - 毫秒数。
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/**
 * 读取命令参数里的字符串。
 *
 * # Arguments
 *
 * * `args` - 命令参数。
 * * `key` - 参数名。
 *
 * # Returns
 *
 * 字符串值；缺失或类型不符时为空串。
 */
export function str(args: CommandArgs, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v : "";
}

/**
 * 读取命令参数里的数字。
 *
 * # Arguments
 *
 * * `args` - 命令参数。
 * * `key` - 参数名。
 *
 * # Returns
 *
 * 数值；缺失或类型不符时为 0。
 */
export function num(args: CommandArgs, key: string): number {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
