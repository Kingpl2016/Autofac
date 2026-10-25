import type { AppModeName } from "@/shared/stores/engineStatusStore";
import { invoke } from "@/shared/tauri/invoke";

import type { ModeStatus } from "./types";

/** 读取当前应用模式状态。 */
export function appModeGet(): Promise<ModeStatus> {
  return invoke<ModeStatus>("app_mode_get");
}

/**
 * 切换应用模式。
 *
 * 录制进行中不能进入播放器模式（`recording_active`），调用方应先停止录制。
 * 目标等于当前模式时是幂等的；实时模式下若接收曾绑定失败，会再次尝试重建（用于“重试”）。
 *
 * @param mode 目标模式。
 */
export function appModeSet(mode: AppModeName): Promise<ModeStatus> {
  return invoke<ModeStatus>("app_mode_set", { mode });
}

/**
 * 安全退出应用：后端先卸载节目、停止并保存进行中的录制，然后退出进程。
 *
 * 窗口关闭在录制或播放进行中会被拦下（`app:close-requested`），由退出守卫确认后调用本命令。
 */
export function appQuit(): Promise<void> {
  return invoke<void>("app_quit");
}

/**
 * 停止录制并等待文件收尾。
 *
 * 进入播放器模式前，若正在录制，由确认对话框代为调用。结果（文件、错误、丢帧）
 * 由全局的 `recording:finished` 事件监听统一提示，所以这里不关心返回值。
 * 刻意在本特性内直接调用命令，而不是引用录制特性的 API，避免两个特性互相依赖。
 */
export function stopRecordingForModeChange(): Promise<unknown> {
  return invoke<unknown>("recording_stop");
}
