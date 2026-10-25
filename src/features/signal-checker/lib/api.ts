import { toast } from "sonner";

import i18n from "@/shared/i18n";
import { invoke } from "@/shared/tauri/invoke";
import type {
  CheckerContext,
  PatternId,
  PatternInfo,
  SendMode,
  SenderStatus,
  SignalConfig,
  TargetGroups,
} from "./types";

/**
 * 打开信号检测器窗口；已打开则还原并聚焦（单例）。
 *
 * # Returns
 *
 * 命令完成的 Promise；失败时已弹出错误提示并 resolve（不向调用方抛出）。
 */
export async function openSignalChecker(): Promise<void> {
  try {
    await invoke<void>("signal_checker_open");
  } catch (e: unknown) {
    const reason = e instanceof Error ? e.message : String(e);
    toast.error(i18n.t("signalChecker.openFailed", { reason }));
  }
}

/** 读取发送器状态快照。 */
export function getStatus(): Promise<SenderStatus> {
  return invoke<SenderStatus>("signal_checker_status");
}

/**
 * 校验一份配置但不应用。
 *
 * # Returns
 *
 * 通过时 resolve 为将要发送的 Universe 数量；不通过时 reject 为 `ConfigError`（普通对象，不是 `Error`）。
 */
export function validateConfig(config: SignalConfig): Promise<number> {
  return invoke<number>("signal_checker_validate", { config });
}

/** 应用配置；发送中调用则下一个 tick 生效。不通过校验时 reject 为 `ConfigError`。 */
export function configure(config: SignalConfig): Promise<void> {
  return invoke<void>("signal_checker_configure", { config });
}

/** 开始发送（已在发送则无操作）。失败时 reject 为 `SenderError`。 */
export function startSending(): Promise<void> {
  return invoke<void>("signal_checker_start");
}

/** 停止发送并等待清零 / 终止包发完。 */
export function stopSending(): Promise<void> {
  return invoke<void>("signal_checker_stop");
}

/** 切换自动 / 手动模式。 */
export function setMode(mode: SendMode): Promise<void> {
  return invoke<void>("signal_checker_set_mode", { mode });
}

/** 选择测试图案。 */
export function setPattern(pattern: PatternId): Promise<void> {
  return invoke<void>("signal_checker_set_pattern", { pattern });
}

/** 设置倍速（后端夹紧到 0.25 到 4）。 */
export function setSpeed(speed: number): Promise<void> {
  return invoke<void>("signal_checker_set_speed", { speed });
}

/** 手动模式：设置单个通道（通道号 1 到 512）。越界时 reject 为 `ManualError`。 */
export function setChannel(universe: number, channel: number, value: number): Promise<void> {
  return invoke<void>("signal_checker_set_channel", { universe, channel, value });
}

/** 手动模式：把某个 Universe 的 512 个通道设为同一个值。 */
export function setAllChannels(universe: number, value: number): Promise<void> {
  return invoke<void>("signal_checker_set_all", { universe, value });
}

/** 手动模式：清除手动数据；传 `null` 清除全部。 */
export function clearManual(universe: number | null): Promise<void> {
  return invoke<void>("signal_checker_clear", { universe });
}

/** 列出全部图案的元数据。 */
export function listPatterns(): Promise<PatternInfo[]> {
  return invoke<PatternInfo[]>("signal_checker_list_patterns");
}

/** 设置要实时预览的 Universe；传 `null` 关闭预览。 */
export function setPreview(universe: number | null): Promise<void> {
  return invoke<void>("signal_checker_set_preview", { universe });
}

/** 读取某个 Universe 当前会发出的 512 通道内容（停止状态下也可用）。 */
export function getFrame(universe: number): Promise<number[]> {
  return invoke<number[]>("signal_checker_frame", { universe });
}

/** 列出目标 IP 候选项（本机、本机网卡、已发现设备、广播地址）。 */
export function getTargets(): Promise<TargetGroups> {
  return invoke<TargetGroups>("signal_checker_targets");
}

/** 读取运行环境快照（应用模式、接收网卡、转发表、本机地址）。 */
export function getContext(): Promise<CheckerContext> {
  return invoke<CheckerContext>("signal_checker_context");
}