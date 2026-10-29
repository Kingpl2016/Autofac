/**
 * 应用运行模式相关类型：`ModeStatus` 由 Rust `host_core::app_mode` 经 ts-rs 生成（`npm run gen:types`）。
 */

/** 模式状态快照（`app:mode` 事件与 `app_mode_get` / `app_mode_set` 返回值）。 */
export type { ModeStatus } from "@/bindings/ModeStatus";

/** 后端错误码：录制进行中，不能进入播放器模式。 */
export const MODE_ERR_RECORDING_ACTIVE = "recording_active";
/** 后端错误码：已有模式切换正在进行。 */
export const MODE_ERR_BUSY = "transition_in_progress";
