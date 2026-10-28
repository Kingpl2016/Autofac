import { invoke } from "@/shared/tauri/invoke";

/** 开发者工具的状态（与后端 `DevtoolsState` 一致）。 */
export interface DevtoolsState {
  /** 当前构建是否支持（只有开发构建支持） */
  available: boolean;
  /** 主窗口的开发者工具是否已打开 */
  open: boolean;
}

/**
 * 读取主窗口开发者工具的状态。
 *
 * @returns 状态。
 */
export function devtoolsState(): Promise<DevtoolsState> {
  return invoke<DevtoolsState>("devtools_state");
}

/**
 * 打开 / 关闭主窗口的开发者工具。
 *
 * @param open 是否打开。
 * @returns 操作后的状态。
 * @throws 发布构建返回错误码 `unsupported`。
 */
export function devtoolsSet(open: boolean): Promise<DevtoolsState> {
  return invoke<DevtoolsState>("devtools_set", { open });
}
