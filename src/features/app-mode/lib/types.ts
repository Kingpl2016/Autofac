/**
 * 应用运行模式相关类型，与 Rust `host_core::app_mode` 的 DTO（camelCase）一一对应。
 */

import type {
  AppModeName,
  ReceiversName,
  SenderName,
} from "@/shared/stores/engineStatusStore";

/** 模式状态快照（`app:mode` 事件与 `app_mode_get` / `app_mode_set` 返回值）。 */
export interface ModeStatus {
  /** 当前模式 */
  mode: AppModeName;
  /** 接收任务状态 */
  receivers: ReceiversName;
  /** 发送器状态 */
  sender: SenderName;
}

/** 后端错误码：录制进行中，不能进入播放器模式。 */
export const MODE_ERR_RECORDING_ACTIVE = "recording_active";
/** 后端错误码：已有模式切换正在进行。 */
export const MODE_ERR_BUSY = "transition_in_progress";
